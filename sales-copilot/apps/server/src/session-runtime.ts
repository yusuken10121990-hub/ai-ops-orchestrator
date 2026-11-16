import { randomUUID } from 'node:crypto';
import {
  AudioFrameError,
  decodeAudioFrame,
  type AdviceCard,
  type AdviceInvalidationReason,
  type ApprovedFact,
  type CaptureSource,
  type ClientMessage,
  type ErrorCode,
  type PipelineState,
  type PipelineStatus,
  type ServerMessage,
  type SessionMode,
  type SessionStartMessage,
  type StatusReason,
  type StoragePolicy,
  type WarningCode,
} from '@sales-copilot/contracts';
import {
  AdviceScheduler,
  ConversationState,
  PinController,
  SessionLifecycle,
  TranscriptStore,
  UsageMeter,
  type AdviceJob,
  type ConversationUtterance,
  type IdGenerator,
  type SchedulerEvent,
  type Utterance,
} from '@sales-copilot/domain';
import {
  FakeSpeechRecognizer,
  type AdviceLlm,
  type NormalizedSttResult,
  type RecognizerEvent,
  type RecognizerErrorKind,
  type SpeechRecognizer,
} from '@sales-copilot/providers';
import type { Logger } from 'pino';
import type { AdviceEngineLike, AdviceResultLike, CoachingPort } from './coaching-port';
import type { ServerConfig } from './config';
import { writeSessionExport, type SessionExport } from './export';
import { LatencyTracker, type LatencyStats } from './latency';
import { ReplayDriver, type ReplayScript } from './replay';
import type { Store } from './store';

export const SERVER_VERSION = '0.1.0';

export interface SessionRuntimeDeps {
  config: ServerConfig;
  logger: Logger;
  store: Store;
  coaching: CoachingPort;
  /** LIVE 用の認識器（未設定なら null を返す）。 */
  createLiveRecognizer: (source: CaptureSource) => SpeechRecognizer | null;
  /** 実 LLM（Anthropic）。未設定なら null。 */
  liveLlm: AdviceLlm | null;
  loadReplay: (name: string | null) => ReplayScript;
  send: (m: ServerMessage) => void;
  now?: () => number;
  /** セッション終了（振り返りの保持登録用）。 */
  onEnded?: (review: SessionReview) => void;
}

export interface SessionReview {
  sessionId: string;
  endedAt: number;
  retainedUntil: number;
  exportPath: string | null;
  mode: SessionMode;
  latency: LatencyStats;
  usage: ReturnType<UsageMeter['snapshot']>;
  /** 保持期間内だけ見られる本文（期限で消える）。 */
  data: SessionExport | null;
  clear: () => void;
}

type Pipe = 'SELF' | 'REMOTE' | 'stt' | 'advice';

const RECOVERABLE_LLM: ReadonlySet<string> = new Set(['rate_limited', 'timeout', 'network', 'invalid_json', 'unknown']);

/**
 * 1つの WS 接続に属する商談セッションのパイプライン。
 * 音声 → STT → 文字起こし統合 → 会話状態 → スケジューラー → 助言生成 → 検証済みカード送信。
 * 一時停止・終了では STT 接続・生成要求・タイマー・待機キューを止め、以後外部へ何も送らない。
 */
export class SessionRuntime {
  private readonly now: () => number;
  private readonly log: Logger;
  private sessionId: string | null = null;
  private lifecycle: SessionLifecycle | null = null;
  private transcript: TranscriptStore | null = null;
  private conversation: ConversationState | null = null;
  private scheduler: AdviceScheduler | null = null;
  private usage: UsageMeter | null = null;
  private readonly pin = new PinController();
  private latency = new LatencyTracker();
  private engine: AdviceEngineLike | null = null;
  private llmExternal = false;
  private adviceLabel: string | null = null;
  private mode: SessionMode | null = null;
  private storage: StoragePolicy = 'memory_only';
  private purpose = '';
  private customerName: string | null = null;
  private facts: ApprovedFact[] = [];
  private readonly recognizers = new Map<CaptureSource, SpeechRecognizer>();
  private readonly recognizerUnsubs = new Map<CaptureSource, () => void>();
  private replay: ReplayDriver | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inflight = new Map<string, AdviceJob>();
  private readonly cards = new Map<string, AdviceCard>();
  private readonly deferredJobs = new Map<string, string>();
  private readonly evaluated = new Set<string>();
  private readonly lastUtteranceBySource = new Map<CaptureSource, string>();
  private readonly audioGaps: SessionExport['audioGaps'] = [];
  private lastDropWarnAt = 0;
  private budgetWarned = false;
  private llmDisabledReason: StatusReason | null = null;
  private llmBackoffUntil = 0;
  private startedAt = 0;
  private ended = false;
  private readonly pipes: Record<Pipe, PipelineStatus>;
  /** 統計: 停止後に外部へ送ろうとした回数（常に0であるべき）。 */
  readonly guard = { audioAfterStop: 0, llmAfterStop: 0 };

