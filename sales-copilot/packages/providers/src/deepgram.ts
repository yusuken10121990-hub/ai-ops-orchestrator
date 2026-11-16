import WebSocket from 'ws';
import type { CaptureSource } from '@sales-copilot/contracts';
import {
  Emitter,
  type AudioChunkMeta,
  type NormalizedSttResult,
  type RecognizerErrorKind,
  type RecognizerEvent,
  type RecognizerState,
  type SpeechRecognizer,
} from './speech';

export const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen';

export interface DeepgramParams {
  /** DEEPGRAM_MODEL（例: nova-3）。公式資料で ja 対応を確認のうえ設定（docs/providers.md）。 */
  model: string;
  /** DEEPGRAM_LANGUAGE（例: ja）。 */
  language: string;
  /** 無音で speech_final を出すまでの ms。false で無効。 */
  endpointingMs: number | false;
  /** UtteranceEnd を出す無語時間（ms, 公式の最小 1000）。null で無効。interim_results=true が必須。 */
  utteranceEndMs: number | null;
  smartFormat: boolean;
  punctuate: boolean;
}

/** 送信形式は contracts の音声フレーム（16kHz / PCM16LE / mono）に固定。 */
export function buildDeepgramUrl(p: DeepgramParams, base = DEEPGRAM_LISTEN_URL): string {
  const q = new URLSearchParams();
  q.set('model', p.model);
  q.set('language', p.language);
  q.set('encoding', 'linear16');
  q.set('sample_rate', '16000');
  q.set('channels', '1');
  q.set('interim_results', 'true');
  q.set('endpointing', p.endpointingMs === false ? 'false' : String(Math.max(10, Math.round(p.endpointingMs))));
  if (p.utteranceEndMs !== null) q.set('utterance_end_ms', String(Math.max(1000, Math.round(p.utteranceEndMs))));
  if (p.smartFormat) q.set('smart_format', 'true');
  if (p.punctuate) q.set('punctuate', 'true');
  return `${base}?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// メッセージのパース（フィクスチャで契約テストする純関数）
// ---------------------------------------------------------------------------

export type DeepgramMessage =
  | {
      kind: 'results';
      /** 接続開始からの秒。 */
      start: number;
      duration: number;
      isFinal: boolean;
      speechFinal: boolean;
      fromFinalize: boolean;
      transcript: string;
      confidence: number | null;
    }
  | { kind: 'utterance_end'; lastWordEnd: number }
  | { kind: 'speech_started'; timestamp: number | null }
  | { kind: 'metadata'; requestId: string | null }
  | { kind: 'error'; code: string | null }
  | { kind: 'ignored'; reason: string };

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function parseDeepgramMessage(raw: string): DeepgramMessage {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return { kind: 'ignored', reason: 'not_json' };
  }
  if (typeof m !== 'object' || m === null) return { kind: 'ignored', reason: 'not_object' };
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'Results': {
      const start = num(o.start);
      const duration = num(o.duration);
      const alt = (o.channel as { alternatives?: unknown[] } | undefined)?.alternatives?.[0] as
        | { transcript?: unknown; confidence?: unknown }
        | undefined;
      if (start === null || duration === null || !alt || typeof alt.transcript !== 'string') {
        return { kind: 'ignored', reason: 'malformed_results' };
      }
      return {
        kind: 'results',
        start,
        duration,
        isFinal: o.is_final === true,
        speechFinal: o.speech_final === true,
        fromFinalize: o.from_finalize === true,
        transcript: alt.transcript,
        confidence: num(alt.confidence),
      };
    }
    case 'UtteranceEnd': {
      const lw = num(o.last_word_end);
      // 公式: last_word_end が -1 なら既に final 済みなので無視する
      if (lw === null || lw < 0) return { kind: 'ignored', reason: 'utterance_end_already_finalized' };
      return { kind: 'utterance_end', lastWordEnd: lw };
    }
    case 'SpeechStarted':
      return { kind: 'speech_started', timestamp: num(o.timestamp) };
    case 'Metadata':
      return { kind: 'metadata', requestId: typeof o.request_id === 'string' ? o.request_id : null };
    case 'Error':
      return { kind: 'error', code: typeof o.err_code === 'string' ? o.err_code : typeof o.code === 'string' ? o.code : null };
    default:
      return { kind: 'ignored', reason: 'unknown_type' };
  }
}

/**
 * 接続ごとの「Deepgram 音声時刻（その接続で送った音声の累積）」→「セッション音声時刻」の対応表。
 * 欠落（破棄）区間があっても、送った各チャンクの開始時刻で区分線形に写像するのでずれない。
 */
export class StreamTimeMap {
  private readonly dgStart: number[] = [];
  private readonly sessStart: number[] = [];
  private cumulative = 0;

  constructor(private readonly maxEntries = 6000) {}

  get sentMs(): number {
    return this.cumulative;
  }

  add(sessionStartMs: number, durationMs: number): void {
    this.dgStart.push(this.cumulative);
    this.sessStart.push(sessionStartMs);
    this.cumulative += durationMs;
    if (this.dgStart.length > this.maxEntries) {
      this.dgStart.splice(0, this.dgStart.length - this.maxEntries);
      this.sessStart.splice(0, this.sessStart.length - this.maxEntries);
    }
  }

  /** Deepgram 時刻（ms）→ セッション音声時刻（ms）。 */
  toSessionMs(dgMs: number): number {
    const n = this.dgStart.length;
    if (n === 0) return dgMs;
    let lo = 0;
    let hi = n - 1;
    if (dgMs < this.dgStart[0]!) return this.sessStart[0]! + (dgMs - this.dgStart[0]!);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.dgStart[mid]! <= dgMs) lo = mid;
      else hi = mid - 1;
    }
    return this.sessStart[lo]! + (dgMs - this.dgStart[lo]!);
  }
}

/** Results → 正規化結果。 */
export function normalizeDeepgramResult(
  msg: Extract<DeepgramMessage, { kind: 'results' }>,
  ctx: { source: CaptureSource; streamGeneration: number; timeMap: StreamTimeMap; receivedAt: number },
): NormalizedSttResult {
  const startMs = Math.max(0, ctx.timeMap.toSessionMs(msg.start * 1000));
  const endMs = Math.max(startMs, ctx.timeMap.toSessionMs((msg.start + msg.duration) * 1000));
  const rounded = Math.round(startMs);
  return {
    source: ctx.source,
    streamGeneration: ctx.streamGeneration,
    isFinal: msg.isFinal,
    speechFinal: msg.isFinal && msg.speechFinal,
    text: msg.transcript,
    startMs: rounded,
    endMs: Math.round(endMs),
    segmentKey: `${ctx.source}|${ctx.streamGeneration}|${rounded}`,
    receivedAt: ctx.receivedAt,
    fromFinalize: msg.fromFinalize,
  };
}

// ---------------------------------------------------------------------------
// WebSocket 接続
// ---------------------------------------------------------------------------

/** ws の WebSocket と互換の最小インターフェース（テストで差し替える）。 */
export interface WsLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export type WsFactory = (url: string, headers: Record<string, string>) => WsLike;

export const WS_OPEN = 1;

const defaultWsFactory: WsFactory = (url, headers) => new WebSocket(url, { headers, perMessageDeflate: false });

export interface DeepgramRecognizerOptions extends DeepgramParams {
  source: CaptureSource;
  /** 空なら not_configured（接続しない）。ログ・エラー文に出さない。 */
  apiKey: string | null | undefined;
  url?: string;
  wsFactory?: WsFactory;
  now?: () => number;
  /** 無音（送信なし）が続いた時の KeepAlive 間隔（公式: 3〜5秒ごと、10秒で切断）。 */
  keepAliveMs?: number;
  /** 未送信キューの上限（音声時間 ms）。超えたら古いものから破棄し欠落区間を記録。 */
  maxQueueMs?: number;
  /** ソケットの送信バッファ上限（音声時間 ms 相当）。超えたら送らずキューに残す。 */
  maxBufferedMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /** 連続再接続の上限。超えたら failed。 */
  maxReconnectAttempts?: number;
}

interface QueuedChunk {
  pcm: Uint8Array;
  meta: AudioChunkMeta;
}

const BYTES_PER_MS = 32; // 16kHz × 2byte × mono

/**
 * Deepgram Live（/v1/listen）への1系統1接続のストリーミング認識。
 * - 認証は Authorization: Token ヘッダー（URL に載せない）
 * - 再接続は世代を増やし、指数バックオフ（上限あり）。古い音声を大量再送しない（キュー上限 maxQueueMs）
 * - 送信が無い間は KeepAlive
 */
export class DeepgramStreamingRecognizer implements SpeechRecognizer {
  readonly source: CaptureSource;
  private readonly o: Required<Omit<DeepgramRecognizerOptions, 'apiKey' | 'url' | 'wsFactory' | 'now'>>;
  private readonly apiKey: string;
  private readonly url: string;
  private readonly wsFactory: WsFactory;
  private readonly now: () => number;
  private readonly emitter = new Emitter<RecognizerEvent>();
  private _state: RecognizerState = 'idle';
  private gen = -1;
  private ws: WsLike | null = null;
  private timeMap = new StreamTimeMap();
  private queue: QueuedChunk[] = [];
  private queuedMs = 0;
  private attempts = 0;
  private lastSendAt = 0;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** 接続中に致命的な理由が確定した（再接続しない）。 */
  private fatal: RecognizerErrorKind | null = null;
  private pendingReason: RecognizerErrorKind | null = null;

  constructor(opts: DeepgramRecognizerOptions) {
    this.source = opts.source;
    this.apiKey = (opts.apiKey ?? '').trim();
    this.url = buildDeepgramUrl(opts, opts.url ?? DEEPGRAM_LISTEN_URL);
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.now = opts.now ?? (() => Date.now());
    this.o = {
      source: opts.source,
      model: opts.model,
      language: opts.language,
      endpointingMs: opts.endpointingMs,
      utteranceEndMs: opts.utteranceEndMs,
      smartFormat: opts.smartFormat,
      punctuate: opts.punctuate,
      keepAliveMs: opts.keepAliveMs ?? 4000,
      maxQueueMs: opts.maxQueueMs ?? 2000,
      maxBufferedMs: opts.maxBufferedMs ?? 2000,
      reconnectBaseDelayMs: opts.reconnectBaseDelayMs ?? 250,
      reconnectMaxDelayMs: opts.reconnectMaxDelayMs ?? 5000,
      maxReconnectAttempts: opts.maxReconnectAttempts ?? 6,
    };
  }

  get state(): RecognizerState {
    return this._state;
  }

  get streamGeneration(): number {
    return Math.max(0, this.gen);
  }

  /** 接続URL（キーを含まない）。診断用。 */
  get endpoint(): string {
    return this.url;
  }

  on(listener: (ev: RecognizerEvent) => void): () => void {
    return this.emitter.on(listener);
  }

  sendAudio(pcm: Uint8Array, meta: AudioChunkMeta): boolean {
    if (this.stopped || this._state === 'closed') return false;
    if (this._state === 'failed') return false;
    if (!this.apiKey) {
      this.fail('not_configured', 'DEEPGRAM_API_KEY is not set');
      return false;
    }
    this.enqueue({ pcm, meta });
    if (this._state === 'idle') this.connect();
    else if (this._state === 'open') this.flush();
    return true;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    const dropped = this.queue;
    this.queue = [];
    this.queuedMs = 0;
    if (dropped.length > 0) this.emitDrop(dropped, 'stopped');
    const ws = this.ws;
    this.ws = null;
    this.setState('closed', null);
    this.emitter.clear();
    if (ws) {
      try {
        if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        // ignore
      }
      try {
        ws.close(1000, 'client stop');
      } catch {
        ws.terminate?.();
      }
    }
  }

  // -------------------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    this.gen++;
    this.timeMap = new StreamTimeMap();
    this.fatal = null;
    this.pendingReason = null;
    this.setState(this.gen === 0 ? 'connecting' : 'reconnecting', null);
    let ws: WsLike;
    try {
      ws = this.wsFactory(this.url, { Authorization: `Token ${this.apiKey}` });
    } catch {
      this.scheduleReconnect('network');
      return;
    }
    this.ws = ws;
    const myGen = this.gen;
    const isCurrent = () => this.ws === ws && this.gen === myGen && !this.stopped;

    ws.on('open', () => {
      if (!isCurrent()) return;
      this.attempts = 0;
      this.lastSendAt = this.now();
      this.setState('open', null);
      this.startKeepAlive();
      this.flush();
    });
    ws.on('message', (data: unknown, isBinary?: boolean) => {
      if (!isCurrent() || isBinary) return;
      const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      this.onMessage(text, myGen);
    });
    ws.on('unexpected-response', (req: { destroy?: () => void }, res: { statusCode?: number; resume?: () => void }) => {
      const code = res?.statusCode ?? 0;
      try {
        res?.resume?.();
        req?.destroy?.();
      } catch {
        // ignore
      }
      if (!isCurrent()) return;
      if (code === 401 || code === 403) this.fatal = 'auth_failed';
      else if (code === 429) this.pendingReason = 'rate_limited';
      else if (code >= 400 && code < 500) this.fatal = 'protocol';
      else this.pendingReason = 'network';
      this.onSocketGone(ws);
    });
    ws.on('error', () => {
      if (!isCurrent()) return;
      if (!this.pendingReason) this.pendingReason = 'network';
      // close が続くので、そちらで処理する（close が来ない実装に備えて保険で処理）
      if (ws.readyState !== WS_OPEN) this.onSocketGone(ws);
    });
    ws.on('close', (code: number) => {
      if (!isCurrent()) return;
      if (code === 1008) this.fatal = this.fatal ?? 'protocol'; // ポリシー違反（音声形式不正など）
      this.onSocketGone(ws);
    });
  }

  private onSocketGone(ws: WsLike): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.stopKeepAlive();
    if (this.stopped) return;
    if (this.fatal) {
      const kind = this.fatal;
      this.fail(kind, kind === 'auth_failed' ? 'Deepgram authentication failed' : 'Deepgram rejected the stream');
      return;
    }
    this.scheduleReconnect(this.pendingReason ?? 'network');
  }

  private scheduleReconnect(reason: RecognizerErrorKind): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempts++;
    if (this.attempts > this.o.maxReconnectAttempts) {
      this.fail(reason, `Deepgram reconnect gave up after ${this.o.maxReconnectAttempts} attempts`);
      return;
    }
    this.emitter.emit({ type: 'error', kind: reason, message: `Deepgram connection lost (${reason}); reconnecting`, fatal: false });
    this.setState('reconnecting', reason);
    const base = reason === 'rate_limited' ? this.o.reconnectBaseDelayMs * 4 : this.o.reconnectBaseDelayMs;
    const delay = Math.min(this.o.reconnectMaxDelayMs, base * 2 ** (this.attempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private fail(kind: RecognizerErrorKind, message: string): void {
    if (this._state === 'failed') return;
    this.clearTimers();
    const dropped = this.queue;
    this.queue = [];
    this.queuedMs = 0;
    if (dropped.length > 0) this.emitDrop(dropped, 'disconnected');
    this.emitter.emit({ type: 'error', kind, message, fatal: true });
    this.setState('failed', kind);
  }

  private onMessage(text: string, gen: number): void {
    const msg = parseDeepgramMessage(text);
    const receivedAt = this.now();
    if (msg.kind === 'results') {
      if (msg.transcript.length === 0 && !msg.isFinal) return; // 空の interim は捨てる
      const result = normalizeDeepgramResult(msg, {
        source: this.source,
        streamGeneration: gen,
        timeMap: this.timeMap,
        receivedAt,
      });
      this.emitter.emit({ type: 'result', result });
    } else if (msg.kind === 'utterance_end') {
      this.emitter.emit({
        type: 'utterance_end',
        source: this.source,
        streamGeneration: gen,
        lastWordEndMs: Math.round(this.timeMap.toSessionMs(msg.lastWordEnd * 1000)),
        receivedAt,
      });
    } else if (msg.kind === 'error') {
      this.emitter.emit({ type: 'error', kind: 'protocol', message: `Deepgram error message (${msg.code ?? 'unknown'})`, fatal: false });
    }
  }

  private enqueue(c: QueuedChunk): void {
    this.queue.push(c);
    this.queuedMs += c.meta.durationMs;
    const dropped: QueuedChunk[] = [];
    while (this.queuedMs > this.o.maxQueueMs && this.queue.length > 1) {
      const d = this.queue.shift()!;
      this.queuedMs -= d.meta.durationMs;
      dropped.push(d);
    }
    if (dropped.length > 0) this.emitDrop(dropped, this._state === 'open' ? 'backpressure' : 'disconnected');
  }

  private flush(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN || this.stopped) return;
    const maxBuffered = this.o.maxBufferedMs * BYTES_PER_MS;
    while (this.queue.length > 0) {
      if (ws.bufferedAmount > maxBuffered) {
        // 送信バッファが詰まっている: キューに残して少し後に再試行（キュー上限で古い音声を破棄）
        if (!this.flushTimer) {
          this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
          }, 50);
        }
        return;
      }
      const c = this.queue.shift()!;
      this.queuedMs -= c.meta.durationMs;
      try {
        ws.send(c.pcm);
      } catch {
        this.queue.unshift(c);
        this.queuedMs += c.meta.durationMs;
        return;
      }
      this.timeMap.add(c.meta.audioStartMs, c.meta.durationMs);
      this.lastSendAt = this.now();
      this.emitter.emit({ type: 'audio_sent', source: this.source, meta: c.meta, streamGeneration: this.gen });
    }
  }

  private emitDrop(chunks: QueuedChunk[], reason: 'backpressure' | 'disconnected' | 'stopped'): void {
    const fromMs = Math.min(...chunks.map((c) => c.meta.audioStartMs));
    const toMs = Math.max(...chunks.map((c) => c.meta.audioStartMs + c.meta.durationMs));
    const droppedMs = chunks.reduce((s, c) => s + c.meta.durationMs, 0);
    this.emitter.emit({ type: 'audio_dropped', source: this.source, fromMs, toMs, droppedMs, reason });
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    const period = Math.max(500, Math.floor(this.o.keepAliveMs / 2));
    this.keepAliveTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WS_OPEN) return;
      if (this.now() - this.lastSendAt >= this.o.keepAliveMs) {
        try {
          ws.send(JSON.stringify({ type: 'KeepAlive' }));
          this.lastSendAt = this.now();
        } catch {
          // ignore
        }
      }
    }, period);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private clearTimers(): void {
    this.stopKeepAlive();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.flushTimer = null;
    this.reconnectTimer = null;
  }

  private setState(state: RecognizerState, reason: RecognizerErrorKind | null): void {
    if (this._state === state && reason === null) return;
    this._state = state;
    this.emitter.emit({ type: 'state', state, streamGeneration: Math.max(0, this.gen), reason });
  }
}
