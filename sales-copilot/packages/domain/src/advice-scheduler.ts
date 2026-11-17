import type {
  AdviceCard,
  AdviceCardStatus,
  AdviceLlmOutput,
  AdviceTrigger,
  AdviceWarning,
  ManualAdviceKind,
} from '@sales-copilot/contracts';
import { MANUAL_KIND_TO_TRIGGER } from '@sales-copilot/contracts';
import { createSequentialIdGenerator, systemClock, type Clock, type IdGenerator } from './clock';
import { isBackchannel } from './text';

export interface AdviceJob {
  jobId: string;
  /** 発行順の単調増加番号（返却順の逆転対策）。 */
  seq: number;
  trigger: AdviceTrigger;
  manualKind: ManualAdviceKind | null;
  /** 生成対象とした文脈リビジョン。 */
  contextRevision: number;
  /** 契機になった発話（自動の場合）。 */
  triggerUtteranceId: string | null;
  requestedAt: number;
  startedAt: number | null;
  /** 実行中の外部呼び出しを中止するためのシグナル。 */
  signal: AbortSignal;
}

export type DiscardReason =
  | 'aborted'
  | 'superseded'
  | 'stale_context'
  | 'expired'
  | 'unknown_job'
  | 'no_action'
  | 'shutdown';

export type RejectReason = 'backchannel' | 'self_utterance' | 'rate_limited' | 'shutdown' | 'blocked';

export type AbortReason = 'context_changed' | 'manual_priority' | 'shutdown';

export type SchedulerEvent =
  | { type: 'start'; job: AdviceJob }
  | { type: 'queued'; job: AdviceJob; readyAt: number }
  | { type: 'replaced_pending'; jobId: string }
  | { type: 'abort'; job: AdviceJob; reason: AbortReason }
  | { type: 'rejected'; reason: RejectReason }
  | { type: 'display'; card: AdviceCard }
  | { type: 'deferred'; card: AdviceCard; reason: 'self_speaking' }
  | { type: 'discard'; jobId: string; reason: DiscardReason }
  | { type: 'no_advice'; jobId: string }
  | { type: 'card_status'; adviceId: string; status: AdviceCardStatus; reason: 'stale' | 'topic_changed' | 'invalidated' };

export interface AdviceSchedulerOptions {
  sessionId: string;
  promptVersion: string;
  /** 営業補正ルール（承認済み）の版。指定時はカードに記録する。 */
  rulesVersion?: number;
  clock?: Clock;
  idGenerator?: IdGenerator;
  /** 自動助言のクールダウン（SPEC §8-2 初期6秒）。 */
  cooldownMs?: number;
  /** 手動要求の最小間隔（過負荷防止）。 */
  manualMinIntervalMs?: number;
  /** 手動要求の1分あたり上限。 */
  manualMaxPerMinute?: number;
  /** カードの現行推奨期限（SPEC §8-3 初期8秒）。 */
  staleMs?: number;
  /** 外部呼び出しを許可するか（ライフサイクル・予算のガード）。false なら新規生成を開始しない。 */
  canStart?: () => boolean;
}

export interface AutoTrigger {
  utteranceId: string;
  text: string;
  source: 'SELF' | 'REMOTE' | 'UNKNOWN';
  contextRevision: number;
}

interface PendingRequest {
  job: AdviceJob;
  controller: AbortController;
  readyAt: number;
}

/**
 * 助言生成のスケジューラー（SPEC §8-2）。IO を持たず、イベント列を返す。
 * - セッションごとに実行中は1つ、待機は最新1つまで
 * - 自動はクールダウン、手動はクールダウン無視（ただし間隔・回数制限あり）
 * - 重要発言・訂正で前提が変われば実行中を中止し、古い結果は破棄
 * - 返却順が逆転しても古い結果で新しい表示を上書きしない
 * - 相づちは契機にも中止理由にもしない
 * - 野中（SELF）発話中は大きなカード更新を保留
 */
