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

export const HEARTBEAT_TIMEOUT_MS = 10_000;
const HEARTBEAT_CHECK_MS = 2_000;
const LEVEL_EMIT_MS = 100;
const HELLO_TIMEOUT_MS = 5_000;
const SESSION_ID_TIMEOUT_MS = 10_000;
const END_WAIT_MS = 5_000;

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
  private socket: WsLike | null = null;
  private sender: BackpressureSender | null = null;
  private framers: Partial<Record<CaptureSourceKey, SourceFramer>> = {};
  private config: StartConfig | null = null;
  private sessionStartAt = 0;
  private levels: Record<CaptureSourceKey, number | null> = { SELF: null, REMOTE: null };
  private lastHeartbeat = 0;
  private timers = new Set<TimerId>();
  private intervals = new Set<TimerId>();
  private unsubDeviceChange: (() => void) | null = null;
  private waiters: { kind: 'ack' | 'session'; resolve: () => void; reject: (e: Error) => void }[] = [];
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
    this.lastHeartbeat = this.deps.now();
    this.every(() => {
      if (this.phase === 'stopped' || this.phase === 'idle') return;
      if (this.deps.now() - this.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) void this.stop('heartbeat_lost');
    }, HEARTBEAT_CHECK_MS);
    this.every(() => {
      this.deps.emit({ target: 'ui', type: 'levels', levels: { ...this.levels } });
    }, LEVEL_EMIT_MS);
  }

  heartbeat(): void {
    this.lastHeartbeat = this.deps.now();
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
  async armInPage(link: InPageLink): Promise<void> {
    if (this.phase === 'stopped') this.resetForReuse();
    if (this.selfStream || this.selfProc) this.disposeSelf();
    this.disposeRemote();
    this.inPage = link;
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

  /** Port が切れた（Meet のタブを閉じた・移動した・再読み込みした）。 */
  inPageLost(link: InPageLink): void {
    if (link !== this.inPage) return;
    this.inPage = null;
    this.onRemoteLost('tab_closed');
  }

  get inPageActive(): boolean {
    return this.inPage !== null;
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

  private waitFor(kind: 'ack' | 'session', ms: number): Promise<void> {
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

  private settle(kind: 'ack' | 'session' | 'all', err?: Error): void {
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
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    const opened = new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('ws_error'));
    });
    socket.onmessage = (ev) => this.onSocketMessage(ev.data);
    socket.onclose = (ev) => {
      if (this.wsState !== 'unauthorized') this.wsState = ev.code === 1008 ? 'unauthorized' : 'closed';
      this.settle('all', new Error('closed'));
      if (this.phase === 'ending') this.endResolve?.();
      else if (this.phase === 'live' || this.phase === 'connecting') void this.stop('connection_failed');
      this.publish();
    };
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
    this.flushGaps();
    this.sendJson({ type: 'session.end', exportRequested });
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
      this.sendJson({ type: 'session.end', exportRequested: false });
    }
    this.stopReason = reason;
    this.stopCapture();
    this.settle('all', new Error('stopped'));
    this.phase = 'stopped';
    this.sender = null;
    this.framers = {};
    for (const id of this.timers) this.deps.clearTimeout(id);
    this.timers.clear();
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
    if (this.sources.SELF === 'capturing' || this.sources.SELF === 'paused') this.sources.SELF = 'off';
    if (this.sources.REMOTE === 'capturing' || this.sources.REMOTE === 'armed' || this.sources.REMOTE === 'paused')
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