  constructor(private readonly d: SessionRuntimeDeps) {
    this.now = d.now ?? (() => Date.now());
    this.log = d.logger;
    const t = this.now();
    const idle = (): PipelineStatus => ({ state: 'idle', reason: null, since: t });
    this.pipes = { SELF: idle(), REMOTE: idle(), stt: idle(), advice: idle() };
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get isActive(): boolean {
    return this.lifecycle?.state === 'capturing';
  }

  get hasSession(): boolean {
    return this.sessionId !== null && !this.ended;
  }

  /** 遅延統計（テスト・振り返り用）。 */
  latencyStats(): LatencyStats {
    return this.latency.stats();
  }

  // -------------------------------------------------------------------------
  // 入力
  // -------------------------------------------------------------------------

  handleMessage(msg: ClientMessage): void {
    switch (msg.type) {
      case 'hello':
        return this.error('protocol_error', 'hello already received', true);
      case 'session.start':
        return this.start(msg);
      case 'session.end':
        void this.end(msg.exportRequested);
        return;
      case 'analysis.pause':
        void this.pause();
        return;
      case 'analysis.resume':
        return this.resume();
      case 'advice.request':
        return this.manual(msg.kind, msg.requestId);
      case 'card.pin':
        return this.pinCard(msg.adviceId);
      case 'card.unpin':
        return this.unpinCard(msg.adviceId);
      case 'feedback':
        return this.feedback(msg.adviceId, msg.rating);
      case 'speaking.state':
        if (!this.requireSession()) return;
        // OFFLINE は再生スクリプトが会話なので、実マイクの発話状態でカード更新を保留しない（LIVE のみ反映）
        if (msg.source === 'SELF' && this.mode === 'LIVE') this.process(this.scheduler!.setSelfSpeaking(msg.speaking));
        return;
      case 'source.state':
        return this.sourceState(msg);
      case 'advice.displayed':
        // 表示報告はサーバーの受信時刻で計測する（クライアント時計 msg.at は混ぜない）
        if (this.sessionId && !this.ended) this.latency.displayed(msg.adviceId, this.now());
        return;
      case 'audio.gap':
        return this.clientGap(msg);
    }
  }

  /** 拡張側で破棄した音声区間（SPEC §6-3）。記録して状態を「遅延」にする。再送は求めない。 */
  private clientGap(msg: Extract<ClientMessage, { type: 'audio.gap' }>): void {
    if (!this.requireSession()) return;
    this.audioGaps.push({
      source: msg.source,
      fromMs: msg.fromMs,
      toMs: msg.toMs,
      droppedMs: msg.toMs - msg.fromMs,
      origin: 'client',
      reason: msg.reason,
    });
    if (this.audioGaps.length > 500) this.audioGaps.shift();
    this.log.info({ sessionId: this.sessionId, source: msg.source, droppedMs: Math.round(msg.toMs - msg.fromMs), reason: msg.reason }, 'client audio gap');
    if (this.isActive && this.pipes[msg.source].state !== 'idle') {
      this.setPipe(msg.source, 'delayed', 'backpressure_drop');
      this.sendStatus();
    }
  }

  handleAudio(data: Buffer | ArrayBuffer | Uint8Array): void {
    if (!this.lifecycle || this.ended || this.lifecycle.state !== 'capturing') {
      if (this.ended || this.lifecycle?.state === 'paused') this.guard.audioAfterStop++;
      return; // 停止・一時停止中の音声は受け取らない（外部へ送らない）
    }
    let frame;
    try {
      const view = data instanceof ArrayBuffer ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      frame = decodeAudioFrame(view);
    } catch (e) {
      const code = e instanceof AudioFrameError ? e.code : 'unknown';
      this.log.debug({ code }, 'audio frame rejected');
      return this.error('invalid_message', `invalid audio frame (${code})`, true);
    }
    const h = frame.header;
    if (h.source === 'UNKNOWN') return;
    const acc = this.lifecycle.acceptAudioFrame(h);
    if (!acc.ok) return;
    const source = h.source;
    const now = this.now();
    this.latency.audioArrived(source, h.audioStartMs + h.durationMs, now);
    this.setPipe(source, 'active', null);
    if (this.mode === 'OFFLINE') return; // OFFLINE は再生スクリプトが STT の代わり
    if (!this.lifecycle.canForwardToStt(source)) return;
    if (!this.usage!.canStartExternalCall('stt')) {
      this.setPipe('stt', 'error', 'budget_exceeded');
      this.stopRecognizers();
      return;
    }
    const rec = this.getRecognizer(source);
    if (!rec) return;
    rec.sendAudio(frame.pcm, {
      frameGeneration: h.streamGeneration,
      sequence: h.sequence,
      audioStartMs: h.audioStartMs,
      durationMs: h.durationMs,
    });
  }

  /** WS 切断（ウィンドウを閉じた等）: 見えない状態で取得を続けないため終了する。 */
  async onDisconnect(): Promise<void> {
    if (this.hasSession) await this.end(false);
  }

  /** 承認済み条件が変更・失効した（設定画面）。この商談の該当カードを無効化する。 */
  onFactChanged(factId: string): void {
    if (!this.hasSession) return;
    const before = this.facts.length;
    this.facts = this.facts.filter((f) => f.factId !== factId);
    if (this.facts.length === before) return;
    for (const card of this.cards.values()) {
      if (card.status !== 'invalidated' && card.approvedFactIds.includes(factId)) {
        this.process(this.scheduler!.invalidate(card.adviceId), { invalidationReason: 'fact_revoked' });
      }
    }
  }

  // -------------------------------------------------------------------------
  // セッション制御
  // -------------------------------------------------------------------------

  private start(msg: SessionStartMessage): void {
    if (this.sessionId && !this.ended) return this.error('invalid_state', 'session already started', true);
    if (this.ended) return this.error('invalid_state', 'session ended; open a new connection to start again', false);
    if (msg.mode === 'LIVE' && (msg.offlineScriptId !== undefined || msg.offlineUseAnthropic !== undefined)) {
      return this.error('invalid_message', 'offlineScriptId / offlineUseAnthropic are only valid in OFFLINE mode', true);
    }
    let script: ReplayScript | null = null;
    if (msg.mode === 'OFFLINE') {
      try {
        script = this.d.loadReplay(msg.offlineScriptId ?? this.d.config.offline.script);
      } catch (e) {
        this.log.warn({ err: e }, 'replay load failed');
        return this.error('invalid_message', 'OFFLINE replay script not found', true);
      }
    }
    const sessionId = `ses_${randomUUID()}`;
    const resolved = this.d.store.resolveAppliedFacts(sessionId, msg.appliedFacts);
    if (!resolved.ok) {
      return this.error('invalid_message', `applied fact ${resolved.factId} is ${resolved.error}`, true);
    }
    const cfg = this.d.config;
    const lifecycle = new SessionLifecycle(sessionId);
    const c = lifecycle.consent({ consentConfirmed: msg.consentConfirmed, mode: msg.mode, selfCaptureEnabled: msg.selfCaptureEnabled });
    if (!c.ok) return this.error('invalid_state', `consent rejected (${c.reason})`, true);
    lifecycle.startCapture();

    this.sessionId = sessionId;
    this.lifecycle = lifecycle;
    this.mode = msg.mode;
    this.storage = msg.storage;
    this.purpose = msg.purpose;
    this.customerName = msg.customerName ?? null;
    this.facts = resolved.facts;
    this.startedAt = this.now();
    const short = sessionId.slice(4, 12);
    const ids: IdGenerator = (() => {
      const n = new Map<string, number>();
      return (p: string) => {
        const k = (n.get(p) ?? 0) + 1;
        n.set(p, k);
        return `${p}_${short}_${k}`;
      };
    })();
    const clock = { now: this.now };
    this.transcript = new TranscriptStore({ idGenerator: ids });
    this.conversation = new ConversationState({ windowMs: cfg.conversationWindowMs, clock, idGenerator: ids });
    this.usage = new UsageMeter(cfg.priceTable, cfg.budget);
    this.latency = new LatencyTracker();

    // 助言エンジンの選択（LIVE は実 LLM のみ。OFFLINE は opt-in 時だけ実 LLM、それ以外はルールベースと明示）
    const llm = this.selectLlm(msg.mode, msg.offlineUseAnthropic === true);
    this.engine = llm ? this.d.coaching.createEngine(llm, { maxRetries: cfg.advice.maxRetries, timeoutMs: cfg.advice.timeoutMs }) : null;
    this.scheduler = new AdviceScheduler({
      sessionId,
      promptVersion: this.engine?.promptVersion ?? 'unconfigured',
      clock,
      idGenerator: ids,
      cooldownMs: cfg.advice.cooldownMs,
      staleMs: cfg.advice.staleMs,
      manualMinIntervalMs: cfg.advice.manualMinIntervalMs,
      canStart: () => this.canStartLlm(),
    });
    lifecycle.onTransition((_from, to) => {
      if (to === 'paused' || to === 'ended') this.log.info({ sessionId, to }, 'session lifecycle');
    });

    if (!this.engine) this.setPipe('advice', 'not_configured', 'not_configured');
    else this.setPipe('advice', 'waiting', msg.mode === 'OFFLINE' && !this.llmExternal ? 'offline_mode' : 'listening');

    if (msg.mode === 'LIVE') {
      if (!cfg.deepgram.apiKey) {
        this.setPipe('stt', 'not_configured', 'not_configured');
      } else {
        this.setPipe('stt', 'waiting', null);
      }
      if (!msg.selfCaptureEnabled) this.setPipe('SELF', 'idle', 'self_capture_off');
    } else {
      this.setPipe('stt', 'offline', 'offline_mode');
      this.setPipe('SELF', 'offline', 'offline_mode');
      this.setPipe('REMOTE', 'offline', 'offline_mode');
    }

    this.log.info(
      {
        sessionId,
        mode: msg.mode,
        appliedFacts: resolved.facts.length,
        advice: this.adviceLabel ?? 'not_configured',
        stt: this.pipes.stt.state,
        offlineScript: script?.name ?? null,
      },
      'session started',
    );
    this.sendStatus();
    if (msg.mode === 'LIVE' && !cfg.deepgram.apiKey) {
      this.error('not_configured', 'STT (Deepgram) is not configured: set DEEPGRAM_API_KEY', false);
    }
    if (msg.mode === 'LIVE' && !this.engine) {
      this.error('not_configured', 'advice LLM (Anthropic) is not configured: set ANTHROPIC_API_KEY', false);
    }

    this.tickTimer = setInterval(() => this.tick(), 250);
    this.usageTimer = setInterval(() => this.sendUsage(), Math.max(500, cfg.usageIntervalMs));
    if (script) this.startReplay(script);
  }

  /**
   * OFFLINE で実 LLM を使うのは「本人が開始時に希望」かつ「環境変数で許可」かつ「キーあり」の全てを満たすときだけ。
   */
  private selectLlm(mode: SessionMode, offlineAnthropicRequested: boolean): AdviceLlm | null {
    const live = this.d.liveLlm;
    if (mode === 'LIVE') {
      if (!live) return null;
      this.llmExternal = true;
      this.adviceLabel = `anthropic:${this.d.config.anthropic.model}`;
      return live;
    }
    if (offlineAnthropicRequested && this.d.config.offline.useAnthropic && live) {
      this.llmExternal = true;
      this.adviceLabel = `anthropic:${this.d.config.anthropic.model} (OFFLINE opt-in)`;
      return live;
    }
    this.llmExternal = false;
    this.adviceLabel = 'rule_based_offline（ルールベースの試験用・AIではありません）';
    return this.d.coaching.createOfflineLlm();
  }

  private async pause(): Promise<void> {
    if (!this.requireSession()) return;
    const r = this.lifecycle!.pause();
    if (!r.ok) return this.error('invalid_state', `cannot pause (${r.reason})`, true);
    this.haltExternal();
    this.setPipe('advice', 'paused', 'user_paused');
    this.setPipe('stt', 'paused', 'user_paused');
    this.sendStatus();
  }

  private resume(): void {
    if (!this.requireSession()) return;
    const r = this.lifecycle!.resume();
    if (!r.ok) return this.error('invalid_state', `cannot resume (${r.reason})`, true);
    this.scheduler!.resume();
    this.setPipe('advice', this.engine ? 'waiting' : 'not_configured', this.engine ? 'listening' : 'not_configured');
    if (this.mode === 'OFFLINE') {
      this.setPipe('stt', 'offline', 'offline_mode');
      for (const src of ['SELF', 'REMOTE'] as const) (this.getRecognizer(src) as FakeSpeechRecognizer | null)?.open();
      this.replay?.resume();
    } else {
      this.setPipe('stt', this.d.config.deepgram.apiKey ? 'waiting' : 'not_configured', this.d.config.deepgram.apiKey ? null : 'not_configured');
    }
    this.tickTimer ??= setInterval(() => this.tick(), 250);
    this.sendStatus();
  }

  async end(exportRequested: boolean): Promise<void> {
    if (!this.lifecycle || this.ended) return;
    this.lifecycle.end();
    this.ended = true;
    this.haltExternal();
    this.replay?.stop();
    this.replay = null;
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = null;
    const endedAt = this.now();
    for (const k of Object.keys(this.pipes) as Pipe[]) this.setPipe(k, 'idle', 'session_ended');

    const data = this.buildExport(endedAt);
    let exportPath: string | null = null;
    if (exportRequested) {
      try {
        exportPath = writeSessionExport(this.d.config.exportDir, data).jsonPath;
      } catch (e) {
        this.log.warn({ sessionId: this.sessionId, err: e }, 'export failed');
        this.error('internal_error', 'export failed', false);
      }
    }
    const usage = this.usage!.snapshot();
    this.sendStatus();
    this.d.send({ type: 'usage', ...usage });
    this.log.info(
      {
        sessionId: this.sessionId,
        exported: exportPath !== null,
        cards: this.cards.size,
        latency: this.latency.stats().counts,
        guard: this.guard,
      },
      'session ended',
    );
    const retainedUntil = endedAt + this.d.config.retentionMs;
    const clear = () => {
      this.transcript?.clear();
      this.conversation?.clear();
      this.cards.clear();
      this.pin.clear();
    };
    this.d.onEnded?.({
      sessionId: this.sessionId!,
      endedAt,
      retainedUntil,
      exportPath,
      mode: this.mode!,
      latency: this.latency.stats(),
      usage,
      data: this.d.config.retentionMs > 0 ? data : null,
      clear,
    });
    if (this.d.config.retentionMs <= 0) clear();
    // 終了処理（任意の出力）が全て済んだ後に、確定通知を1回だけ送る
    this.d.send({ type: 'session.ended', sessionId: this.sessionId!, exportPath, reviewAvailableUntil: retainedUntil });
  }

  /** STT 接続・生成要求・待機・タイマーを止める（pause/end 共通）。 */
  private haltExternal(): void {
    // 実行中の生成はスケジューラーが AbortSignal で中止する
    if (this.scheduler) this.process(this.scheduler.shutdown());
    this.stopRecognizers();
    this.replay?.pause();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  private stopRecognizers(): void {
    for (const [src, rec] of this.recognizers) {
      this.recognizerUnsubs.get(src)?.();
      void rec.stop();
    }
    this.recognizers.clear();
    this.recognizerUnsubs.clear();
  }

  // -------------------------------------------------------------------------
  // STT
  // -------------------------------------------------------------------------

  private getRecognizer(source: CaptureSource): SpeechRecognizer | null {
    const existing = this.recognizers.get(source);
    if (existing && existing.state !== 'failed' && existing.state !== 'closed') return existing;
    if (existing) return null; // failed: 自動で作り直さない（状態は error として表示済み）
    const rec = this.mode === 'OFFLINE' ? new FakeSpeechRecognizer({ source, acceptAudio: false, now: this.now }) : this.d.createLiveRecognizer(source);
    if (!rec) {
      this.setPipe('stt', 'not_configured', 'not_configured');
      return null;
    }
    this.recognizers.set(source, rec);
    this.recognizerUnsubs.set(source, rec.on((ev) => this.onRecognizerEvent(source, ev)));
    return rec;
  }

  private onRecognizerEvent(source: CaptureSource, ev: RecognizerEvent): void {
    if (this.ended) return;
    switch (ev.type) {
      case 'audio_sent':
        if (!this.isActive) {
          this.guard.audioAfterStop++;
          return;
        }
        this.usage!.addSttFrame({
          source,
          streamGeneration: ev.meta.frameGeneration,
          sequence: ev.meta.sequence,
          durationMs: ev.meta.durationMs,
        });
        return;
      case 'audio_dropped': {
        this.audioGaps.push({ source, fromMs: ev.fromMs, toMs: ev.toMs, droppedMs: ev.droppedMs, origin: 'server', reason: `server_${ev.reason}` });
        if (this.audioGaps.length > 500) this.audioGaps.shift();
        if (ev.reason === 'stopped') return;
        this.setPipe(source, 'delayed', 'backpressure_drop');
        const now = this.now();
        if (now - this.lastDropWarnAt > 5000) {
          this.lastDropWarnAt = now;
          this.warning('audio_dropped', `${source === 'SELF' ? '自分側' : '会議側'}の音声が遅れたため一部を破棄しました`, []);
        }
        this.sendStatus();
        return;
      }
      case 'state':
        if (this.mode === 'OFFLINE') return;
        if (ev.state === 'open') this.setPipe('stt', 'active', null);
        else if (ev.state === 'connecting') this.setPipe('stt', 'waiting', null);
        else if (ev.state === 'reconnecting') this.setPipe('stt', 'delayed', 'reconnecting');
        else if (ev.state === 'failed') this.setPipe('stt', 'error', sttReason(ev.reason));
        this.sendStatus();
        return;
      case 'error':
        if (ev.fatal) {
          this.setPipe('stt', ev.kind === 'not_configured' ? 'not_configured' : 'error', sttReason(ev.kind));
          this.error(sttErrorCode(ev.kind), `STT failed (${ev.kind})`, ev.kind === 'rate_limited' || ev.kind === 'network');
          this.sendStatus();
        }
        return;
      case 'utterance_end': {
        const uttId = this.lastUtteranceBySource.get(source);
        const utt = uttId ? this.transcript!.getUtterance(uttId) : undefined;
        if (utt && utt.text.length > 0) {
          const wall = this.latency.wallTimeForAudio(source, ev.lastWordEndMs) ?? ev.receivedAt;
          this.latency.speechEnded(utt.utteranceId, wall, ev.receivedAt);
          this.maybeAutoTrigger(utt);
        }
        return;
      }
      case 'result':
        this.onSttResult(ev.result);
        return;
    }
  }

  private onSttResult(r: NormalizedSttResult): void {
    if (!this.isActive) return; // 一時停止・終了後に届いた結果は扱わない
    const ing = this.transcript!.ingest({
      source: r.source,
      streamGeneration: r.streamGeneration,
      text: r.text,
      isFinal: r.isFinal,
      speechFinal: r.speechFinal,
      startMs: r.startMs,
      endMs: r.endMs,
    });
    if (ing.change === 'duplicate' || ing.change === 'stale_interim_ignored' || ing.change === 'empty_ignored') return;
    const seg = ing.segment!;
    this.d.send({
      type: 'transcript.segment',
      segmentId: seg.segmentId,
      utteranceId: seg.utteranceId,
      source: seg.source,
      streamGeneration: seg.streamGeneration,
      text: seg.text,
      isFinal: seg.isFinal,
      speechFinal: seg.speechFinal,
      startMs: seg.startMs,
      endMs: seg.endMs,
      revision: seg.revision,
    });
    if (this.mode === 'LIVE') this.setPipe('stt', 'active', null);
    const utt = ing.utterance;
    if (!utt) return;
    this.lastUtteranceBySource.set(r.source, utt.utteranceId);

    for (const id of ing.invalidatedAdviceIds) {
      this.process(this.scheduler!.invalidate(id), { invalidationReason: 'transcript_revised' });
    }
    for (const other of ing.otherUtterancesFlagged) this.conversation!.upsertUtterance(other);

    if (ing.utteranceTextChanged && utt.text.length > 0) {
      const conv = this.conversation!;
      const up = conv.upsertUtterance(utt);
      let significant = up.significant;
      // 構造化メモの更新（根拠ID付き）。高速経路をブロックしないよう同期・軽量のルール抽出のみ
      const cu = conv.getUtterance(utt.utteranceId);
      if (cu) {
        try {
          for (const cand of this.d.coaching.extractMemoCandidates(cu, conv)) {
            const res = conv.upsertMemoItem(cand);
            if (res.contextRevisionBumped) significant = true;
          }
        } catch (e) {
          this.log.warn({ err: e }, 'memo extraction failed');
        }
      }
      this.process(this.scheduler!.updateContextRevision(conv.contextRevision, significant));
    }
    if (r.speechFinal && utt.text.length > 0) {
      const wall = this.latency.wallTimeForAudio(r.source, utt.endMs) ?? r.receivedAt;
      this.latency.speechEnded(utt.utteranceId, wall, r.receivedAt);
      this.maybeAutoTrigger(utt);
    }
  }

  private maybeAutoTrigger(utt: Utterance): void {
    if (!this.isActive || !this.engine) return;
    const key = `${utt.utteranceId}:${utt.revision}`;
    if (this.evaluated.has(key)) return;
    this.evaluated.add(key);
    const conv = this.conversation!;
    const cu: ConversationUtterance | undefined = conv.getUtterance(utt.utteranceId);
    if (!cu) return;
    let should = false;
    try {
      should = this.d.coaching.shouldTriggerAuto({
        utterance: cu,
        state: conv,
        approvedFacts: this.facts,
      });
    } catch (e) {
      this.log.warn({ err: e }, 'shouldTriggerAuto failed');
    }
    if (!should) return;
    this.latency.eligible();
    this.process(
      this.scheduler!.requestAuto({ utteranceId: cu.utteranceId, text: cu.text, source: cu.source, contextRevision: conv.contextRevision }),
    );
  }

  private startReplay(script: ReplayScript): void {
    const sources: CaptureSource[] = ['SELF', 'REMOTE'];
    for (const s of sources) (this.getRecognizer(s) as FakeSpeechRecognizer | null)?.open();
    this.replay = new ReplayDriver(
      script,
      Math.max(0.1, this.d.config.offline.speed),
      (e) => {
        if (!this.isActive) return;
        if (e.source === 'SELF' && !this.lifecycle!.selfCaptureEnabled) return;
        const rec = this.recognizers.get(e.source) as FakeSpeechRecognizer | undefined;
        rec?.emitResult({ text: e.text, isFinal: e.isFinal, speechFinal: e.speechFinal, startMs: e.startMs, endMs: e.endMs });
      },
      () => this.log.info({ sessionId: this.sessionId }, 'offline replay finished'),
      this.now,
    );
    this.replay.start();
  }

  // -------------------------------------------------------------------------
  // 助言
  // -------------------------------------------------------------------------

  private canStartLlm(): boolean {
    if (!this.lifecycle?.canCallLlm() || this.ended || !this.engine) return false;
    if (this.llmDisabledReason) return false;
    if (this.now() < this.llmBackoffUntil) return false;
    if (this.llmExternal && !this.usage!.canStartExternalCall('llm')) {
      this.setPipe('advice', 'error', 'budget_exceeded');
      return false;
    }
    return true;
  }

  private manual(kind: 'rebuttal' | 'next_question' | 'next_step', requestId: string): void {
    if (!this.requireSession()) return;
    if (!this.isActive) return this.error('invalid_state', 'analysis is paused', true, requestId);
    if (!this.engine) return this.error('not_configured', 'advice LLM is not configured', false, requestId);
    if (this.llmDisabledReason) return this.error(this.llmDisabledReason === 'auth_failed' ? 'upstream_error' : 'not_configured', `advice unavailable (${this.llmDisabledReason})`, false, requestId);
    if (this.llmExternal && !this.usage!.canStartExternalCall('llm')) return this.error('budget_exceeded', 'session budget reached', false, requestId);
    this.latency.eligible();
    const events = this.scheduler!.requestManual(kind, this.conversation!.contextRevision);
    const rejected = events.find((e) => e.type === 'rejected');
    if (rejected && rejected.type === 'rejected') {
      return this.error(rejected.reason === 'rate_limited' ? 'rate_limited' : 'invalid_state', `manual request rejected (${rejected.reason})`, true, requestId);
    }
    this.process(events);
  }

  private process(events: SchedulerEvent[], ctx: { jobId?: string; invalidationReason?: AdviceInvalidationReason } = {}): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'start':
          void this.runJob(ev.job);
          break;
        case 'queued':
          if (this.pipes.advice.state !== 'active') this.setPipe('advice', 'waiting', 'cooldown');
          break;
        case 'abort':
          this.latency.outcome('discarded');
          break;
        case 'discard':
          this.latency.outcome('discarded');
          this.deferredJobs.delete(ev.jobId);
          break;
        case 'no_advice':
          this.latency.outcome('noAdvice');
          this.setPipe('advice', 'waiting', 'listening');
          this.sendStatus();
          break;
        case 'deferred':
          if (ctx.jobId) this.deferredJobs.set(ev.card.adviceId, ctx.jobId);
          this.cards.set(ev.card.adviceId, ev.card);
          break;
        case 'display': {
          const card = ev.card;
          const jobId = ctx.jobId ?? this.deferredJobs.get(card.adviceId) ?? null;
          this.deferredJobs.delete(card.adviceId);
          this.cards.set(card.adviceId, card);
          this.transcript?.registerAdviceDependency(card.adviceId, card.evidenceUtteranceIds);
          this.d.send({ type: 'advice.card', card });
          if (jobId) this.latency.sent(jobId, this.now(), card.adviceId);
          this.sendPinState();
          break;
        }
        case 'card_status': {
          const card = this.scheduler!.getCard(ev.adviceId);
          if (!card) break;
          this.cards.set(card.adviceId, card);
          this.pin.sync(card);
          if (ev.status === 'invalidated') {
            this.transcript?.releaseAdvice(card.adviceId);
            this.d.send({ type: 'advice.invalidated', adviceId: card.adviceId, reason: ctx.invalidationReason ?? 'transcript_revised' });
          } else {
            this.d.send({ type: 'advice.card', card });
          }
          this.sendPinState();
          break;
        }
        case 'rejected':
        case 'replaced_pending':
          break;
      }
    }
  }

  private async runJob(job: AdviceJob): Promise<void> {
    const engine = this.engine;
    if (!engine || !this.canStartLlm()) {
      this.guard.llmAfterStop += this.ended || !this.isActive ? 1 : 0;
      this.process(this.scheduler!.fail(job.jobId));
      return;
    }
    this.inflight.set(job.jobId, job);
    this.latency.requested(job.jobId, job.triggerUtteranceId, this.now());
    this.setPipe('advice', 'active', 'generating');
    this.sendStatus();
    let result: AdviceResultLike;
    try {
      result = await engine.generate(this.buildContext(job), job.signal);
    } catch (e) {
      this.inflight.delete(job.jobId);
      const aborted = job.signal.aborted || (e as { kind?: string; name?: string })?.kind === 'aborted' || (e as { name?: string })?.name === 'AbortError';
      if (!aborted) this.onLlmFailure(job, (e as { kind?: string })?.kind ?? 'unknown', (e as { usage?: AdviceResultLike['usage'] }).usage);
      if (this.scheduler && !this.ended) this.process(this.scheduler.fail(job.jobId));
      this.afterJob();
      return;
    }
    this.inflight.delete(job.jobId);
    if (this.llmExternal) {
      this.usage!.addLlmUsage({ callId: job.jobId, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
    }
    if (this.ended || job.signal.aborted) {
      this.process(this.scheduler!.complete(job.jobId, result.output, result.warnings));
      this.afterJob();
      return;
    }
    this.latency.validated(job.jobId, this.now());
    if (result.outcome === 'fallback') {
      this.latency.outcome('fallback');
      this.onFallback(result.fallbackReason ?? 'unknown');
    } else if (this.pipes.advice.state === 'error' || this.pipes.advice.state === 'delayed') {
      this.setPipe('advice', 'waiting', 'listening');
    }
    this.process(this.scheduler!.complete(job.jobId, result.output, result.warnings), { jobId: job.jobId });
    this.afterJob();
  }

  private afterJob(): void {
    if (this.ended || !this.isActive) return;
    if (this.inflight.size === 0 && this.pipes.advice.state === 'active') this.setPipe('advice', 'waiting', 'listening');
    this.sendStatus();
  }

  /** エンジンが例外で失敗した（通常はエンジンが fallback を返すが、例外も安全側で扱う）。 */
  private onLlmFailure(job: AdviceJob, kind: string, usage?: AdviceResultLike['usage']): void {
    if (usage && this.llmExternal) {
      this.usage!.addLlmUsage({ callId: job.jobId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    }
    this.latency.outcome(kind === 'timeout' ? 'timeout' : 'failed');
    this.applyLlmDegradation(kind);
    this.error(llmErrorCode(kind), `advice generation failed (${kind})`, RECOVERABLE_LLM.has(kind));
  }

  /** fallback の理由（エンジンの理由コード）に応じた縮退。 */
  private onFallback(reason: string): void {
    const kind = ['not_configured', 'auth_failed', 'rate_limited', 'timeout', 'network', 'invalid_json'].find((k) => reason.includes(k));
    if (kind === 'timeout') this.latency.outcome('timeout');
    if (kind) this.applyLlmDegradation(kind);
  }

  private applyLlmDegradation(kind: string): void {
    switch (kind) {
      case 'not_configured':
        this.llmDisabledReason = 'not_configured';
        this.setPipe('advice', 'not_configured', 'not_configured');
        break;
      case 'auth_failed':
        // 認証失敗は再試行しても直らない: 以後の生成を止める（キー確認が必要）
        this.llmDisabledReason = 'auth_failed';
        this.setPipe('advice', 'error', 'auth_failed');
        break;
      case 'rate_limited':
        this.llmBackoffUntil = this.now() + 10_000;
        this.setPipe('advice', 'delayed', 'rate_limited');
        break;
      case 'timeout':
        this.setPipe('advice', 'delayed', 'timeout');
        break;
      case 'network':
        this.setPipe('advice', 'delayed', 'disconnected');
        break;
      case 'invalid_json':
        this.setPipe('advice', 'delayed', 'invalid_output');
        break;
      default:
        this.setPipe('advice', 'delayed', 'upstream_error');
    }
    this.sendStatus();
  }

  private buildContext(job: AdviceJob) {
    const conv = this.conversation!;
    const snap = conv.snapshot();
    return {
      sessionId: this.sessionId!,
      contextRevision: job.contextRevision,
      trigger: job.trigger,
      purpose: this.purpose,
      window: snap.window.map((u) => ({ utteranceId: u.utteranceId, source: u.source, text: u.text, flags: [...u.flags] })),
      memo: snap,
      approvedFacts: this.facts.filter((f) => f.status === 'approved'),
      degraded: conv.isDegraded(),
    };
  }

  // -------------------------------------------------------------------------
  // 表示固定・フィードバック・系統状態
  // -------------------------------------------------------------------------

  private pinCard(adviceId: string): void {
    if (!this.requireSession()) return;
    const r = this.pin.pin(this.scheduler!.getCard(adviceId));
    if (!r.ok) return this.error('invalid_message', `cannot pin (${r.error})`, true);
    this.sendPinState();
  }

  private unpinCard(adviceId: string): void {
    if (!this.requireSession()) return;
    const r = this.pin.unpin(adviceId);
    if (!r.ok) return this.error('invalid_message', `cannot unpin (${r.error})`, true);
    this.sendPinState();
  }

  private sendPinState(): void {
    if (!this.scheduler) return;
    const v = this.pin.view(this.scheduler.currentCard, this.now());
    if (v.mode === 'empty' && this.pin.pinnedAdviceId === null) return;
    this.d.send({
      type: 'card.pin.state',
      pinnedAdviceId: this.pin.pinnedAdviceId,
      displayStatus: v.displayStatus,
      warnings: v.warnings,
      hasNewerCard: v.hasNewerCard,
    });
  }

  private feedback(adviceId: string, rating: 'helpful' | 'off'): void {
    const card = this.cards.get(adviceId) ?? this.scheduler?.getCard(adviceId);
    if (!card) return this.error('invalid_message', 'unknown adviceId', true);
    this.d.store.addFeedback({ adviceId, rating, kind: card.kind, promptVersion: card.promptVersion });
  }

  private sourceState(msg: Extract<ClientMessage, { type: 'source.state' }>): void {
    if (!this.requireSession()) return;
    const conv = this.conversation!;
    if (msg.source === 'SELF') {
      const on = msg.state === 'on';
      this.lifecycle!.setSelfCapture(on);
      conv.setSourceAvailability({ SELF: on });
      if (!on) {
        const rec = this.recognizers.get('SELF');
        if (rec && this.mode === 'LIVE') {
          this.recognizerUnsubs.get('SELF')?.();
          this.recognizerUnsubs.delete('SELF');
          this.recognizers.delete('SELF');
          void rec.stop();
        }
        this.setPipe('SELF', 'idle', 'self_capture_off');
        this.warning('degraded_capture', '自分の音声取得はOFFです（会議のミュートとは別です）', []);
      } else {
        this.setPipe('SELF', this.mode === 'OFFLINE' ? 'offline' : 'waiting', this.mode === 'OFFLINE' ? 'offline_mode' : null);
      }
    } else {
      const ok = msg.state === 'ok';
      conv.setSourceAvailability({ REMOTE: ok });
      if (ok) this.setPipe('REMOTE', this.mode === 'OFFLINE' ? 'offline' : 'waiting', this.mode === 'OFFLINE' ? 'offline_mode' : null);
      else {
        this.setPipe('REMOTE', 'error', msg.reason ?? 'source_lost');
        this.warning('degraded_capture', '会議側の音声が取得できていません', []);
      }
    }
    this.process(this.scheduler!.updateContextRevision(conv.contextRevision, false));
    this.sendStatus();
  }

  // -------------------------------------------------------------------------
  // 定期処理・送信
  // -------------------------------------------------------------------------

  private tick(): void {
    if (!this.scheduler || this.ended || !this.isActive) return;
    this.process(this.scheduler.tick());
  }

  private sendUsage(): void {
    if (!this.usage || this.ended) return;
    const snap = this.usage.snapshot();
    this.d.send({ type: 'usage', ...snap });
    if (snap.budget.level === 'warn' && !this.budgetWarned) {
      this.budgetWarned = true;
      this.warning('budget_near_limit', 'セッションの使用量が上限の80%に達しました', []);
    }
    if (snap.budget.level === 'blocked') {
      if (!this.usage.canStartExternalCall('stt')) {
        this.stopRecognizers();
        this.setPipe('stt', 'error', 'budget_exceeded');
      }
      if (!this.usage.canStartExternalCall('llm')) this.setPipe('advice', 'error', 'budget_exceeded');
      this.sendStatus();
    }
  }

  private sendStatus(): void {
    const externalSending =
      this.isActive &&
      ((this.mode === 'LIVE' && [...this.recognizers.values()].some((r) => r.state === 'open')) ||
        (this.llmExternal && this.inflight.size > 0));
    this.d.send({
      type: 'status',
      sessionId: this.sessionId,
      lifecycle: this.lifecycle?.state ?? 'idle',
      mode: this.mode,
      externalSending,
      storage: this.storage,
      pipelines: {
        capture: { SELF: { ...this.pipes.SELF }, REMOTE: { ...this.pipes.REMOTE } },
        stt: { ...this.pipes.stt },
        advice: { ...this.pipes.advice },
      },
      at: this.now(),
    });
  }

  private setPipe(p: Pipe, state: PipelineState, reason: StatusReason | null): void {
    const cur = this.pipes[p];
    if (cur.state === state && cur.reason === reason) return;
    this.pipes[p] = { state, reason, since: this.now() };
  }

  private warning(code: WarningCode, message: string, evidenceUtteranceIds: string[]): void {
    this.d.send({ type: 'warning', warningId: `warn_${randomUUID()}`, code, message, evidenceUtteranceIds, at: this.now() });
  }

  private error(code: ErrorCode, message: string, recoverable: boolean, requestId?: string): void {
    this.d.send({ type: 'error', code, message, recoverable, ...(requestId ? { requestId } : {}) });
  }

  private requireSession(): boolean {
    if (!this.sessionId || !this.lifecycle) {
      this.error('invalid_state', 'no active session', true);
      return false;
    }
    if (this.ended) {
      this.error('invalid_state', 'session ended', false);
      return false;
    }
    return true;
  }

  private buildExport(endedAt: number): SessionExport {
    return {
      sessionId: this.sessionId!,
      mode: this.mode!,
      startedAt: this.startedAt,
      endedAt,
      purpose: this.purpose,
      customerName: this.customerName,
      appliedFacts: this.facts.map((f) => ({ factId: f.factId, version: f.version })),
      adviceLabel: this.adviceLabel,
      transcript: (this.transcript?.finalUtterances() ?? []).map((u) => ({
        utteranceId: u.utteranceId,
        source: u.source,
        text: u.text,
        startMs: u.startMs,
        endMs: u.endMs,
        flags: [...u.flags],
      })),
      advice: [...this.cards.values()],
      usage: this.usage!.snapshot(),
      latency: this.latency.stats(),
      audioGaps: [...this.audioGaps],
    };
  }
}

function sttReason(kind: RecognizerErrorKind | null): StatusReason {
  switch (kind) {
    case 'not_configured':
      return 'not_configured';
    case 'auth_failed':
      return 'auth_failed';
    case 'rate_limited':
      return 'rate_limited';
    case 'network':
      return 'disconnected';
    default:
      return 'upstream_error';
  }
}

function sttErrorCode(kind: RecognizerErrorKind): ErrorCode {
  if (kind === 'not_configured') return 'not_configured';
  if (kind === 'rate_limited') return 'rate_limited';
  return 'upstream_error';
}

function llmErrorCode(kind: string): ErrorCode {
  if (kind === 'not_configured') return 'not_configured';
  if (kind === 'rate_limited') return 'rate_limited';
  if (kind === 'timeout') return 'timeout';
  return 'upstream_error';
}