export class AdviceScheduler {
  private readonly o: Required<Omit<AdviceSchedulerOptions, 'canStart' | 'rulesVersion'>> & { canStart: () => boolean };
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private seq = 0;
  private inflight: { job: AdviceJob; controller: AbortController } | null = null;
  private pending: PendingRequest | null = null;
  private lastAutoStartAt = Number.NEGATIVE_INFINITY;
  private manualHistory: number[] = [];
  /** これ未満の contextRevision で生成された結果は破棄する。 */
  private minValidRevision = 0;
  private displayedSeq = -1;
  private current: AdviceCard | null = null;
  private deferred: { card: AdviceCard; seq: number } | null = null;
  private selfSpeaking = false;
  private stopped = false;
  private readonly abortedJobs = new Set<string>();
  private readonly cards = new Map<string, AdviceCard>();

  private readonly rulesVersion: number | undefined;

  constructor(opts: AdviceSchedulerOptions) {
    this.rulesVersion = opts.rulesVersion;
    this.clock = opts.clock ?? systemClock;
    this.ids = opts.idGenerator ?? createSequentialIdGenerator();
    this.o = {
      sessionId: opts.sessionId,
      promptVersion: opts.promptVersion,
      clock: this.clock,
      idGenerator: this.ids,
      cooldownMs: opts.cooldownMs ?? 6000,
      manualMinIntervalMs: opts.manualMinIntervalMs ?? 1500,
      manualMaxPerMinute: opts.manualMaxPerMinute ?? 12,
      staleMs: opts.staleMs ?? 8000,
      canStart: opts.canStart ?? (() => true),
    };
  }

  get currentCard(): AdviceCard | null {
    return this.current ? { ...this.current } : null;
  }

  get inflightJob(): AdviceJob | null {
    return this.inflight?.job ?? null;
  }

