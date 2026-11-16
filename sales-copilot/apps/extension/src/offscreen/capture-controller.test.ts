import { describe, expect, it } from 'vitest';
import { decodeAudioFrame } from '@sales-copilot/contracts';
import {
  CaptureController,
  HEARTBEAT_TIMEOUT_MS,
  toWsUrl,
  type AudioGraphLike,
  type CaptureDeps,
  type MediaStreamLike,
  type MediaTrackLike,
  type PcmListener,
  type ProcessorHandle,
  type WsLike,
} from './capture-controller';
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

async function startLive(env: ReturnType<typeof setup>) {
  await env.ctl.arm('stream-1');
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

  it('UI のハートビートが途切れたら取得を止める', async () => {
    const env = setup();
    await startLive(env);
    env.ctl.heartbeat();
    env.advance(HEARTBEAT_TIMEOUT_MS + 3000);
    await flush();
    expect(env.ctl.snapshot()).toMatchObject({ phase: 'stopped', stopReason: 'heartbeat_lost' });
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

  it('終了時の出力結果（契約外メッセージ）を UI に渡してから閉じる', async () => {
    const env = setup();
    const ws = await startLive(env);
    const p = env.ctl.end(true);
    expect(ws.sentJson.at(-1)).toMatchObject({ type: 'session.end', exportRequested: true });
    ws.serverSend({ type: 'session.exported', saved: true, path: 'C:/exports/a.md' });
    await p;
    expect(env.emitted).toContainEqual({ target: 'ui', type: 'export.result', result: { saved: true, path: 'C:/exports/a.md' } });
    expect(ws.closed).toBe(true);
  });
});
