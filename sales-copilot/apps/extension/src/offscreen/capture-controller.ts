/**
 * offscreen document 内の取得・送信の司令塔（SPEC §6, §14）。
 * ブラウザ API は CaptureDeps の小さなインターフェース越しに使い、停止・後始末をテストできるようにする。
 *
 * 保持するもの（全てこの文脈だけ）:
 * - REMOTE: tabCapture の streamId から得た会議タブの MediaStream。AudioContext の destination へ再生
 *   （取得するとタブ側の音が止まるため）し、同時に AudioWorklet で 16kHz PCM16 にする。
 * - SELF: 明示選択したマイクの MediaStream。worklet にだけ繋ぎ、スピーカー・会議へは流さない。
 * - サーバーとの WebSocket（hello → session.start → バイナリ音声フレーム）。
 */
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type CaptureSource,
  type ClientMessage,
  type SessionEndReason,
  type StatusReason,
} from '@sales-copilot/contracts';
import { SourceFramer } from '../audio/framer';
import { BackpressureSender, WS_OPEN, type AudioGap, type SocketLike } from '../audio/sender';
import type { FromOffscreenPort } from '../meet/wire';
import type {
  CaptureSourceKey,
  FromOffscreen,
  LocalSourceState,
  OffscreenSnapshot,
  StartConfig,
  StopReason,
  WsState,
} from '../shared/runtime-messages';

export const CLIENT_VERSION = '0.1.0';

/**
 * Meet ページ内取得（ワンタップ接続）との連絡口。実体は content script との runtime Port。
 * 音声は controller.inPagePcm() で入ってくる。
 */
export interface InPageLink {
  send(msg: FromOffscreenPort): void;
  close(): void;
}

export interface MediaTrackLike {
  readonly readyState: string;
  stop(): void;
  addEventListener(type: 'ended', listener: () => void): void;
}
export interface MediaStreamLike {
  getTracks(): MediaTrackLike[];
}
export interface ProcessorHandle {
  setEnabled(enabled: boolean): void;
  dispose(): void;
}
export type PcmListener = (pcm: Int16Array, levelDb: number) => void;
export interface AudioGraphLike {
  readonly sampleRate: number;
  /** 会議音声: 再生経路（destination）＋取得処理。 */
  attachRemote(stream: MediaStreamLike, onPcm: PcmListener): Promise<ProcessorHandle>;
  /** 自分のマイク: 取得処理のみ（destination へ繋がない）。 */
  attachSelf(stream: MediaStreamLike, onPcm: PcmListener): Promise<ProcessorHandle>;
  close(): Promise<void>;
}
export interface WsLike extends SocketLike {
  binaryType: string;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: (() => void) | null;
}
export type TimerId = unknown;
export interface CaptureDeps {
  getTabStream(streamId: string): Promise<MediaStreamLike>;
  getMicStream(deviceId: string | null): Promise<MediaStreamLike>;
  createGraph(): Promise<AudioGraphLike>;
  createSocket(url: string): WsLike;
  /** 単調増加時計（ms）。 */
  now(): number;
  setInterval(fn: () => void, ms: number): TimerId;
  clearInterval(id: TimerId): void;
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
  emit(msg: FromOffscreen): void;
  /** devicechange を購読し、解除関数を返す。 */
  onDeviceChange(cb: () => void): () => void;
  listAudioInputIds(): Promise<string[]>;
}

/**
 * 終了してよいのは「終了」ボタン・カンペ画面を閉じた・Meet のタブを閉じた・通話から退出した、の 4 つだけ。
 * 画面共有・タブ／ウィンドウの切替・一時的な切断では終わらせず、再接続して同じ商談を続ける
 * （2026-11-17 の実商談で、画面共有・切替のたびに商談が勝手に終わった）。
 *
 * 以前はカンペ画面の 2 秒ごとのハートビートが 10 秒途切れたら止めていたが、Chrome は隠れた・最小化した・
 * 他のウィンドウに覆われたページのタイマーを大きく間引く（5 分以上隠れると 1 分に 1 回）ため、
 * 画面共有や切替で見えなくなるだけで止まっていた。今はカンペ画面との Port（閉じたら確実に切れる）で見る。
 */
