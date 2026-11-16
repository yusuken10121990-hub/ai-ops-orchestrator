import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDeepgramUrl,
  DeepgramStreamingRecognizer,
  normalizeDeepgramResult,
  parseDeepgramMessage,
  StreamTimeMap,
  WS_OPEN,
  type WsLike,
} from './deepgram';
import type { RecognizerEvent } from './speech';

// 公式リファレンス（listen-streaming / utterance-end, 2026-11-16 確認）の形に沿った架空フィクスチャ。
const FIX = {
  interim: {
    type: 'Results',
    channel_index: [0, 1],
    duration: 1.2,
    start: 0.5,
    is_final: false,
    speech_final: false,
    channel: { alternatives: [{ transcript: 'それは対応でき', confidence: 0.71, words: [] }] },
    metadata: { request_id: 'req-1', model_info: { name: 'x', version: 'y', arch: 'z' }, model_uuid: 'u' },
    from_finalize: false,
  },
  final: {
    type: 'Results',
    channel_index: [0, 1],
    duration: 1.6,
    start: 0.5,
    is_final: true,
    speech_final: true,
    channel: { alternatives: [{ transcript: 'それは対応できますか？', confidence: 0.93, words: [] }] },
    from_finalize: false,
  },
  utteranceEnd: { channel: [0, 1], last_word_end: 2.395, type: 'UtteranceEnd' },
  utteranceEndFinalized: { channel: [0, 1], last_word_end: -1, type: 'UtteranceEnd' },
  metadata: { type: 'Metadata', request_id: 'req-1', duration: 3, channels: 1 },
};

describe('Deepgram URL', () => {
  it('sets model/language/linear16/16k/mono/interim/endpointing/utterance_end_ms and never contains a key', () => {
    const url = buildDeepgramUrl({
      model: 'nova-3',
      language: 'ja',
      endpointingMs: 300,
      utteranceEndMs: 1000,
      smartFormat: true,
      punctuate: false,
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('wss://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      model: 'nova-3',
      language: 'ja',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      endpointing: '300',
      utterance_end_ms: '1000',
      smart_format: 'true',
    });
    expect(url).not.toMatch(/token|key/i);
  });

  it('clamps utterance_end_ms to the documented minimum (1000)', () => {
    const u = new URL(
      buildDeepgramUrl({ model: 'm', language: 'ja', endpointingMs: false, utteranceEndMs: 300, smartFormat: false, punctuate: true }),
    );
    expect(u.searchParams.get('utterance_end_ms')).toBe('1000');
    expect(u.searchParams.get('endpointing')).toBe('false');
    expect(u.searchParams.get('punctuate')).toBe('true');
  });
});

describe('Deepgram message parsing (fixtures)', () => {
  it('parses interim and final results', () => {
    expect(parseDeepgramMessage(JSON.stringify(FIX.interim))).toMatchObject({
      kind: 'results',
      start: 0.5,
      duration: 1.2,
      isFinal: false,
      speechFinal: false,
      transcript: 'それは対応でき',
    });
    expect(parseDeepgramMessage(JSON.stringify(FIX.final))).toMatchObject({ kind: 'results', isFinal: true, speechFinal: true });
  });

  it('parses UtteranceEnd and ignores last_word_end = -1', () => {
    expect(parseDeepgramMessage(JSON.stringify(FIX.utteranceEnd))).toEqual({ kind: 'utterance_end', lastWordEnd: 2.395 });
    expect(parseDeepgramMessage(JSON.stringify(FIX.utteranceEndFinalized)).kind).toBe('ignored');
  });

  it('ignores malformed / non-JSON input without throwing', () => {
    expect(parseDeepgramMessage('not json').kind).toBe('ignored');
    expect(parseDeepgramMessage(JSON.stringify({ type: 'Results', start: 1 })).kind).toBe('ignored');
    expect(parseDeepgramMessage(JSON.stringify(FIX.metadata))).toEqual({ kind: 'metadata', requestId: 'req-1' });
  });

  it('normalizes to session audio time using the per-connection time map (with a gap)', () => {
    const tm = new StreamTimeMap();
    // 0..1000ms をセッション時刻 10000 から送信、その後 2000ms 欠落して 13000 から送信
    for (let i = 0; i < 10; i++) tm.add(10_000 + i * 100, 100);
    for (let i = 0; i < 10; i++) tm.add(13_000 + i * 100, 100);
    const msg = parseDeepgramMessage(JSON.stringify(FIX.final));
    if (msg.kind !== 'results') throw new Error('expected results');
    const r = normalizeDeepgramResult(msg, { source: 'REMOTE', streamGeneration: 2, timeMap: tm, receivedAt: 99 });
    expect(r).toMatchObject({ source: 'REMOTE', streamGeneration: 2, isFinal: true, speechFinal: true, startMs: 10_500 });
    // 0.5+1.6 = 2.1s → 2つ目の塊（Deepgram 1000ms〜）の 1100ms 目 → 13_000 + 1100
    expect(r.endMs).toBe(14_100);
    expect(r.segmentKey).toBe('REMOTE|2|10500');
  });

  it('speechFinal is only true together with isFinal', () => {
    const tm = new StreamTimeMap();
    const r = normalizeDeepgramResult(
      { kind: 'results', start: 0, duration: 1, isFinal: false, speechFinal: true, fromFinalize: false, transcript: 'x', confidence: null },
      { source: 'SELF', streamGeneration: 0, timeMap: tm, receivedAt: 0 },
    );
    expect(r.speechFinal).toBe(false);
  });
});

class FakeWs extends EventEmitter implements WsLike {
  readyState = 0;
  bufferedAmount = 0;
  readonly sentBinary: Uint8Array[] = [];
  readonly sentText: string[] = [];
  closed: number | null = null;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {
    super();
  }
  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.sentText.push(data);
    else this.sentBinary.push(data);
  }
  close(code?: number): void {
    this.closed = code ?? 1000;
    this.readyState = 3;
  }
  // test helpers
  doOpen(): void {
    this.readyState = WS_OPEN;
    this.emit('open');
  }
  doMessage(o: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(o)), false);
  }
  doClose(code: number): void {
    this.readyState = 3;
    this.emit('close', code, Buffer.from(''));
  }
  doHttpReject(status: number): void {
    this.emit('unexpected-response', { destroy() {} }, { statusCode: status, resume() {} });
  }
}

