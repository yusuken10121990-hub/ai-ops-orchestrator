import { describe, expect, it } from 'vitest';
import { decodeAudioFrame } from '@sales-copilot/contracts';
import {
  CaptureController,
  IN_PAGE_GRACE_MS,
  UI_GRACE_MS,
  WS_RESUME_MAX_MS,
  endReasonOf,
  toWsUrl,
  type AudioGraphLike,
  type CaptureDeps,
  type MediaStreamLike,
  type MediaTrackLike,
  type PcmListener,
  type ProcessorHandle,
  type WsLike,
  type InPageLink,
} from './capture-controller';
import type { FromOffscreenPort } from '../meet/wire';
import type { FromOffscreen, StartConfig } from '../shared/runtime-messages';

class FakeTrack implements MediaTrackLike {
  readyState = 'live';
  private listeners: (() => void)[] = [];
  constructor(readonly kind: string) {}
  stop(): void {
    this.readyState = 'ended';
  }
  addEventListener(_t: 'ended', l: () => void): void {
    this.listeners.push(l);
  }
  fireEnded(): void {
    this.readyState = 'ended';
    for (const l of this.listeners) l();
  }
}
class FakeStream implements MediaStreamLike {
  tracks: FakeTrack[];
  constructor(kind: string) {
    this.tracks = [new FakeTrack(kind)];
  }
  getTracks() {
    return this.tracks;
  }
}
class FakeProc implements ProcessorHandle {
  enabled = true;
  disposed = false;
  constructor(readonly onPcm: PcmListener) {}
  setEnabled(e: boolean): void {
    this.enabled = e;
  }
  dispose(): void {
    this.disposed = true;
  }
}
class FakeGraph implements AudioGraphLike {
  sampleRate = 48000;
  closed = false;
  remote: FakeProc[] = [];
  self: FakeProc[] = [];
  /** destination へ繋いだ系統（再生経路）。SELF は決して含まれないこと。 */
  playback: string[] = [];
  async attachRemote(_s: MediaStreamLike, cb: PcmListener) {
    const p = new FakeProc(cb);
    this.remote.push(p);
    this.playback.push('REMOTE');
    return p;
  }
  async attachSelf(_s: MediaStreamLike, cb: PcmListener) {
    const p = new FakeProc(cb);
    this.self.push(p);
    return p;
  }
  async close() {
    this.closed = true;
  }
}
class FakeWs implements WsLike {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sentJson: { type: string; [k: string]: unknown }[] = [];
  sentBinary: Uint8Array[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(d: string | ArrayBufferLike | Uint8Array): void {
    if (typeof d === 'string') this.sentJson.push(JSON.parse(d));
    else this.sentBinary.push(d as Uint8Array);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  serverSend(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

function setup() {
  let t = 0;
  const timers = new Map<number, { fn: () => void; at: number; every?: number }>();
  let nextId = 1;
  const emitted: FromOffscreen[] = [];
  const graph = new FakeGraph();
  const sockets: FakeWs[] = [];
  const micStreams: FakeStream[] = [];
  const tabStreams: FakeStream[] = [];
  let micDenied = false;
  let devices = ['mic-1'];
  let deviceCb: (() => void) | null = null;
  const deps: CaptureDeps = {
    async getTabStream() {
      const s = new FakeStream('tab');
      tabStreams.push(s);
      return s;
    },
    async getMicStream() {
      if (micDenied) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      const s = new FakeStream('mic');
      micStreams.push(s);
      return s;
    },
    async createGraph() {
      return graph;
    },
    createSocket(url) {
      const ws = new FakeWs(url);
      sockets.push(ws);
      return ws;
    },
    now: () => t,
    setInterval(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: t + ms, every: ms });
      return id;
    },
    clearInterval(id) {
      timers.delete(id as number);
    },
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
    emit: (m) => emitted.push(m),
    onDeviceChange(cb) {
      deviceCb = cb;
      return () => {
        deviceCb = null;
      };
    },
    async listAudioInputIds() {
      return devices;
    },
  };
  const ctl = new CaptureController(deps);
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, v] = due;
      t = v.at;
      if (v.every) v.at += v.every;
      else timers.delete(id);
      v.fn();
    }
    t = end;
  };
  return {
    ctl,
    graph,
    sockets,
    micStreams,
    tabStreams,
    emitted,
    timers,
    advance,
    denyMic: () => (micDenied = true),
    setDevices: (d: string[]) => (devices = d),
    fireDeviceChange: () => deviceCb?.(),
  };
}