/** カンペ画面との Port がすべて切れてから終了とみなすまで（画面の再読み込み・一時的な切断を許す）。 */
export const UI_GRACE_MS = 20_000;
/** Meet のページとの Port が切れてから、再接続を待つ上限。 */
export const IN_PAGE_GRACE_MS = 45_000;
/** サーバーとの WS が切れてから再接続を試す上限（サーバー側の保持 SESSION_RESUME_GRACE_MS=60 秒より短く）。 */
export const WS_RESUME_MAX_MS = 55_000;
const WS_RETRY_BASE_MS = 500;
const WS_RETRY_MAX_MS = 5_000;
const LEVEL_EMIT_MS = 100;
const HELLO_TIMEOUT_MS = 5_000;
const SESSION_ID_TIMEOUT_MS = 10_000;
const END_WAIT_MS = 5_000;

/** 拡張側の停止理由 → サーバーへ伝える終了理由（会話の内容は含まない）。 */
export function endReasonOf(r: StopReason): SessionEndReason {
  switch (r) {
    case 'user_end':
    case 'window_closed':
    case 'tab_closed':
    case 'call_left':
    case 'meet_lost':
    case 'no_permission':
      return r;
    case 'heartbeat_lost':
      return 'window_closed';
    case 'track_ended':
      return 'meet_lost';
    case 'connection_failed':
      return 'connection_lost';
    default:
      return 'error';
  }
}

type Phase = OffscreenSnapshot['phase'];

function errName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
}

export function toWsUrl(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}

export class CaptureController {
  private phase: Phase = 'idle';
  private sources: Record<CaptureSourceKey, LocalSourceState> = { SELF: 'off', REMOTE: 'off' };
  private wsState: WsState = 'none';
  private paused = false;
  private selfEnabled = false;
  private sessionId: string | null = null;
  private stopReason: StopReason | null = null;

  private graph: AudioGraphLike | null = null;
  private remoteStream: MediaStreamLike | null = null;
  private remoteProc: ProcessorHandle | null = null;
  private selfStream: MediaStreamLike | null = null;
  private selfProc: ProcessorHandle | null = null;
  private inPage: InPageLink | null = null;
  /** ワンタップ接続した Meet のタブ（Port が切れても、同じタブからの再接続だけ受け付ける）。 */
  private inPageTabId: number | null = null;
  private inPageGrace: TimerId | null = null;
  /** カンペ画面との Port の数（0 になってから UI_GRACE_MS で終了）。 */
  private uiPorts = 0;
  private uiGrace: TimerId | null = null;
  private wsLostAt = 0;
  private resumeOk: boolean | null = null;
  private reconnectTimer: TimerId | null = null;
  private socket: WsLike | null = null;
  private sender: BackpressureSender | null = null;
  private framers: Partial<Record<CaptureSourceKey, SourceFramer>> = {};
  private config: StartConfig | null = null;
  private sessionStartAt = 0;
  private levels: Record<CaptureSourceKey, number | null> = { SELF: null, REMOTE: null };
  private timers = new Set<TimerId>();
  private intervals = new Set<TimerId>();
  private unsubDeviceChange: (() => void) | null = null;
  private waiters: { kind: 'ack' | 'session' | 'resume'; resolve: () => void; reject: (e: Error) => void }[] = [];
  private endResolve: (() => void) | null = null;

  constructor(private readonly deps: CaptureDeps) {}

  snapshot(): OffscreenSnapshot {
    return {
      phase: this.phase,
      sources: { ...this.sources },
      ws: this.wsState,
      paused: this.paused,
      selfEnabled: this.selfEnabled,
      sessionId: this.sessionId,
      inputSampleRate: this.graph?.sampleRate ?? null,
      stopReason: this.stopReason,
      reconnecting: this.wsState === 'reconnecting' || this.sources.REMOTE === 'reconnecting',
    };
  }

  /** 後始末の検査用。 */
  get activeTimerCount(): number {
    return this.timers.size + this.intervals.size;
  }

  private publish(): void {
    this.deps.emit({ target: 'ui', type: 'snapshot', snapshot: this.snapshot() });
  }

  private every(fn: () => void, ms: number): void {
    this.intervals.add(this.deps.setInterval(fn, ms));
  }