const pcm = (ms: number) => new Uint8Array(ms * 32);

describe('DeepgramStreamingRecognizer', () => {
  let sockets: FakeWs[];
  let events: RecognizerEvent[];
  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    events = [];
  });
  afterEach(() => vi.useRealTimers());

  function make(over: Partial<ConstructorParameters<typeof DeepgramStreamingRecognizer>[0]> = {}) {
    const r = new DeepgramStreamingRecognizer({
      source: 'REMOTE',
      apiKey: 'dg-secret-key-should-not-leak',
      model: 'nova-3',
      language: 'ja',
      endpointingMs: 300,
      utteranceEndMs: 1000,
      smartFormat: true,
      punctuate: false,
      wsFactory: (url, headers) => {
        const s = new FakeWs(url, headers);
        sockets.push(s);
        return s;
      },
      now: () => Date.now(),
      ...over,
    });
    r.on((e) => events.push(e));
    return r;
  }

  it('does not connect until audio arrives (no paid call at startup)', () => {
    make();
    expect(sockets).toHaveLength(0);
  });

  it('connects lazily with Authorization: Token header (not in URL), flushes queued audio on open', () => {
    const r = make();
    expect(r.sendAudio(pcm(100), { frameGeneration: 0, sequence: 1, audioStartMs: 0, durationMs: 100 })).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.headers).toEqual({ Authorization: 'Token dg-secret-key-should-not-leak' });
    expect(sockets[0]!.url).not.toContain('dg-secret');
    sockets[0]!.doOpen();
    expect(sockets[0]!.sentBinary).toHaveLength(1);
    expect(events.filter((e) => e.type === 'audio_sent')).toHaveLength(1);
  });

  it('emits normalized results and utterance_end aligned to session time', () => {
    const r = make();
    r.sendAudio(pcm(1000), { frameGeneration: 0, sequence: 1, audioStartMs: 5000, durationMs: 1000 });
    r.sendAudio(pcm(1000), { frameGeneration: 0, sequence: 2, audioStartMs: 6000, durationMs: 1000 });
    sockets[0]!.doOpen();
    sockets[0]!.doMessage(FIX.interim);
    sockets[0]!.doMessage(FIX.final);
    sockets[0]!.doMessage(FIX.utteranceEnd);
    const results = events.flatMap((e) => (e.type === 'result' ? [e.result] : []));
    expect(results.map((x) => [x.isFinal, x.startMs, x.segmentKey])).toEqual([
      [false, 5500, 'REMOTE|0|5500'],
      [true, 5500, 'REMOTE|0|5500'],
    ]);
    const ue = events.find((e) => e.type === 'utterance_end');
    expect(ue).toMatchObject({ lastWordEndMs: 7395 });
  });

  it('sends KeepAlive during silence', () => {
    const r = make({ keepAliveMs: 4000 });
    r.sendAudio(pcm(100), { frameGeneration: 0, sequence: 1, audioStartMs: 0, durationMs: 100 });
    sockets[0]!.doOpen();
    vi.advanceTimersByTime(4100);
    expect(sockets[0]!.sentText.map((t) => JSON.parse(t).type)).toContain('KeepAlive');
  });

  it('reconnects with streamGeneration++ and bounded backoff after an unexpected close', () => {
    const r = make({ reconnectBaseDelayMs: 100 });
    r.sendAudio(pcm(100), { frameGeneration: 0, sequence: 1, audioStartMs: 0, durationMs: 100 });
    sockets[0]!.doOpen();
    expect(r.streamGeneration).toBe(0);
    sockets[0]!.doClose(1011);
    expect(r.state).toBe('reconnecting');
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
    sockets[1]!.doOpen();
    expect(r.streamGeneration).toBe(1);
    sockets[1]!.doMessage(FIX.final);
    const last = events.filter((e) => e.type === 'result').at(-1);
    expect(last && last.type === 'result' && last.result.streamGeneration).toBe(1);
  });

  it('does not replay stale audio: queue is bounded while disconnected and drops are recorded', () => {
    const r = make({ maxQueueMs: 500, reconnectBaseDelayMs: 1000 });
    r.sendAudio(pcm(100), { frameGeneration: 0, sequence: 0, audioStartMs: 0, durationMs: 100 });
    sockets[0]!.doOpen();
    sockets[0]!.doClose(1011);
    for (let i = 1; i <= 20; i++) r.sendAudio(pcm(100), { frameGeneration: 0, sequence: i, audioStartMs: i * 100, durationMs: 100 });
    const dropped = events.filter((e) => e.type === 'audio_dropped');
    expect(dropped.reduce((s, e) => s + (e.type === 'audio_dropped' ? e.droppedMs : 0), 0)).toBe(1500);
    vi.advanceTimersByTime(1000);
    sockets[1]!.doOpen();
    // 新しい接続へは直近 500ms 分（5フレーム）だけ
    expect(sockets[1]!.sentBinary).toHaveLength(5);
  });

  it('auth failure (401 on upgrade) is fatal: no reconnect', () => {
    const r = make();
    r.sendAudio(pcm(100), { frameGeneration: 0, sequence: 1, audioStartMs: 0, durationMs: 100 });
    sockets[0]!.doHttpReject(401);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(r.state).toBe('failed');
    expect(events.find((e) => e.type === 'error' && e.fatal)).toMatchObject({ kind: 'auth_failed' });
    expect(r.sendAudio(pcm(100), { frameGeneration: 0, sequence: 2, audioStartMs: 100, durationMs: 100 })).toBe(false);
  });

  it('429 on upgrade backs off and eventually gives up (bounded attempts)', () => {
    const r = make({ reconnectBaseDelayMs: 10, reconnectMaxDelayMs: 100, maxReconnectAttempts: 3 });
    r.sendAudio(pcm(100), { frameGeneration: 0, sequence: 1, audioStartMs: 0, durationMs: 100 });
    for (let i = 0; i < 5; i++) {
      sockets.at(-1)!.doHttpReject(429);
      vi.advanceTimersByTime(1000);
    }
    expect(sockets).toHaveLength(4);
    expect(r.state).toBe('failed');
    expect(events.filter((e) => e.type === 'error').at(-1)).toMatchObject({ kind: 'rate_limited', fatal: true });
  });

  it('missing key → not_configured, never connects', () => {
    const r = make({ apiKey: '' });
    expect(r.sendAudio(pcm(100), { frameGeneration: 0, sequence: 1, audioStartMs: 0, durationMs: 100 })).toBe(false);
    expect(sockets).toHaveLength(0);
    expect(events.find((e) => e.type === 'error')).toMatchObject({ kind: 'not_configured', fatal: true });
  });

  it('stop() sends CloseStream, closes, and refuses further audio; no reconnect afterwards', async () => {
    const r = make();
    r.sendAudio(pcm(100), { frameGeneration: 0, sequence: 1, audioStartMs: 0, durationMs: 100 });
    sockets[0]!.doOpen();
    await r.stop();
    expect(sockets[0]!.sentText.map((t) => JSON.parse(t).type)).toContain('CloseStream');
    expect(sockets[0]!.closed).toBe(1000);
    expect(r.sendAudio(pcm(100), { frameGeneration: 0, sequence: 2, audioStartMs: 100, durationMs: 100 })).toBe(false);
    sockets[0]!.doClose(1011);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('holds audio while the socket send buffer is full (backpressure) and drops oldest beyond the cap', () => {
    const r = make({ maxQueueMs: 300, maxBufferedMs: 100 });
    r.sendAudio(pcm(100), { frameGeneration: 0, sequence: 0, audioStartMs: 0, durationMs: 100 });
    sockets[0]!.doOpen();
    sockets[0]!.bufferedAmount = 10_000_000;
    for (let i = 1; i <= 6; i++) r.sendAudio(pcm(100), { frameGeneration: 0, sequence: i, audioStartMs: i * 100, durationMs: 100 });
    expect(sockets[0]!.sentBinary).toHaveLength(1);
    expect(events.some((e) => e.type === 'audio_dropped' && e.reason === 'backpressure')).toBe(true);
    sockets[0]!.bufferedAmount = 0;
    vi.advanceTimersByTime(60);
    expect(sockets[0]!.sentBinary).toHaveLength(4);
  });
});