const config: StartConfig = {
  serverUrl: 'http://127.0.0.1:8787',
  token: 'x'.repeat(40),
  frameMs: 100,
  micDeviceId: 'mic-1',
  maxBufferedBytes: 128 * 1024,
  start: {
    purpose: '業務診断',
    appliedFacts: [],
    mode: 'OFFLINE',
    selfCaptureEnabled: true,
    consentConfirmed: true,
    storage: 'memory_only',
  },
};

const flush = () => new Promise((r) => setTimeout(r, 0));

async function startLive(env: ReturnType<typeof setup>, arm?: () => Promise<void>) {
  await (arm ? arm() : env.ctl.arm('stream-1'));
  const p = env.ctl.start(config);
  await flush();
  const ws = env.sockets[0]!;
  ws.readyState = 1;
  ws.onopen?.();
  await flush();
  ws.serverSend({ type: 'hello.ack', protocolVersion: 1, serverVersion: 't' });
  await flush();
  ws.serverSend({
    type: 'status',
    sessionId: 'sess-1',
    lifecycle: 'capturing',
    mode: 'OFFLINE',
    externalSending: false,
    storage: 'memory_only',
    pipelines: {
      capture: {
        SELF: { state: 'active', reason: null, since: 0 },
        REMOTE: { state: 'active', reason: null, since: 0 },
      },
      stt: { state: 'idle', reason: null, since: 0 },
      advice: { state: 'idle', reason: null, since: 0 },
    },
    at: 1,
  });
  await p;
  return ws;
}