  private after(fn: () => void, ms: number): TimerId {
    const id = this.deps.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  private cancel(id: TimerId): void {
    if (this.timers.delete(id)) this.deps.clearTimeout(id);
  }

  private ensureLoops(): void {
    if (this.intervals.size > 0) return;
    this.every(() => {
      this.deps.emit({ target: 'ui', type: 'levels', levels: { ...this.levels } });
    }, LEVEL_EMIT_MS);
  }

  /** 互換用（古いカンペ画面が送ってくる）。止める判断には使わない（隠れたページのタイマーは間引かれるため）。 */
  heartbeat(): void {}

  // ------------------------------------------------------------------ カンペ画面との Port

  /** カンペ画面が開いた（Port がつながった）。 */
  uiConnected(): void {
    this.uiPorts++;
    if (this.uiGrace !== null) {
      this.cancel(this.uiGrace);
      this.uiGrace = null;
    }
  }

  /**
   * カンペ画面の Port が切れた。閉じたこと自体は service worker（windows.onRemoved）が即座に伝えるので、
   * ここは「閉じた通知が来ないまま画面が消えた」場合の保険。隠れた・最小化しただけでは Port は切れない。
   */
  uiDisconnected(): void {
    this.uiPorts = Math.max(0, this.uiPorts - 1);
    if (this.uiPorts > 0 || this.uiGrace !== null) return;
    if (this.phase === 'idle' || this.phase === 'stopped') return;
    this.uiGrace = this.after(() => {
      this.uiGrace = null;
      if (this.uiPorts === 0) void this.stop('window_closed');
    }, UI_GRACE_MS);
  }

  private async ensureGraph(): Promise<AudioGraphLike> {
    if (!this.graph) this.graph = await this.deps.createGraph();
    return this.graph;
  }

  // ------------------------------------------------------------------ REMOTE

  /** 会議タブの音声を取得（外部送信はまだ。音量確認と再生維持のみ）。 */
  async arm(streamId: string): Promise<void> {
    if (this.phase === 'stopped') this.resetForReuse();
    this.disposeRemote();
    try {
      const stream = await this.deps.getTabStream(streamId);
      const graph = await this.ensureGraph();
      this.remoteStream = stream;
      for (const t of stream.getTracks()) t.addEventListener('ended', () => this.onRemoteLost('track_ended'));
      this.remoteProc = await graph.attachRemote(stream, (pcm, db) => this.onPcm('REMOTE', pcm, db));
      this.sources.REMOTE = this.phase === 'live' ? 'capturing' : 'armed';
      if (this.phase === 'idle') this.phase = 'armed';
      this.ensureLoops();
    } catch (e) {
      this.sources.REMOTE = errName(e) === 'NotAllowedError' ? 'no_permission' : 'error';
      this.deps.emit({ target: 'ui', type: 'offscreen.error', message: '会議タブの音声を取得できませんでした' });
    }
    this.publish();
  }

  /** 会議タブが閉じられた（service worker から通知）。 */
  tabClosed(): void {
    if (this.inPageTabId !== null) {
      void this.stop('tab_closed');
      return;
    }
    this.onRemoteLost('tab_closed');
  }

  private onRemoteLost(reason: 'track_ended' | 'tab_closed'): void {
    if (this.phase === 'stopped') return;
    if (this.sources.REMOTE === 'tab_closed' || this.sources.REMOTE === 'track_ended') return;
    this.sources.REMOTE = reason;
    this.sendJson({ type: 'source.state', source: 'REMOTE', state: 'lost', reason });
    // SPEC §16-2: タブ終了・トラック終了で停止する。別タブへ勝手に切り替えない。
    void this.stop(reason);
  }

  private disposeRemote(): void {
    this.remoteProc?.dispose();
    this.remoteProc = null;
    const link = this.inPage;
    this.inPage = null;
    if (link) {
      link.send({ type: 'stop.all' });
      link.close();
    }
    for (const t of this.remoteStream?.getTracks() ?? []) t.stop();
    this.remoteStream = null;
    this.levels.REMOTE = null;
  }

  // ------------------------------------------------------------------ REMOTE（Meet ページ内取得）

  /** Meet ポップアップの「接続」: ページ内で取得した音声を受け取る（tabCapture の代わり）。 */
  async armInPage(link: InPageLink, tabId: number | null = null): Promise<void> {
    if (this.phase === 'stopped') this.resetForReuse();
    if (this.inPageGrace !== null) {
      this.cancel(this.inPageGrace);
      this.inPageGrace = null;
    }
    const resumed = this.phase === 'live' && this.sources.REMOTE === 'reconnecting';
    if (this.selfStream || this.selfProc) this.disposeSelf();
    this.disposeRemote();
    this.inPage = link;
    if (tabId !== null) this.inPageTabId = tabId;
    if (resumed) this.sendJson({ type: 'source.state', source: 'REMOTE', state: 'ok' });
    this.remoteProc = {
      setEnabled: (enabled) => link.send({ type: 'remote.enable', enabled }),
      dispose: () => {},
    };
    if (this.phase === 'live') {
      this.framers.REMOTE?.startGeneration(this.deps.now() - this.sessionStartAt);
      this.sources.REMOTE = this.paused ? 'paused' : 'capturing';
      if (this.paused) link.send({ type: 'remote.enable', enabled: false });
    } else {
      this.sources.REMOTE = 'armed';
    }
    if (this.phase === 'idle') this.phase = 'armed';
    this.ensureLoops();
    this.publish();
    if (this.phase === 'live' && this.selfEnabled && !this.paused) await this.startSelf();
  }

  /** ページ内取得の音声（16kHz PCM16）。接続中の Port から来たものだけ。 */
  inPagePcm(link: InPageLink, source: CaptureSource, pcm: Int16Array, levelDb: number): void {
    if (link !== this.inPage) return;
    if (source === 'SELF' && !this.selfProc) return;
    this.onPcm(source, pcm, levelDb);
  }

  /** ページ内のマイク・会議音声の取得エラー。 */
  inPageError(link: InPageLink, source: CaptureSource, name: string): void {
    if (link !== this.inPage) return;
    if (source === 'SELF') {
      const denied = name === 'NotAllowedError' || name === 'SecurityError';
      this.onSelfLost(denied ? 'no_permission' : name === 'track_ended' ? 'track_ended' : 'error');
      return;
    }
    this.sources.REMOTE = 'error';
    this.deps.emit({ target: 'ui', type: 'offscreen.error', message: '会議の音声を取得できませんでした（Meet のページを再読み込みしてもう一度接続してください）' });
    this.publish();
  }

  /**
   * Port が切れた。タブを閉じたなら service worker が tabClosed() を呼ぶ。ここでは終わらせずに
   * 「再接続中」にして、同じタブの content script からの再接続を IN_PAGE_GRACE_MS 待つ。
   */
  inPageLost(link: InPageLink): void {
    if (link !== this.inPage) return;
    this.inPage = null;
    this.remoteProc = null;
    if (this.phase === 'idle' || this.phase === 'stopped' || this.phase === 'ending') return;
    // ページ側のマイクもこの Port 越しだったので、いったん止まっている
    if (this.selfProc) {
      this.selfProc = null;
      this.levels.SELF = null;
      if (this.sources.SELF === 'capturing') this.sources.SELF = 'reconnecting';
    }
    this.levels.REMOTE = null;
    this.sources.REMOTE = 'reconnecting';
    this.sendJson({ type: 'source.state', source: 'REMOTE', state: 'lost', reason: 'reconnecting' });
    if (this.inPageGrace === null) {
      this.inPageGrace = this.after(() => {
        this.inPageGrace = null;
        if (!this.inPage) void this.stop('meet_lost');
      }, IN_PAGE_GRACE_MS);
    }
    this.publish();
  }

  /** Meet のページが「通話から退出した」と判断した（ページ内の移動・画面共有では来ない）。 */
  inPageCallLeft(link: InPageLink): void {
    if (link !== this.inPage) return;
    void this.stop('call_left');
  }

  get inPageActive(): boolean {
    return this.inPage !== null;
  }

  /** 同じ Meet のタブからの再接続を受け付けるか（商談中で、そのタブとの Port が切れている）。 */
  acceptsInPageReconnect(tabId: number): boolean {
    return this.inPageTabId === tabId && this.inPage === null && (this.phase === 'live' || this.phase === 'connecting' || this.phase === 'armed');
  }

  // ------------------------------------------------------------------ SELF

  private async startSelf(): Promise<void> {
    if (!this.config || this.phase !== 'live') return;
    this.disposeSelf();
    const link = this.inPage;
    if (link) {
      // ページ内取得: Meet のページに許可済みのマイクを使う（このタブで追加の確認は出ない）
      this.framers.SELF?.startGeneration(this.deps.now() - this.sessionStartAt);
      link.send({ type: 'self.start' });
      this.selfProc = { setEnabled: () => {}, dispose: () => link.send({ type: 'self.stop' }) };
      this.sources.SELF = 'capturing';
      this.sendJson({ type: 'source.state', source: 'SELF', state: 'on' });
      this.publish();
      return;
    }
    try {
      const stream = await this.deps.getMicStream(this.config.micDeviceId);
      if (this.phase !== 'live' || !this.selfEnabled || this.paused) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      const graph = await this.ensureGraph();
      this.selfStream = stream;
      for (const t of stream.getTracks()) t.addEventListener('ended', () => this.onSelfLost('track_ended'));
      this.framers.SELF?.startGeneration(this.deps.now() - this.sessionStartAt);
      this.selfProc = await graph.attachSelf(stream, (pcm, db) => this.onPcm('SELF', pcm, db));
      this.sources.SELF = 'capturing';
      this.sendJson({ type: 'source.state', source: 'SELF', state: 'on' });
      if (!this.unsubDeviceChange) this.unsubDeviceChange = this.deps.onDeviceChange(() => void this.checkDevice());
    } catch (e) {
      const denied = errName(e) === 'NotAllowedError' || errName(e) === 'SecurityError';
      this.onSelfLost(denied ? 'no_permission' : 'error');
    }
    this.publish();
  }

  private onSelfLost(state: 'track_ended' | 'device_changed' | 'no_permission' | 'error'): void {
    this.disposeSelf();
    this.sources.SELF = state;
    const reason: StatusReason =
      state === 'no_permission' ? 'no_permission' : state === 'device_changed' ? 'device_changed' : state === 'track_ended' ? 'track_ended' : 'source_lost';
    this.sendJson({ type: 'source.state', source: 'SELF', state: 'off', reason });
    this.publish();
  }

  private async checkDevice(): Promise<void> {
    if (!this.selfStream || !this.config?.micDeviceId) return;
    const ids = await this.deps.listAudioInputIds();
    if (!ids.includes(this.config.micDeviceId)) this.onSelfLost('device_changed');
  }

  private disposeSelf(): void {
    this.selfProc?.dispose();
    this.selfProc = null;
    for (const t of this.selfStream?.getTracks() ?? []) t.stop();
    this.selfStream = null;
    this.levels.SELF = null;
  }

  /** 「自分の音声取得OFF/ON」。Meet のミュートとは独立（連動しているふりをしない）。 */
  async setSelf(enabled: boolean): Promise<void> {
    this.selfEnabled = enabled;
    if (this.phase !== 'live') {
      this.publish();
      return;
    }
    if (!enabled) {
      this.disposeSelf();
      this.sources.SELF = 'user_off';
      this.sendJson({ type: 'source.state', source: 'SELF', state: 'off', reason: 'self_capture_off' });
      this.publish();
      return;
    }
    if (this.paused) {
      this.sources.SELF = 'paused';
      this.publish();
      return;
    }
    await this.startSelf();
  }

  // ------------------------------------------------------------------ PCM

  private onPcm(source: CaptureSource, pcm: Int16Array, levelDb: number): void {
    if (this.phase === 'stopped') return;
    this.levels[source] = levelDb;
    if (this.phase !== 'live' || this.paused || !this.sender) return;
    if (source === 'SELF' && (!this.selfEnabled || this.sources.SELF !== 'capturing')) return;
    const framer = this.framers[source];
    if (!framer) return;
    const { frames, vad } = framer.push(pcm);
    for (const f of frames) this.sender.send(f);
    for (const t of vad) this.sendJson({ type: 'speaking.state', source, speaking: t.speaking, atMs: t.atMs });
  }

  // ------------------------------------------------------------------ WS / session

  private sendJson(msg: ClientMessage): void {
    if (this.phase === 'stopped') return;
    const s = this.socket;
    if (s && s.readyState === WS_OPEN && this.wsState === 'open') s.send(JSON.stringify(msg));
  }

  private sendGap(gap: AudioGap): void {
    this.sendJson({ type: 'audio.gap', source: gap.source, fromMs: gap.fromMs, toMs: gap.toMs, reason: 'client_backpressure' });
  }

  /** 停止・終了の直前に、まだ閉じていない欠落区間を記録として送る。 */
  private flushGaps(): void {
    for (const g of this.sender?.flushOpenGaps() ?? []) this.sendGap(g);
  }

  /** UI からのクライアントメッセージ（手動ボタン・固定・フィードバック等）。 */
  sendClient(msg: ClientMessage): void {
    if (msg.type === 'hello' || msg.type === 'session.start' || msg.type === 'session.end') return;
    if (this.phase !== 'live') return;
    this.sendJson(msg);
  }

  private waitFor(kind: 'ack' | 'session' | 'resume', ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = this.after(() => reject(new Error(`${kind}_timeout`)), ms);
      this.waiters.push({
        kind,
        resolve: () => {
          this.cancel(id);
          resolve();
        },
        reject: (e) => {
          this.cancel(id);
          reject(e);
        },
      });
    });
  }

  private settle(kind: 'ack' | 'session' | 'resume' | 'all', err?: Error): void {
    const keep: typeof this.waiters = [];
    for (const w of this.waiters) {
      if (kind === 'all' || w.kind === kind) {
        if (err) w.reject(err);
        else w.resolve();
      } else keep.push(w);
    }
    this.waiters = keep;
  }

  private onSocketMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    const parsed = parseServerMessage(data);
    // 契約外・不正なメッセージは表示しない（途中文・不正データを描画しない）
    if (!parsed.ok) return;
    const m = parsed.message;
    if (m.type === 'hello.ack') this.settle('ack');
    if (m.type === 'session.resumed') {
      this.resumeOk = m.ok && m.sessionId === this.sessionId;
      this.settle('resume');
      return; // 内部のやりとり（UI へは snapshot で伝える）
    }
    if (m.type === 'status' && m.sessionId && !this.sessionId) {
      this.sessionId = m.sessionId;
      this.settle('session');
    }
    // 終了の確定は session.ended（出力の結果を含む）。status(ended) はその前に届くので、ここでは閉じない
    // （resolve の継続はマイクロタスクなので、下の UI への転送が先に行われる）
    if (m.type === 'session.ended' && this.phase === 'ending') this.endResolve?.();
    if (m.type === 'error' && m.code === 'unauthorized') {
      this.wsState = 'unauthorized';
      this.settle('all', new Error('unauthorized'));
    }
    this.deps.emit({ target: 'ui', type: 'server', message: m });
  }

  /** WS にハンドラを付ける。古い（置き換え済みの）WS からの通知は無視する。 */
  private wire(socket: WsLike): Promise<void> {
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    const opened = new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('ws_error'));
    });
    socket.onmessage = (ev) => {
      if (this.socket === socket) this.onSocketMessage(ev.data);
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      const unauthorized = this.wsState === 'unauthorized' || ev.code === 1008;
      this.settle('all', new Error('closed'));
      if (this.phase === 'ending') {
        this.wsState = unauthorized ? 'unauthorized' : 'closed';
        this.endResolve?.();
      } else if (this.phase === 'live' && !unauthorized) {
        // 商談中に切れた: 終わらせずに再接続して同じ商談を続ける
        if (this.wsState !== 'reconnecting') this.onSocketLost();
        return;
      } else {
        this.wsState = unauthorized ? 'unauthorized' : 'closed';
        if (this.phase === 'live' || this.phase === 'connecting') void this.stop('connection_failed');
      }
      this.publish();
    };
    return opened;
  }

  private onSocketLost(): void {
    this.flushGaps();
    this.sender?.disable();
    this.sender = null;
    this.socket = null;
    this.wsState = 'reconnecting';
    this.wsLostAt = this.deps.now();
    this.publish();
    this.scheduleReconnect(0);
  }

  private scheduleReconnect(attempt: number): void {
    if (this.phase !== 'live') return;
    const delay = Math.min(WS_RETRY_BASE_MS * 2 ** attempt, WS_RETRY_MAX_MS);
    if (this.deps.now() - this.wsLostAt + delay > WS_RESUME_MAX_MS) {
      void this.stop('connection_failed');
      return;
    }
    this.reconnectTimer = this.after(() => {
      this.reconnectTimer = null;
      void this.tryResume(attempt);
    }, delay);
  }

  /** 新しい WS で hello → session.resume。成功したら同じ商談の音声送信を続ける。 */
  private async tryResume(attempt: number): Promise<void> {
    const config = this.config;
    if (this.phase !== 'live' || !config || !this.sessionId) return;
    let socket: WsLike;
    try {
      socket = this.deps.createSocket(toWsUrl(config.serverUrl));
    } catch {
      this.scheduleReconnect(attempt + 1);
      return;
    }
    this.resumeOk = null;
    const opened = this.wire(socket);
    try {
      // 開きも失敗もしないまま止まった接続で待ち続けない
      await new Promise<void>((resolve, reject) => {
        const id = this.after(() => reject(new Error('open_timeout')), HELLO_TIMEOUT_MS);
        opened.then(
          () => {
            this.cancel(id);
            resolve();
          },
          (e: unknown) => {
            this.cancel(id);
            reject(e instanceof Error ? e : new Error('ws_error'));
          },
        );
      });
      const ack = this.waitFor('ack', HELLO_TIMEOUT_MS);
      socket.send(JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, clientVersion: CLIENT_VERSION, token: config.token }));
      await ack;
      const res = this.waitFor('resume', SESSION_ID_TIMEOUT_MS);
      socket.send(JSON.stringify({ type: 'session.resume', sessionId: this.sessionId }));
      await res;
    } catch {
      if ((this.phase as Phase) !== 'live' || this.socket !== socket) return;
      this.socket = null;
      try {
        socket.close(1000, 'retry');
      } catch {
        /* noop */
      }
      if (this.wsState === 'unauthorized') {
        await this.stop('connection_failed');
        return;
      }
      this.scheduleReconnect(attempt + 1);
      return;
    }
    if ((this.phase as Phase) !== 'live' || this.socket !== socket) return;
    if (!this.resumeOk) {
      // サーバーにもう商談が無い（猶予切れ・サーバー再起動）: 続けられない
      await this.stop('connection_failed');
      return;
    }
    this.wsState = 'open';
    this.sender = new BackpressureSender(socket, config.maxBufferedBytes, (gap, phase) => {
      this.deps.emit({ target: 'ui', type: 'gap', gap, phase });
      if (phase === 'end') this.sendGap(gap);
    });
    // 途切れた後の音声は新しい世代として送る（サーバーの順序検査に合わせる）
    const at = this.deps.now() - this.sessionStartAt;
    this.framers.REMOTE?.startGeneration(at);
    this.framers.SELF?.startGeneration(at);
    this.publish();
  }

  /** 明示確認後の開始。hello → session.start → sessionId 受領後に音声送信を始める。 */
  async start(config: StartConfig): Promise<void> {
    if (this.phase === 'live' || this.phase === 'connecting' || this.phase === 'ending') return;
    if (this.phase === 'stopped') this.resetForReuse();
    this.config = config;
    this.selfEnabled = config.start.selfCaptureEnabled;
    this.phase = 'connecting';
    this.wsState = 'connecting';
    this.ensureLoops();
    this.publish();
    let socket: WsLike;
    try {
      socket = this.deps.createSocket(toWsUrl(config.serverUrl));
    } catch {
      await this.stop('connection_failed');
      return;
    }
    const opened = this.wire(socket);
    try {
      await opened;
      this.wsState = 'open';
      // トークンは URL クエリではなく最初のメッセージで渡す（SPEC §14）。
      const ack = this.waitFor('ack', HELLO_TIMEOUT_MS);
      socket.send(
        JSON.stringify({ type: 'hello', protocolVersion: PROTOCOL_VERSION, clientVersion: CLIENT_VERSION, token: config.token }),
      );
      await ack;
      const sess = this.waitFor('session', SESSION_ID_TIMEOUT_MS);
      socket.send(JSON.stringify({ type: 'session.start', ...config.start }));
      await sess;
    } catch {
      if ((this.phase as Phase) !== 'stopped') await this.stop('connection_failed');
      return;
    }
    if ((this.phase as Phase) !== 'connecting' || !this.sessionId) return;
    this.sender = new BackpressureSender(socket, config.maxBufferedBytes, (gap, phase) => {
      this.deps.emit({ target: 'ui', type: 'gap', gap, phase });
      // 欠落区間が閉じたら（＝区間が確定したら）サーバーへ記録を送る。破棄した音声は再送しない。
      if (phase === 'end') this.sendGap(gap);
    });
    this.sessionStartAt = this.deps.now();
    this.framers = {
      REMOTE: new SourceFramer(this.sessionId, 'REMOTE', config.frameMs, false),
      SELF: new SourceFramer(this.sessionId, 'SELF', config.frameMs, true),
    };
    this.phase = 'live';
    if (this.remoteProc) {
      this.framers.REMOTE!.startGeneration(0);
      this.sources.REMOTE = 'capturing';
    }
    if (this.selfEnabled) await this.startSelf();
    else {
      this.sources.SELF = 'user_off';
      this.sendJson({ type: 'source.state', source: 'SELF', state: 'off', reason: 'self_capture_off' });
    }
    this.publish();
  }

  /** 解析一時停止: 送信・STT・LLM を止める。会議音声の再生は続ける。マイクは解放する。 */
  async setPaused(paused: boolean): Promise<void> {
    if (this.phase !== 'live' || this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.sendJson({ type: 'analysis.pause' });
      this.remoteProc?.setEnabled(false);
      if (this.sources.REMOTE === 'capturing') this.sources.REMOTE = 'paused';
      if (this.selfStream || this.selfProc) {
        this.disposeSelf();
        this.sources.SELF = 'paused';
      }
    } else {
      this.sendJson({ type: 'analysis.resume' });
      if (this.remoteProc) {
        this.remoteProc.setEnabled(true);
        this.framers.REMOTE?.startGeneration(this.deps.now() - this.sessionStartAt);
        this.sources.REMOTE = 'capturing';
      }
      if (this.selfEnabled) await this.startSelf();
    }
    this.publish();
  }

  /** ユーザーの「終了」。取得を即停止し、サーバーの終了処理（任意の出力）を短時間待ってから閉じる。 */
  async end(exportRequested: boolean): Promise<void> {
    if (this.phase !== 'live') {
      await this.stop('user_end');
      return;
    }
    if (this.wsState !== 'open') {
      // 再接続中に終了: 送れないのでそのまま止める（サーバーは猶予切れで終了する）
      await this.stop('user_end');
      return;
    }
    this.flushGaps();
    this.sendJson({ type: 'session.end', exportRequested, reason: 'user_end' });
    this.phase = 'ending';
    this.stopCapture();
    this.publish();
    await new Promise<void>((resolve) => {
      this.endResolve = resolve;
      this.after(resolve, END_WAIT_MS);
    });
    this.endResolve = null;
    await this.stop('user_end');
  }

  private stopCapture(): void {
    this.sender?.disable();
    this.disposeSelf();
    this.disposeRemote();
  }

  /** 全停止（冪等）。トラック停止・AudioContext 終了・WS 切断・タイマー解除。 */
  async stop(reason: StopReason): Promise<void> {
    if (this.phase === 'stopped') return;
    const wasLive = this.phase === 'live' || this.phase === 'connecting';
    if (wasLive && this.wsState === 'open') {
      this.flushGaps();
      this.sendJson({ type: 'session.end', exportRequested: false, reason: endReasonOf(reason) });
    }
    this.stopReason = reason;
    this.stopCapture();
    this.settle('all', new Error('stopped'));
    this.phase = 'stopped';
    this.sender = null;
    this.framers = {};
    for (const id of this.timers) this.deps.clearTimeout(id);
    this.timers.clear();
    this.inPageGrace = null;
    this.uiGrace = null;
    this.reconnectTimer = null;
    this.inPageTabId = null;
    for (const id of this.intervals) this.deps.clearInterval(id);
    this.intervals.clear();
    this.unsubDeviceChange?.();
    this.unsubDeviceChange = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onmessage = null;
      s.onclose = null;
      s.onerror = null;
      s.onopen = null;
      try {
        s.close(1000, 'client_stop');
      } catch {
        /* already closed */
      }
      if (this.wsState !== 'unauthorized') this.wsState = 'closed';
    }
    const g = this.graph;
    this.graph = null;
    if (g) await g.close().catch(() => {});
    if (this.sources.SELF === 'capturing' || this.sources.SELF === 'paused' || this.sources.SELF === 'reconnecting') this.sources.SELF = 'off';
    if (
      this.sources.REMOTE === 'capturing' ||
      this.sources.REMOTE === 'armed' ||
      this.sources.REMOTE === 'paused' ||
      this.sources.REMOTE === 'reconnecting'
    )
      this.sources.REMOTE = 'off';
    this.publish();
    this.deps.emit({ target: 'sw', type: 'offscreen.stopped', reason });
  }

  private resetForReuse(): void {
    this.phase = 'idle';
    this.sources = { SELF: 'off', REMOTE: 'off' };
    this.wsState = 'none';
    this.paused = false;
    this.sessionId = null;
    this.stopReason = null;
    this.config = null;
  }
}
