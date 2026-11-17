/**
 * Meet ページ内（MAIN world）での音声取得の司令塔。ブラウザ API は PageAudioDeps 越しに使う（テストで差し替え可能）。
 *
 * - REMOTE: Meet が受信している相手側の音声トラック（RTCPeerConnection の track イベント、受信中の receiver、
 *   ページ内 <audio> の srcObject）を集めて 1 系統に混ぜる。Meet 自身が再生しているので、こちらは聞くだけ
 *   （スピーカーへ二重に流さない・会議へ戻さない）。複数の相手も「会議側」1 系統（話者の推測はしない）。
 * - SELF: Meet のページに許可済みのマイクを、このアプリ用に別途取得する（Meet のミュートとは独立）。
 *   ページの許可を使うので、ブラウザの確認ダイアログは追加で出ない。
 * - 停止（stop.all）ではマイクのトラックを止め、処理を全て閉じる。相手側のトラックは Meet のものなので止めない。
 */
import type { CaptureSourceKey } from '../shared/runtime-messages';
import type { FromPage, ToPage } from './wire';

export interface TrackLike {
  readonly id: string;
  readonly kind: string;
  readonly readyState: string;
  stop(): void;
  addEventListener(type: 'ended', listener: () => void): void;
}
export interface StreamLike {
  getTracks(): TrackLike[];
}

/** 1 系統ぶんの処理（トラックを混ぜて 16kHz PCM16 にする）。実装は page-main.ts の WebAudio。 */
export interface AudioPipe {
  addTrack(t: TrackLike): void;
  removeTrack(t: TrackLike): void;
  setEnabled(enabled: boolean): void;
  close(): void;
}
export type PcmSink = (pcm: Int16Array, levelDb: number, inputSampleRate: number) => void;

export interface PageAudioDeps {
  createPipe(source: CaptureSourceKey, onPcm: PcmSink): AudioPipe;
  /** 既定のマイク（ページに許可済み）を取得。 */
  getMic(): Promise<StreamLike>;
  /** フック以外の経路で見つかる相手側トラック（receiver・<audio> の srcObject）。 */
  collectRemoteTracks(): TrackLike[];
  /** すべての pipe を閉じた後の後始末（AudioContext を閉じる）。 */
  closeAll(): void;
  emit(msg: FromPage): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const RESCAN_MS = 2000;

function errName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : 'Error';
}

export class PageAudio {
  private readonly remoteTracks = new Map<string, TrackLike>();
  private remote: AudioPipe | null = null;
  private self: AudioPipe | null = null;
  private selfStream: StreamLike | null = null;
  /** self.start と self.stop が交互に来たときに古い getUserMedia の結果を捨てるための番号。 */
  private selfGen = 0;
  private rescan: unknown = null;
  private lastReportedCount = 0;

  constructor(private readonly deps: PageAudioDeps) {}

  get remoteTrackCount(): number {
    return this.remoteTracks.size;
  }
  get capturingRemote(): boolean {
    return this.remote !== null;
  }
  get capturingSelf(): boolean {
    return this.self !== null;
  }

  /** RTCPeerConnection のフック等から呼ばれる。取得前でも記録だけはする（接続ボタンの表示判断に使う）。 */
  addRemoteTrack(t: TrackLike): void {
    if (t.kind !== 'audio' || t.readyState === 'ended' || this.remoteTracks.has(t.id)) return;
    this.remoteTracks.set(t.id, t);
    t.addEventListener('ended', () => this.removeRemoteTrack(t));
    this.remote?.addTrack(t);
    this.report();
  }

  private removeRemoteTrack(t: TrackLike): void {
    if (!this.remoteTracks.delete(t.id)) return;
    this.remote?.removeTrack(t);
  }

  private report(): void {
    if (this.remoteTracks.size === this.lastReportedCount) return;
    this.lastReportedCount = this.remoteTracks.size;
    this.deps.emit({ type: 'rtc.active', remoteTracks: this.remoteTracks.size });
  }

  private collect(): void {
    for (const t of this.deps.collectRemoteTracks()) this.addRemoteTrack(t);
  }

