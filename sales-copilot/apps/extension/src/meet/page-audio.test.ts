import { describe, expect, it } from 'vitest';
import { PageAudio, installRtcHook, type AudioPipe, type PcmSink, type TrackLike } from './page-audio';
import type { FromPage } from './wire';

class FakeTrack implements TrackLike {
  readyState = 'live';
  stopped = false;
  private ls: (() => void)[] = [];
  constructor(
    readonly id: string,
    readonly kind = 'audio',
  ) {}
  stop() {
    this.stopped = true;
    this.readyState = 'ended';
  }
  addEventListener(_t: 'ended', l: () => void) {
    this.ls.push(l);
  }
  end() {
    this.readyState = 'ended';
    for (const l of this.ls) l();
  }
}

class FakePipe implements AudioPipe {
  tracks = new Set<string>();
  enabled = true;
  closed = false;
  constructor(
    readonly source: string,
    readonly onPcm: PcmSink,
  ) {}
  addTrack(t: TrackLike) {
    this.tracks.add(t.id);
  }
  removeTrack(t: TrackLike) {
    this.tracks.delete(t.id);
  }
  setEnabled(e: boolean) {
    this.enabled = e;
  }
  close() {
    this.closed = true;
  }
}

function setup(opts: { micError?: string; extra?: TrackLike[] } = {}) {
  const emitted: FromPage[] = [];
  const pipes: FakePipe[] = [];
  const mics: FakeTrack[] = [];
  const intervals = new Map<number, () => void>();
  let id = 1;
  let closedAll = 0;
  let resolveMic: (() => void) | null = null;
  let holdMic = false;
  const audio = new PageAudio({
    createPipe(source, onPcm) {
      const p = new FakePipe(source, onPcm);
      pipes.push(p);
      return p;
    },
    async getMic() {
      if (holdMic) await new Promise<void>((r) => (resolveMic = r));
      if (opts.micError) throw Object.assign(new Error('x'), { name: opts.micError });
      const t = new FakeTrack(`mic-${mics.length}`);
      mics.push(t);
      return { getTracks: () => [t] };
    },
    collectRemoteTracks: () => opts.extra ?? [],
    closeAll: () => void closedAll++,
    emit: (m) => emitted.push(m),
    setInterval(fn) {
      const i = id++;
      intervals.set(i, fn);
      return i;
    },
    clearInterval(i) {
      intervals.delete(i as number);
    },
  });
  return {
    audio,
    emitted,
    pipes,
    mics,
    intervals,
    closedAll: () => closedAll,
    hold: () => (holdMic = true),
    release: () => resolveMic?.(),
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PageAudio（Meet ページ内の音声取得）', () => {
  it('接続前は相手のトラックを記録するだけ（処理も送信もしない）。参加の合図だけ出す', () => {
    const env = setup();
    env.audio.addRemoteTrack(new FakeTrack('r1'));
    env.audio.addRemoteTrack(new FakeTrack('v1', 'video'));
    env.audio.addRemoteTrack(new FakeTrack('r1'));
    expect(env.pipes).toHaveLength(0);
    expect(env.emitted).toEqual([{ type: 'rtc.active', remoteTracks: 1 }]);
  });

  it('remote.start で記録済み・後から来た相手を 1 系統（REMOTE）に混ぜる。終わったトラックは外す', () => {
    const extra = new FakeTrack('a1');
    const env = setup({ extra: [extra] });
    const r1 = new FakeTrack('r1');
    env.audio.addRemoteTrack(r1);
    env.audio.handle({ type: 'remote.start' });
    env.audio.handle({ type: 'remote.start' }); // 二重に作らない
    expect(env.pipes).toHaveLength(1);
    const pipe = env.pipes[0]!;
    expect(pipe.source).toBe('REMOTE');
    expect([...pipe.tracks].sort()).toEqual(['a1', 'r1']);
    env.audio.addRemoteTrack(new FakeTrack('r2'));
    expect(pipe.tracks.has('r2')).toBe(true);
    r1.end();
    expect(pipe.tracks.has('r1')).toBe(false);
    expect(env.intervals.size).toBe(1); // 後から参加した相手を拾い直す
  });

  it('PCM は source 付きで content script へ渡す', () => {
    const env = setup();
    env.audio.handle({ type: 'remote.start' });
    env.pipes[0]!.onPcm(new Int16Array(640), -22, 48000);
    expect(env.emitted.at(-1)).toMatchObject({ type: 'pcm', source: 'REMOTE', levelDb: -22, inputSampleRate: 48000 });
  });

  it('remote.enable で一時停止・再開（相手のトラック自体は止めない＝Meet の再生を壊さない）', () => {
    const env = setup();
    const r1 = new FakeTrack('r1');
    env.audio.addRemoteTrack(r1);
    env.audio.handle({ type: 'remote.start' });
    env.audio.handle({ type: 'remote.enable', enabled: false });
    expect(env.pipes[0]!.enabled).toBe(false);
    env.audio.handle({ type: 'remote.enable', enabled: true });
    expect(env.pipes[0]!.enabled).toBe(true);
    env.audio.handle({ type: 'stop.all' });
    expect(r1.stopped).toBe(false);
  });

  it('self.start でページに許可済みのマイクを別系統（SELF）で取得、self.stop でトラックを止める', async () => {
    const env = setup();
    env.audio.handle({ type: 'self.start' });
    await flush();
    expect(env.mics).toHaveLength(1);
    const pipe = env.pipes.find((p) => p.source === 'SELF')!;
    expect([...pipe.tracks]).toEqual(['mic-0']);
    env.audio.handle({ type: 'self.stop' });
    expect(env.mics[0]!.stopped).toBe(true);
    expect(pipe.closed).toBe(true);
    expect(env.audio.capturingSelf).toBe(false);
  });

  it('マイク取得中に止められたら、取れたマイクをすぐ止める', async () => {
    const env = setup();
    env.hold();
    env.audio.handle({ type: 'self.start' });
    env.audio.handle({ type: 'self.stop' });
    env.release();
    await flush();
    expect(env.mics[0]!.stopped).toBe(true);
    expect(env.pipes.filter((p) => p.source === 'SELF')).toHaveLength(0);
  });

  it('マイク拒否は self.error で知らせる', async () => {
    const env = setup({ micError: 'NotAllowedError' });
    env.audio.handle({ type: 'self.start' });
    await flush();
    expect(env.emitted).toContainEqual({ type: 'self.error', name: 'NotAllowedError' });
  });

  it('マイクのトラックが終わったら（抜いた等）SELF を止めて知らせる', async () => {
    const env = setup();
    env.audio.handle({ type: 'self.start' });
    await flush();
    env.mics[0]!.end();
    expect(env.emitted).toContainEqual({ type: 'self.error', name: 'track_ended' });
    expect(env.audio.capturingSelf).toBe(false);
  });

  it('stop.all で全て閉じ、マイクを止め、定期走査も止める', async () => {
    const env = setup();
    env.audio.handle({ type: 'remote.start' });
    env.audio.handle({ type: 'self.start' });
    await flush();
    env.audio.handle({ type: 'stop.all' });
    expect(env.pipes.every((p) => p.closed)).toBe(true);
    expect(env.mics.every((m) => m.stopped)).toBe(true);
    expect(env.intervals.size).toBe(0);
    expect(env.closedAll()).toBe(1);
    expect(env.audio.capturingRemote).toBe(false);
  });
});