describe('CaptureController', () => {
  it('WS URL は /ws でトークンをクエリに載せない', () => {
    expect(toWsUrl('http://127.0.0.1:8787/')).toBe('ws://127.0.0.1:8787/ws');
  });

  it('開始前（armed）は音量だけ表示し、外部へは何も送らない', async () => {
    const env = setup();
    await env.ctl.arm('stream-1');
    env.graph.remote[0]!.onPcm(new Int16Array(1600), -30);
    expect(env.sockets).toHaveLength(0);
    expect(env.ctl.snapshot()).toMatchObject({ phase: 'armed', sources: { REMOTE: 'armed' } });
    expect(env.graph.playback).toEqual(['REMOTE']);
  });

  it('hello はトークンを最初のメッセージで送り、sessionId 受領後に REMOTE/SELF を別系統で送る', async () => {
    const env = setup();
    const ws = await startLive(env);
    expect(ws.url).toBe('ws://127.0.0.1:8787/ws');
    expect(ws.sentJson[0]).toMatchObject({ type: 'hello', token: config.token });
    expect(ws.sentJson[1]).toMatchObject({ type: 'session.start', consentConfirmed: true, mode: 'OFFLINE' });
    env.graph.remote[0]!.onPcm(new Int16Array(1600), -20);
    env.graph.self[0]!.onPcm(new Int16Array(1600), -20);
    const headers = ws.sentBinary.map((b) => decodeAudioFrame(b).header);
    expect(headers.map((h) => h.source).sort()).toEqual(['REMOTE', 'SELF']);
    expect(headers.every((h) => h.sessionId === 'sess-1' && h.sampleRate === 16000)).toBe(true);
    // 自分のマイクは再生経路に繋がない
    expect(env.graph.playback).toEqual(['REMOTE']);
  });

  it('終了（stop）でトラック停止・WS切断・タイマー解除・AudioContext終了、以降は送信しない', async () => {
    const env = setup();
    const ws = await startLive(env);
    const remoteProc = env.graph.remote[0]!;
    const selfProc = env.graph.self[0]!;
    await env.ctl.stop('window_closed');
    expect(env.tabStreams[0]!.tracks.every((t) => t.readyState === 'ended')).toBe(true);
    expect(env.micStreams[0]!.tracks.every((t) => t.readyState === 'ended')).toBe(true);
    expect(remoteProc.disposed && selfProc.disposed).toBe(true);
    expect(ws.closed).toBe(true);
    expect(env.graph.closed).toBe(true);
    expect(env.ctl.activeTimerCount).toBe(0);
    expect(env.timers.size).toBe(0);
    expect(ws.sentJson.at(-1)).toMatchObject({ type: 'session.end', exportRequested: false });
    const before = ws.sentBinary.length + ws.sentJson.length;
    remoteProc.onPcm(new Int16Array(3200), -20);
    selfProc.onPcm(new Int16Array(3200), -20);
    env.ctl.sendClient({ type: 'analysis.pause' });
    expect(ws.sentBinary.length + ws.sentJson.length).toBe(before);
    expect(env.emitted.some((m) => m.type === 'offscreen.stopped')).toBe(true);
  });

  it('カンペ画面が隠れて（画面共有・ウィンドウ切替）ハートビートが来なくても止めない', async () => {
    const env = setup();
    await startLive(env);
    env.ctl.uiConnected();
    env.ctl.heartbeat();
    env.advance(10 * 60_000); // 10 分間タイマーが間引かれても
    await flush();
    expect(env.ctl.snapshot()).toMatchObject({ phase: 'live', stopReason: null });
  });

  it('カンペ画面との Port が全部切れて UI_GRACE_MS 戻らなければ window_closed で止める（再読み込みは許す）', async () => {
    const env = setup();
    const ws = await startLive(env);
    env.ctl.uiConnected();
    env.ctl.uiDisconnected();
    env.advance(UI_GRACE_MS - 1000);
    env.ctl.uiConnected(); // 画面の再読み込みでつながり直した
    env.advance(UI_GRACE_MS * 2);
    await flush();
    expect(env.ctl.snapshot().phase).toBe('live');
    env.ctl.uiDisconnected();
    env.advance(UI_GRACE_MS + 10);
    await flush();
    expect(env.ctl.snapshot()).toMatchObject({ phase: 'stopped', stopReason: 'window_closed' });
    expect(ws.sentJson).toContainEqual({ type: 'session.end', exportRequested: false, reason: 'window_closed' });
  });

  it('WS が切れても終わらせず「再接続中」→ 新しい WS で hello → session.resume → 同じ商談の音声を新しい世代で送る', async () => {
    const env = setup();
    const ws = await startLive(env);
    env.graph.remote[0]!.onPcm(new Int16Array(1600), -20);
    const gen0 = decodeAudioFrame(ws.sentBinary[0]!).header.streamGeneration;
    ws.readyState = 3;
    ws.onclose?.({ code: 1006 });
    expect(env.ctl.snapshot()).toMatchObject({ phase: 'live', ws: 'reconnecting', reconnecting: true });
    env.advance(600);
    await flush();
    const ws2 = env.sockets[1]!;
    expect(ws2).toBeDefined();
    ws2.readyState = 1;
    ws2.onopen?.();
    await flush();
    expect(ws2.sentJson[0]).toMatchObject({ type: 'hello', token: config.token });
    ws2.serverSend({ type: 'hello.ack', protocolVersion: 1, serverVersion: 't' });
    await flush();
    expect(ws2.sentJson[1]).toEqual({ type: 'session.resume', sessionId: 'sess-1' });
    ws2.serverSend({ type: 'session.resumed', sessionId: 'sess-1', ok: true });
    await flush();
    await flush();
    expect(env.ctl.snapshot()).toMatchObject({ phase: 'live', ws: 'open', reconnecting: false, sessionId: 'sess-1' });
    env.graph.remote[0]!.onPcm(new Int16Array(1600), -20);
    const h = decodeAudioFrame(ws2.sentBinary[0]!).header;
    expect(h.sessionId).toBe('sess-1');
    expect(h.streamGeneration).toBeGreaterThan(gen0);
    expect(h.sequence).toBe(0);
  });

  it('再接続はバックオフで繰り返し、WS_RESUME_MAX_MS を超えたら connection_failed で止める', async () => {
    const env = setup();
    const ws = await startLive(env);
    ws.readyState = 3;
    ws.onclose?.({ code: 1006 });
    for (let i = 0; i < 40 && env.ctl.snapshot().phase === 'live'; i++) {
      env.advance(1000);
      await flush();
      const last = env.sockets.at(-1)!;
      if (last !== ws && last.readyState === 0) {
        last.readyState = 3;
        last.onerror?.();
        await flush();
      }
    }
    env.advance(WS_RESUME_MAX_MS);
    await flush();
    expect(env.sockets.length).toBeGreaterThan(3);
    expect(env.ctl.snapshot()).toMatchObject({ phase: 'stopped', stopReason: 'connection_failed' });
  });

  it('サーバーにもう商談が無い（session.resumed ok=false）なら止める', async () => {
    const env = setup();
    const ws = await startLive(env);
    ws.readyState = 3;
    ws.onclose?.({ code: 1006 });
    env.advance(600);
    await flush();
    const ws2 = env.sockets[1]!;
    ws2.readyState = 1;
    ws2.onopen?.();
    await flush();
    ws2.serverSend({ type: 'hello.ack', protocolVersion: 1, serverVersion: 't' });
    await flush();
    ws2.serverSend({ type: 'session.resumed', sessionId: 'sess-1', ok: false });
    await flush();
    await flush();
    expect(env.ctl.snapshot()).toMatchObject({ phase: 'stopped', stopReason: 'connection_failed' });
  });

  it('停止理由 → サーバーへ送る終了理由', () => {
    expect(endReasonOf('user_end')).toBe('user_end');
    expect(endReasonOf('call_left')).toBe('call_left');
    expect(endReasonOf('connection_failed')).toBe('connection_lost');
    expect(endReasonOf('heartbeat_lost')).toBe('window_closed');
  });

  it('会議タブのトラック終了で lost を通知して停止（別タブへ切り替えない）', async () => {
    const env = setup();
    const ws = await startLive(env);
    env.tabStreams[0]!.tracks[0]!.fireEnded();
    await flush();
    expect(ws.sentJson.some((m) => m.type === 'source.state' && m.source === 'REMOTE' && m.state === 'lost')).toBe(true);
    expect(env.ctl.snapshot().phase).toBe('stopped');
  });

  it('自分の音声取得OFF はマイクを解放し、ON で streamGeneration を増やして再取得', async () => {
    const env = setup();
    const ws = await startLive(env);
    await env.ctl.setSelf(false);
    expect(env.micStreams[0]!.tracks[0]!.readyState).toBe('ended');
    expect(ws.sentJson.at(-1)).toMatchObject({ type: 'source.state', source: 'SELF', state: 'off', reason: 'self_capture_off' });
    await env.ctl.setSelf(true);
    env.graph.self[1]!.onPcm(new Int16Array(1600), -20);
    const selfHeaders = ws.sentBinary.map((b) => decodeAudioFrame(b).header).filter((h) => h.source === 'SELF');
    expect(selfHeaders.at(-1)).toMatchObject({ streamGeneration: 1, sequence: 0 });
  });

  it('マイク権限なしは SELF=no_permission として区別して通知', async () => {
    const env = setup();
    env.denyMic();
    const ws = await startLive(env);
    expect(env.ctl.snapshot().sources.SELF).toBe('no_permission');
    expect(ws.sentJson.some((m) => m.type === 'source.state' && m.reason === 'no_permission')).toBe(true);
  });

  it('選択マイクが外れたら device_changed', async () => {
    const env = setup();
    await startLive(env);
    env.setDevices([]);
    env.fireDeviceChange();
    await flush();
    expect(env.ctl.snapshot().sources.SELF).toBe('device_changed');
  });

  it('解析一時停止中は音声フレームを送らない', async () => {
    const env = setup();
    const ws = await startLive(env);
    await env.ctl.setPaused(true);
    const n = ws.sentBinary.length;
    env.graph.remote[0]!.onPcm(new Int16Array(3200), -20);
    expect(ws.sentBinary.length).toBe(n);
    expect(ws.sentJson.some((m) => m.type === 'analysis.pause')).toBe(true);
    await env.ctl.setPaused(false);
    env.graph.remote[0]!.onPcm(new Int16Array(1600), -20);
    expect(decodeAudioFrame(ws.sentBinary.at(-1)!).header.streamGeneration).toBe(1);
  });

  it('不正なサーバーメッセージは UI へ流さない', async () => {
    const env = setup();
    const ws = await startLive(env);
    const n = env.emitted.filter((m) => m.type === 'server').length;
    ws.serverSend({ type: 'advice.card', card: { say: '<b>途中' } });
    ws.onmessage?.({ data: 'not json' });
    expect(env.emitted.filter((m) => m.type === 'server').length).toBe(n);
  });

  it('終了は session.ended を待ち、出力結果を UI に渡してから閉じる（status ended だけでは閉じない）', async () => {
    const env = setup();
    const ws = await startLive(env);
    const p = env.ctl.end(true);
    expect(ws.sentJson.at(-1)).toMatchObject({ type: 'session.end', exportRequested: true });
    const now = Date.now();
    const idle = { state: 'idle', reason: 'session_ended', since: now };
    ws.serverSend({
      type: 'status',
      sessionId: 'sess-1',
      lifecycle: 'ended',
      mode: 'LIVE',
      externalSending: false,
      storage: 'memory_only',
      pipelines: { capture: { SELF: idle, REMOTE: idle }, stt: idle, advice: idle },
      at: now,
    });
    await flush();
    expect(ws.closed).toBe(false);
    const ended = { type: 'session.ended', sessionId: 'sess-1', exportPath: 'C:/exports/a.json', reviewAvailableUntil: now + 600_000 };
    ws.serverSend(ended);
    await p;
    expect(env.emitted).toContainEqual({ target: 'ui', type: 'server', message: ended });
    expect(ws.closed).toBe(true);
  });

  it('契約外の旧メッセージ（session.exported）は無視する', async () => {
    const env = setup();
    const ws = await startLive(env);
    const n = env.emitted.length;
    ws.serverSend({ type: 'session.exported', saved: true, path: 'C:/x' });
    expect(env.emitted.slice(n).filter((m) => m.type === 'server')).toEqual([]);
  });

  it('送信待ちあふれの欠落区間は audio.gap で送り（source.state の流用はしない）、終了時に未確定の区間も送る', async () => {
    const env = setup();
    const ws = await startLive(env);
    const before = ws.sentJson.length;
    ws.bufferedAmount = 10 * 1024 * 1024;
    env.graph.remote[0]!.onPcm(new Int16Array(3200), -20); // 200ms 分 → 破棄
    ws.bufferedAmount = 0;
    env.graph.remote[0]!.onPcm(new Int16Array(3200), -20); // 復旧 → 区間確定
    const gaps = ws.sentJson.slice(before).filter((m) => m.type === 'audio.gap');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ source: 'REMOTE', reason: 'client_backpressure' });
    expect((gaps[0]!.toMs as number) - (gaps[0]!.fromMs as number)).toBeGreaterThan(0);
    expect(ws.sentJson.some((m) => m.type === 'source.state' && m.reason === 'backpressure_drop')).toBe(false);
    ws.bufferedAmount = 10 * 1024 * 1024;
    env.graph.remote[0]!.onPcm(new Int16Array(3200), -20); // 再び破棄（未確定のまま終了）
    void env.ctl.end(false);
    const after = ws.sentJson.filter((m) => m.type === 'audio.gap');
    expect(after).toHaveLength(2);
    expect(ws.sentJson.findIndex((m) => m === after[1])).toBeLessThan(ws.sentJson.findIndex((m) => m.type === 'session.end'));
  });
});