  get pendingJob(): AdviceJob | null {
    return this.pending?.job ?? null;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  getCard(adviceId: string): AdviceCard | undefined {
    const c = this.cards.get(adviceId);
    return c ? { ...c } : undefined;
  }

  /** 自動契機（確定発話）。相づち・SELF 発話は契機にしない。 */
  requestAuto(t: AutoTrigger): SchedulerEvent[] {
    if (this.stopped) return [{ type: 'rejected', reason: 'shutdown' }];
    if (isBackchannel(t.text)) return [{ type: 'rejected', reason: 'backchannel' }];
    if (t.source === 'SELF') return [{ type: 'rejected', reason: 'self_utterance' }];
    const now = this.clock.now();
    const readyAt = Math.max(now, this.lastAutoStartAt + this.o.cooldownMs);
    return this.enqueue('auto', null, t.contextRevision, t.utteranceId, readyAt);
  }

  /** 手動ボタン（切り返し / 次に聞く / 次の約束）。クールダウンより優先。 */
  requestManual(kind: ManualAdviceKind, contextRevision: number): SchedulerEvent[] {
    if (this.stopped) return [{ type: 'rejected', reason: 'shutdown' }];
    const now = this.clock.now();
    this.manualHistory = this.manualHistory.filter((t) => now - t < 60_000);
    const last = this.manualHistory[this.manualHistory.length - 1];
    if (
      (last !== undefined && now - last < this.o.manualMinIntervalMs) ||
      this.manualHistory.length >= this.o.manualMaxPerMinute
    ) {
      return [{ type: 'rejected', reason: 'rate_limited' }];
    }
    this.manualHistory.push(now);
    const events: SchedulerEvent[] = [];
    // 実行中が自動なら中止して手動を優先
    if (this.inflight && this.inflight.job.trigger === 'auto') {
      events.push(...this.abortInflight('manual_priority'));
    }
    events.push(...this.enqueue(MANUAL_KIND_TO_TRIGGER[kind], kind, contextRevision, null, now));
    return events;
  }

  /**
   * 文脈リビジョンの更新。significant=true（重要発言・訂正）なら、
   * それより古い文脈の実行中生成を中止し、現行カードを「参考」に下げる。
   */
  updateContextRevision(revision: number, significant: boolean): SchedulerEvent[] {
    if (!significant || revision <= this.minValidRevision) return [];
    this.minValidRevision = revision;
    const events: SchedulerEvent[] = [];
    if (this.inflight && this.inflight.job.contextRevision < revision) {
      events.push(...this.abortInflight('context_changed'));
    }
    if (this.pending && this.pending.job.contextRevision < revision) {
      // 待機中のものは新しい文脈で作り直す（同じ契機・同じ readyAt）
      this.pending.job = { ...this.pending.job, contextRevision: revision };
    }
    if (this.deferred && this.deferred.card.contextRevision < revision) {
      events.push({ type: 'discard', jobId: this.deferred.card.adviceId, reason: 'stale_context' });
      this.deferred = null;
    }
    if (this.current && this.current.status === 'current' && this.current.contextRevision < revision) {
      events.push(this.setStatus(this.current, 'reference', 'topic_changed', '話題・前提が変わりました'));
    }
    events.push(...this.startIfPossible());
    return events;
  }

  /** 生成結果の受け取り。検証済み（スキーマ・内容検査済み）の出力のみ渡すこと。 */
  complete(jobId: string, output: AdviceLlmOutput, warnings: AdviceWarning[] = []): SchedulerEvent[] {
    const events: SchedulerEvent[] = [];
    if (this.stopped) return [{ type: 'discard', jobId, reason: 'shutdown' }];
    if (this.abortedJobs.has(jobId)) {
      this.abortedJobs.delete(jobId);
      return [{ type: 'discard', jobId, reason: 'aborted' }];
    }
    if (!this.inflight || this.inflight.job.jobId !== jobId) {
      return [{ type: 'discard', jobId, reason: 'unknown_job' }];
    }
    const { job } = this.inflight;
    this.inflight = null;
    const now = this.clock.now();

    if (job.contextRevision < this.minValidRevision) {
      events.push({ type: 'discard', jobId, reason: 'stale_context' });
    } else if (job.seq <= this.displayedSeq) {
      events.push({ type: 'discard', jobId, reason: 'superseded' });
    } else if (output.action === 'none') {
      events.push({ type: 'no_advice', jobId });
    } else {
      const card: AdviceCard = {
        ...output,
        adviceId: this.ids('adv'),
        sessionId: this.o.sessionId,
        contextRevision: job.contextRevision,
        promptVersion: this.o.promptVersion,
        ...(this.rulesVersion !== undefined ? { rulesVersion: this.rulesVersion } : {}),
        createdAt: now,
        expiresAt: now + this.o.staleMs,
        trigger: job.trigger,
        status: 'current',
        warnings: [...warnings],
      };
      this.cards.set(card.adviceId, card);
      if (this.selfSpeaking && output.action === 'show') {
        this.deferred = { card, seq: job.seq };
        events.push({ type: 'deferred', card: { ...card }, reason: 'self_speaking' });
      } else {
        events.push(...this.display(card, job.seq));
      }
    }
    events.push(...this.startIfPossible());
    return events;
  }

  /** 生成失敗（タイムアウト・429・不正JSON等）。次の待機を開始する。 */
  fail(jobId: string): SchedulerEvent[] {
    if (this.abortedJobs.delete(jobId)) return this.startIfPossible();
    if (this.inflight?.job.jobId === jobId) this.inflight = null;
    return this.startIfPossible();
  }

  /** 野中（SELF）の発話中状態。終われば保留したカードを表示（古ければ破棄）。 */
  setSelfSpeaking(speaking: boolean): SchedulerEvent[] {
    this.selfSpeaking = speaking;
    if (speaking || !this.deferred) return [];
    const { card, seq } = this.deferred;
    this.deferred = null;
    const now = this.clock.now();
    if (card.contextRevision < this.minValidRevision) {
      return [{ type: 'discard', jobId: card.adviceId, reason: 'stale_context' }];
    }
    if (now >= card.expiresAt) return [{ type: 'discard', jobId: card.adviceId, reason: 'expired' }];
    if (seq <= this.displayedSeq) return [{ type: 'discard', jobId: card.adviceId, reason: 'superseded' }];
    return this.display(card, seq);
  }

  /** 定期呼び出し: クールダウン明けの待機開始と、期限切れカードの「参考」化。 */
  tick(): SchedulerEvent[] {
    const events: SchedulerEvent[] = [];
    const now = this.clock.now();
    if (this.current && this.current.status === 'current' && now >= this.current.expiresAt) {
      events.push(this.setStatus(this.current, 'reference', 'stale', '時間が経過したため参考扱い'));
    }
    events.push(...this.startIfPossible());
    return events;
  }

  /** 訂正等で依存助言が無効になった。 */
  invalidate(adviceId: string): SchedulerEvent[] {
    const card = this.cards.get(adviceId);
    if (!card || card.status === 'invalidated') return [];
    const events: SchedulerEvent[] = [
      this.setStatus(card, 'invalidated', 'invalidated', '根拠の発言が訂正されました', 'transcript_revised'),
    ];
    if (this.deferred?.card.adviceId === adviceId) this.deferred = null;
    return events;
  }

  /** 一時停止・終了: 実行中を中止し待機を破棄。stop 後は何も開始しない。 */
  shutdown(): SchedulerEvent[] {
    const events: SchedulerEvent[] = [];
    if (this.inflight) events.push(...this.abortInflight('shutdown'));
    if (this.pending) {
      this.pending.controller.abort();
      events.push({ type: 'discard', jobId: this.pending.job.jobId, reason: 'shutdown' });
      this.pending = null;
    }
    if (this.deferred) {
      events.push({ type: 'discard', jobId: this.deferred.card.adviceId, reason: 'shutdown' });
      this.deferred = null;
    }
    this.stopped = true;
    return events;
  }

  /** 一時停止からの再開用（shutdown を解除）。 */
  resume(): void {
    this.stopped = false;
  }

  // -------------------------------------------------------------------------

  private enqueue(
    trigger: AdviceTrigger,
    manualKind: ManualAdviceKind | null,
    contextRevision: number,
    triggerUtteranceId: string | null,
    readyAt: number,
  ): SchedulerEvent[] {
    const events: SchedulerEvent[] = [];
    const controller = new AbortController();
    const job: AdviceJob = {
      jobId: this.ids('job'),
      seq: ++this.seq,
      trigger,
      manualKind,
      contextRevision,
      triggerUtteranceId,
      requestedAt: this.clock.now(),
      startedAt: null,
      signal: controller.signal,
    };
    if (this.pending) {
      // 手動の待機を自動で置き換えない
      if (this.pending.job.trigger !== 'auto' && trigger === 'auto') {
        return [{ type: 'rejected', reason: 'blocked' }];
      }
      this.pending.controller.abort();
      events.push({ type: 'replaced_pending', jobId: this.pending.job.jobId });
    }
    this.pending = { job, controller, readyAt };
    const started = this.startIfPossible();
    if (started.length === 0 && this.pending?.job.jobId === job.jobId) {
      events.push({ type: 'queued', job, readyAt });
    }
    events.push(...started);
    return events;
  }

  private startIfPossible(): SchedulerEvent[] {
    if (this.stopped || this.inflight || !this.pending) return [];
    const now = this.clock.now();
    if (now < this.pending.readyAt) return [];
    if (!this.o.canStart()) return [];
    const { job, controller } = this.pending;
    this.pending = null;
    const started: AdviceJob = { ...job, startedAt: now, contextRevision: Math.max(job.contextRevision, this.minValidRevision) };
    this.inflight = { job: started, controller };
    if (started.trigger === 'auto') this.lastAutoStartAt = now;
    return [{ type: 'start', job: started }];
  }

  private abortInflight(reason: AbortReason): SchedulerEvent[] {
    if (!this.inflight) return [];
    const { job, controller } = this.inflight;
    controller.abort();
    this.abortedJobs.add(job.jobId);
    this.inflight = null;
    return [{ type: 'abort', job, reason }];
  }

  private display(card: AdviceCard, seq: number): SchedulerEvent[] {
    const events: SchedulerEvent[] = [];
    if (this.current && this.current.status === 'current') {
      this.current.status = 'reference';
    }
    this.displayedSeq = seq;
    this.current = card;
    events.push({ type: 'display', card: { ...card } });
    return events;
  }

  private setStatus(
    card: AdviceCard,
    status: AdviceCardStatus,
    reason: 'stale' | 'topic_changed' | 'invalidated',
    message: string,
    code: AdviceWarning['code'] = reason === 'invalidated' ? 'transcript_revised' : reason,
  ): SchedulerEvent {
    card.status = status;
    if (!card.warnings.some((w) => w.code === code)) card.warnings = [...card.warnings, { code, message }];
    return { type: 'card_status', adviceId: card.adviceId, status, reason };
  }
}
