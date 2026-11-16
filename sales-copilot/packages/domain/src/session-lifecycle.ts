import type { AudioSource, SessionLifecycleState, SessionMode } from '@sales-copilot/contracts';

export type LifecycleEvent = 'consent' | 'start_capture' | 'pause' | 'resume' | 'end';

export type TransitionResult =
  | { ok: true; from: SessionLifecycleState; to: SessionLifecycleState }
  | { ok: false; from: SessionLifecycleState; reason: 'invalid_transition' | 'consent_required' | 'already_ended' };

const TRANSITIONS: Record<SessionLifecycleState, Partial<Record<LifecycleEvent, SessionLifecycleState>>> = {
  idle: { consent: 'consented', end: 'ended' },
  consented: { start_capture: 'capturing', end: 'ended' },
  capturing: { pause: 'paused', end: 'ended' },
  paused: { resume: 'capturing', end: 'ended' },
  ended: {},
};

export interface ConsentInput {
  /** 外部送信を伴う開始の明示確認。true 以外は不可。 */
  consentConfirmed: boolean;
  mode: SessionMode;
  selfCaptureEnabled: boolean;
}

export type FrameRejectReason =
  | 'not_capturing'
  | 'session_mismatch'
  | 'self_capture_off'
  | 'stale_generation'
  | 'duplicate_or_old_sequence';

/**
 * セッションの状態機械（SPEC §3, §4-2, §14）。
 * idle → consented → capturing ⇄ paused → ended（終端。再開には新しいセッション）。
 * paused / ended では音声フレームの受理・転送、LLM 呼び出しを一切許可しない。
 */
export class SessionLifecycle {
  private s: SessionLifecycleState = 'idle';
  private _mode: SessionMode | null = null;
  private selfEnabled = false;
  private readonly lastSeq = new Map<string, { gen: number; seq: number }>();
  private readonly listeners = new Set<(from: SessionLifecycleState, to: SessionLifecycleState) => void>();

  constructor(readonly sessionId: string) {}

  get state(): SessionLifecycleState {
    return this.s;
  }

  get mode(): SessionMode | null {
    return this._mode;
  }

  get selfCaptureEnabled(): boolean {
    return this.selfEnabled;
  }

  /** 状態遷移の通知（後始末: track/WS/タイマー/生成要求/待機キュー）。 */
  onTransition(cb: (from: SessionLifecycleState, to: SessionLifecycleState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  consent(input: ConsentInput): TransitionResult {
    if (input.consentConfirmed !== true) return { ok: false, from: this.s, reason: 'consent_required' };
    const r = this.apply('consent');
    if (r.ok) {
      this._mode = input.mode;
      this.selfEnabled = input.selfCaptureEnabled;
    }
    return r;
  }

  startCapture(): TransitionResult {
    return this.apply('start_capture');
  }

  pause(): TransitionResult {
    return this.apply('pause');
  }

  resume(): TransitionResult {
    return this.apply('resume');
  }

  end(): TransitionResult {
    return this.apply('end');
  }

  /** 「自分の音声取得OFF」。会議側ミュートとは独立。 */
  setSelfCapture(enabled: boolean): void {
    if (this.s === 'ended') return;
    this.selfEnabled = enabled;
  }

  /** 音声取得・外部送信が動いてよい状態か。 */
  isActive(): boolean {
    return this.s === 'capturing';
  }

  canCallLlm(): boolean {
    return this.s === 'capturing';
  }

  canForwardToStt(source: AudioSource): boolean {
    if (this.s !== 'capturing') return false;
    if (source === 'SELF' && !this.selfEnabled) return false;
    return true;
  }

  /**
   * 音声フレームの受理判定。停止・一時停止後、自分側OFF時、古い世代・重複/逆行 sequence は拒否。
   */
  acceptAudioFrame(h: {
    sessionId: string;
    source: AudioSource;
    streamGeneration: number;
    sequence: number;
  }): { ok: true } | { ok: false; reason: FrameRejectReason } {
    if (this.s !== 'capturing') return { ok: false, reason: 'not_capturing' };
    if (h.sessionId !== this.sessionId) return { ok: false, reason: 'session_mismatch' };
    if (h.source === 'SELF' && !this.selfEnabled) return { ok: false, reason: 'self_capture_off' };
    const last = this.lastSeq.get(h.source);
    if (last) {
      if (h.streamGeneration < last.gen) return { ok: false, reason: 'stale_generation' };
      if (h.streamGeneration === last.gen && h.sequence <= last.seq) {
        return { ok: false, reason: 'duplicate_or_old_sequence' };
      }
    }
    this.lastSeq.set(h.source, { gen: h.streamGeneration, seq: h.sequence });
    return { ok: true };
  }

  private apply(ev: LifecycleEvent): TransitionResult {
    const from = this.s;
    if (from === 'ended') return { ok: false, from, reason: 'already_ended' };
    const to = TRANSITIONS[from][ev];
    if (!to) return { ok: false, from, reason: 'invalid_transition' };
    this.s = to;
    for (const l of this.listeners) l(from, to);
    return { ok: true, from, to };
  }
}