  handle(msg: ToPage): void {
    switch (msg.type) {
      case 'remote.start':
        return this.startRemote();
      case 'remote.enable':
        this.remote?.setEnabled(msg.enabled);
        return;
      case 'self.start':
        void this.startSelf();
        return;
      case 'self.stop':
        return this.stopSelf();
      case 'stop.all':
        return this.stopAll();
    }
  }

  private startRemote(): void {
    if (this.remote) return;
    try {
      this.remote = this.deps.createPipe('REMOTE', (pcm, levelDb, rate) =>
        this.deps.emit({ type: 'pcm', source: 'REMOTE', pcm, levelDb, inputSampleRate: rate }),
      );
    } catch (e) {
      this.deps.emit({ type: 'remote.error', name: errName(e) });
      return;
    }
    this.collect();
    for (const t of this.remoteTracks.values()) this.remote.addTrack(t);
    // 後から参加した相手・Meet がトラックを作り直した場合に備えて定期的に拾い直す
    this.rescan = this.deps.setInterval(() => this.collect(), RESCAN_MS);
  }

  private async startSelf(): Promise<void> {
    if (this.self || this.selfStream) return;
    const gen = ++this.selfGen;
    let stream: StreamLike;
    try {
      stream = await this.deps.getMic();
    } catch (e) {
      if (gen === this.selfGen) this.deps.emit({ type: 'self.error', name: errName(e) });
      return;
    }
    if (gen !== this.selfGen) {
      // 取得中に止められた: すぐ解放する
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    try {
      this.selfStream = stream;
      this.self = this.deps.createPipe('SELF', (pcm, levelDb, rate) =>
        this.deps.emit({ type: 'pcm', source: 'SELF', pcm, levelDb, inputSampleRate: rate }),
      );
      for (const t of stream.getTracks()) {
        t.addEventListener('ended', () => {
          if (this.selfStream === stream) {
            this.stopSelf();
            this.deps.emit({ type: 'self.error', name: 'track_ended' });
          }
        });
        this.self.addTrack(t);
      }
    } catch (e) {
      this.stopSelf();
      this.deps.emit({ type: 'self.error', name: errName(e) });
    }
  }

  private stopSelf(): void {
    this.selfGen++;
    this.self?.close();
    this.self = null;
    for (const t of this.selfStream?.getTracks() ?? []) t.stop();
    this.selfStream = null;
  }

  stopAll(): void {
    this.stopSelf();
    this.remote?.close();
    this.remote = null;
    if (this.rescan !== null) this.deps.clearInterval(this.rescan);
    this.rescan = null;
    this.deps.closeAll();
  }
}

// ---------------------------------------------------------------------------
// RTCPeerConnection のフック（document_start で Meet より先に入れる）
// ---------------------------------------------------------------------------

interface PcLike {
  addEventListener(type: 'track', l: (ev: { track: TrackLike }) => void): void;
  getReceivers?(): { track: TrackLike | null }[];
}

/**
 * window.RTCPeerConnection をプロキシで包み、作られた接続の受信トラックを onTrack へ渡す。
 * 接続の動作（引数・戻り値・instanceof・prototype）は変えない。作った接続の一覧も返す（receiver の再走査用）。
 */
export function installRtcHook(win: Record<string, unknown>, onTrack: (t: TrackLike) => void): { peers(): PcLike[] } {
  const peers = new Set<PcLike>();
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    const Orig = win[name] as (new (...a: unknown[]) => PcLike) | undefined;
    if (typeof Orig !== 'function' || (Orig as unknown as { __zerosysHooked?: boolean }).__zerosysHooked) continue;
    const Hooked = new Proxy(Orig, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget) as PcLike;
        try {
          peers.add(pc);
          pc.addEventListener('track', (ev) => {
            if (ev?.track) onTrack(ev.track);
          });
        } catch {
          /* フックに失敗しても Meet の動作は妨げない */
        }
        return pc;
      },
      get(target, prop, receiver) {
        if (prop === '__zerosysHooked') return true;
        return Reflect.get(target, prop, receiver);
      },
    });
    try {
      win[name] = Hooked;
    } catch {
      /* 書き換え不可なら諦める（<audio> の走査で拾う） */
    }
  }
  return {
    peers: () => {
      const out: PcLike[] = [];
      for (const p of peers) {
        const st = (p as { connectionState?: string }).connectionState;
        if (st === 'closed') peers.delete(p);
        else out.push(p);
      }
      return out;
    },
  };
}
