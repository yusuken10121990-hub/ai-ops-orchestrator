import type { CaptureSource } from '@sales-copilot/contracts';
import {
  Emitter,
  type AudioChunkMeta,
  type NormalizedSttResult,
  type RecognizerEvent,
  type RecognizerState,
  type SpeechRecognizer,
} from './speech';

export interface FakeRecognizerOptions {
  source: CaptureSource;
  now?: () => number;
  /** true なら sendAudio で接続扱いになる（LIVE の代役）。OFFLINE 再生では音声を受け取らない。 */
  acceptAudio?: boolean;
}

/**
 * テスト・OFFLINE 用の認識器。外部へは一切送信しない。
 * 結果はテスト/再生ドライバーが emitResult で注入する。送信・接続の回数を記録する。
 */
export class FakeSpeechRecognizer implements SpeechRecognizer {
  readonly source: CaptureSource;
  readonly sent: AudioChunkMeta[] = [];
  connectCount = 0;
  private readonly emitter = new Emitter<RecognizerEvent>();
  private readonly now: () => number;
  private readonly acceptAudio: boolean;
  private _state: RecognizerState = 'idle';
  private gen = 0;
  private stopped = false;

  constructor(opts: FakeRecognizerOptions) {
    this.source = opts.source;
    this.now = opts.now ?? (() => Date.now());
    this.acceptAudio = opts.acceptAudio ?? true;
  }

  get state(): RecognizerState {
    return this._state;
  }

  get streamGeneration(): number {
    return this.gen;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  on(listener: (ev: RecognizerEvent) => void): () => void {
    return this.emitter.on(listener);
  }

  sendAudio(_pcm: Uint8Array, meta: AudioChunkMeta): boolean {
    if (this.stopped || !this.acceptAudio) return false;
    if (this._state === 'idle') this.open();
    this.sent.push(meta);
    this.emitter.emit({ type: 'audio_sent', source: this.source, meta, streamGeneration: this.gen });
    return true;
  }

  /** 再生ドライバー用: 接続済みにする（音声なしで結果を流す）。 */
  open(): void {
    if (this.stopped || this._state === 'open') return;
    this.connectCount++;
    this._state = 'open';
    this.emitter.emit({ type: 'state', state: 'open', streamGeneration: this.gen, reason: null });
  }

  /** 切断→再接続を模擬（世代を増やす）。 */
  simulateReconnect(): void {
    if (this.stopped) return;
    this.gen++;
    this.connectCount++;
    this._state = 'open';
    this.emitter.emit({ type: 'state', state: 'open', streamGeneration: this.gen, reason: null });
  }

  emitResult(r: Omit<NormalizedSttResult, 'source' | 'streamGeneration' | 'segmentKey' | 'receivedAt' | 'fromFinalize'> & {
    streamGeneration?: number;
    receivedAt?: number;
  }): boolean {
    if (this.stopped) return false;
    if (this._state !== 'open') this.open();
    const gen = r.streamGeneration ?? this.gen;
    const startMs = Math.round(r.startMs);
    this.emitter.emit({
      type: 'result',
      result: {
        source: this.source,
        streamGeneration: gen,
        isFinal: r.isFinal,
        speechFinal: r.isFinal && r.speechFinal,
        text: r.text,
        startMs,
        endMs: Math.round(r.endMs),
        segmentKey: `${this.source}|${gen}|${startMs}`,
        receivedAt: r.receivedAt ?? this.now(),
        fromFinalize: false,
      },
    });
    return true;
  }

  emitUtteranceEnd(lastWordEndMs: number): void {
    if (this.stopped) return;
    this.emitter.emit({ type: 'utterance_end', source: this.source, streamGeneration: this.gen, lastWordEndMs, receivedAt: this.now() });
  }

  emitError(kind: 'auth_failed' | 'rate_limited' | 'network' | 'not_configured', fatal: boolean): void {
    if (this.stopped) return;
    this.emitter.emit({ type: 'error', kind, message: `fake ${kind}`, fatal });
    if (fatal) {
      this._state = 'failed';
      this.emitter.emit({ type: 'state', state: 'failed', streamGeneration: this.gen, reason: kind });
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this._state = 'closed';
    this.emitter.emit({ type: 'state', state: 'closed', streamGeneration: this.gen, reason: null });
    this.emitter.clear();
  }
}