class FakeLink implements InPageLink {
  sent: FromOffscreenPort[] = [];
  closed = false;
  send(m: FromOffscreenPort): void {
    if (!this.closed) this.sent.push(m);
  }
  close(): void {
    this.closed = true;
  }
  types(): string[] {
    return this.sent.map((m) => m.type + ('enabled' in m ? `:${m.enabled}` : ''));
  }
}

describe('CaptureController — Meet ページ内取得（ワンタップ接続）', () => {
  it('接続直後（開始前）は音量だけ・送信しない。tabCapture もマイク取得もしない', async () => {
    const env = setup();
    const link = new FakeLink();
    await env.ctl.armInPage(link);
    env.ctl.inPagePcm(link, 'REMOTE', new Int16Array(1600), -25);
    expect(env.ctl.snapshot()).toMatchObject({ phase: 'armed', sources: { REMOTE: 'armed', SELF: 'off' } });
    expect(env.sockets).toHaveLength(0);
    expect(env.tabStreams).toHaveLength(0);
    expect(env.micStreams).toHaveLength(0);
    expect(env.graph.playback).toEqual([]); // Meet 自身が再生しているので二重再生しない
  });

  it('開始後は REMOTE/SELF を別系統の 16kHz フレームで送り、マイクはページ側（self.start）で取る', async () => {
    const env = setup();
    const link = new FakeLink();
    const ws = await startLive(env, () => env.ctl.armInPage(link));
    expect(link.types()).toContain('self.start');
    expect(env.micStreams).toHaveLength(0);
    env.ctl.inPagePcm(link, 'REMOTE', new Int16Array(1600), -20);
    env.ctl.inPagePcm(link, 'SELF', new Int16Array(1600), -20);
    const headers = ws.sentBinary.map((b) => decodeAudioFrame(b).header);
    expect(headers.map((h) => h.source).sort()).toEqual(['REMOTE', 'SELF']);
    expect(headers.every((h) => h.sampleRate === 16000 && h.sessionId === 'sess-1')).toBe(true);
    expect(ws.sentJson).toContainEqual({ type: 'source.state', source: 'SELF', state: 'on' });
  });

  it('別の Port（古い接続）からの音声は受け取らない', async () => {
    const env = setup();
    const old = new FakeLink();
    const link = new FakeLink();
    await env.ctl.armInPage(old);
    await env.ctl.armInPage(link);
    expect(old.closed).toBe(true);
    expect(old.types()).toContain('stop.all');
    const ws = await startLive(env, async () => {});
    env.ctl.inPagePcm(old, 'REMOTE', new Int16Array(1600), -20);
    expect(ws.sentBinary).toHaveLength(0);
  });

  it('解析一時停止: ページ側の会議音声処理を止め、マイクを解放。再開で戻る', async () => {
    const env = setup();
    const link = new FakeLink();
    const ws = await startLive(env, () => env.ctl.armInPage(link));
    await env.ctl.setPaused(true);
    expect(link.types()).toEqual(expect.arrayContaining(['remote.enable:false', 'self.stop']));
    const before = ws.sentBinary.length;
    env.ctl.inPagePcm(link, 'REMOTE', new Int16Array(1600), -20);
    env.ctl.inPagePcm(link, 'SELF', new Int16Array(1600), -20);
    expect(ws.sentBinary.length).toBe(before);
    await env.ctl.setPaused(false);
    expect(link.types().slice(-2)).toEqual(['remote.enable:true', 'self.start']);
  });

  it('自分の音声取得OFF: ページ側のマイクを止め、以後 SELF は送らない', async () => {
    const env = setup();
    const link = new FakeLink();
    const ws = await startLive(env, () => env.ctl.armInPage(link));
    await env.ctl.setSelf(false);
    expect(link.types()).toContain('self.stop');
    const before = ws.sentBinary.length;
    env.ctl.inPagePcm(link, 'SELF', new Int16Array(1600), -20);
    expect(ws.sentBinary.length).toBe(before);
  });

  it('終了: ページ側に stop.all を送り Port を閉じる。WS も切る', async () => {
    const env = setup();
    const link = new FakeLink();
    const ws = await startLive(env, () => env.ctl.armInPage(link));
    await env.ctl.stop('user_end');
    expect(link.types()).toContain('stop.all');
    expect(link.closed).toBe(true);
    expect(ws.closed).toBe(true);
    expect(env.ctl.activeTimerCount).toBe(0);
  });

  it('Port が切れても止めない（再接続中）。同じタブから再接続したら REMOTE と SELF を再開して同じ商談を続ける', async () => {
    const env = setup();
    const link = new FakeLink();
    const ws = await startLive(env, () => env.ctl.armInPage(link, 7));
    env.ctl.inPageLost(link);
    await flush();
    expect(env.ctl.snapshot()).toMatchObject({ phase: 'live', reconnecting: true, sources: { REMOTE: 'reconnecting', SELF: 'reconnecting' } });
    expect(ws.sentJson).toContainEqual({ type: 'source.state', source: 'REMOTE', state: 'lost', reason: 'reconnecting' });
    expect(env.ctl.acceptsInPageReconnect(7)).toBe(true);
    expect(env.ctl.acceptsInPageReconnect(8)).toBe(false);
    env.advance(IN_PAGE_GRACE_MS - 5000);
    const link2 = new FakeLink();
    await env.ctl.armInPage(link2, 7);
    expect(env.ctl.snapshot()).toMatchObject({ phase: 'live', reconnecting: false, sources: { REMOTE: 'capturing', SELF: 'capturing' } });
    expect(link2.types()).toContain('self.start');
    expect(ws.sentJson).toContainEqual({ type: 'source.state', source: 'REMOTE', state: 'ok' });
    const before = ws.sentBinary.length;
    env.ctl.inPagePcm(link2, 'REMOTE', new Int16Array(1600), -20);
    expect(ws.sentBinary.length).toBeGreaterThan(before);
    env.advance(IN_PAGE_GRACE_MS * 2); // 猶予タイマーは取り消し済み
    await flush();
    expect(env.ctl.snapshot().phase).toBe('live');
  });

  it('Port が切れたまま IN_PAGE_GRACE_MS 戻らなければ meet_lost で止める', async () => {
    const env = setup();
    const link = new FakeLink();
    const ws = await startLive(env, () => env.ctl.armInPage(link, 7));
    env.ctl.inPageLost(link);
    env.advance(IN_PAGE_GRACE_MS + 10);
    await flush();
    expect(env.ctl.snapshot()).toMatchObject({ phase: 'stopped', stopReason: 'meet_lost' });
    expect(ws.sentJson).toContainEqual({ type: 'session.end', exportRequested: false, reason: 'meet_lost' });
  });

  it('通話から退出（call.left）・タブを閉じた で止める（理由をサーバーへ送る）', async () => {
    const env = setup();
    const link = new FakeLink();
    const ws = await startLive(env, () => env.ctl.armInPage(link, 7));
    env.ctl.inPageCallLeft(link);
    await flush();
    expect(env.ctl.snapshot()).toMatchObject({ phase: 'stopped', stopReason: 'call_left' });
    expect(ws.sentJson).toContainEqual({ type: 'session.end', exportRequested: false, reason: 'call_left' });

    const env2 = setup();
    const l2 = new FakeLink();
    const ws2 = await startLive(env2, () => env2.ctl.armInPage(l2, 9));
    env2.ctl.tabClosed();
    await flush();
    expect(env2.ctl.snapshot()).toMatchObject({ phase: 'stopped', stopReason: 'tab_closed' });
    expect(ws2.sentJson).toContainEqual({ type: 'session.end', exportRequested: false, reason: 'tab_closed' });
  });

  it('ページ側のマイクが拒否されたら SELF を「許可なし」にする（商談は続ける）', async () => {
    const env = setup();
    const link = new FakeLink();
    await startLive(env, () => env.ctl.armInPage(link));
    env.ctl.inPageError(link, 'SELF', 'NotAllowedError');
    expect(env.ctl.snapshot()).toMatchObject({ phase: 'live', sources: { SELF: 'no_permission' } });
  });
});