describe('installRtcHook（Meet より先に RTCPeerConnection を包む）', () => {
  class FakePc {
    static created = 0;
    connectionState = 'new';
    private ls: ((ev: { track: TrackLike }) => void)[] = [];
    constructor(readonly config?: unknown) {
      FakePc.created++;
    }
    addEventListener(_t: 'track', l: (ev: { track: TrackLike }) => void) {
      this.ls.push(l);
    }
    fireTrack(t: TrackLike) {
      for (const l of this.ls) l({ track: t });
    }
    getReceivers() {
      return [];
    }
    static generateCertificate() {
      return 'cert';
    }
  }

  it('接続の作り方・instanceof・静的メソッドを変えずに、受信トラックを通知する', () => {
    const win: Record<string, unknown> = { RTCPeerConnection: FakePc };
    const got: string[] = [];
    const hook = installRtcHook(win, (t) => got.push(t.id));
    const Ctor = win.RTCPeerConnection as typeof FakePc;
    expect(Ctor).not.toBe(FakePc);
    const pc = new Ctor({ iceServers: [] });
    expect(pc).toBeInstanceOf(FakePc);
    expect(pc instanceof Ctor).toBe(true);
    expect(pc.config).toEqual({ iceServers: [] });
    expect(Ctor.generateCertificate()).toBe('cert');
    pc.fireTrack(new FakeTrack('remote-1'));
    expect(got).toEqual(['remote-1']);
    expect(hook.peers()).toHaveLength(1);
    pc.connectionState = 'closed';
    expect(hook.peers()).toHaveLength(0);
  });

  it('二重に入っても二重に包まない', () => {
    const win: Record<string, unknown> = { RTCPeerConnection: FakePc };
    installRtcHook(win, () => {});
    const once = win.RTCPeerConnection;
    installRtcHook(win, () => {});
    expect(win.RTCPeerConnection).toBe(once);
  });

  it('RTCPeerConnection が無い環境でも例外にしない', () => {
    expect(() => installRtcHook({}, () => {})).not.toThrow();
  });
});
