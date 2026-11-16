import { describe, expect, it } from 'vitest';
import { decodeAudioFrame } from '@sales-copilot/contracts';
import { SourceFramer } from './framer';
import { BackpressureSender, WS_OPEN, type SocketLike } from './sender';

class FakeSocket implements SocketLike {
  readyState = WS_OPEN;
  bufferedAmount = 0;
  sent: unknown[] = [];
  closed = false;
  send(d: string | ArrayBufferLike | Uint8Array): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

describe('SourceFramer', () => {
  it('ヘッダーは 16kHz/PCM16/モノラル、durationMs はサンプル数と一致し contracts で復号できる', () => {
    const f = new SourceFramer('s1', 'REMOTE', 200, false);
    f.startGeneration(1234);
    const { frames } = f.push(new Int16Array(3200 * 2 + 10));
    expect(frames).toHaveLength(2);
    const d0 = decodeAudioFrame(frames[0]!.bytes);
    expect(d0.header).toMatchObject({
      sessionId: 's1',
      source: 'REMOTE',
      streamGeneration: 0,
      sequence: 0,
      audioStartMs: 1234,
      durationMs: 200,
      sampleRate: 16000,
      channels: 1,
      encoding: 'pcm16le',
    });
    expect(d0.pcm.byteLength).toBe(6400);
    expect(decodeAudioFrame(frames[1]!.bytes).header).toMatchObject({ sequence: 1, audioStartMs: 1434 });
  });

  it('トラック再開で streamGeneration が増え、sequence は 0 から', () => {
    const f = new SourceFramer('s1', 'SELF', 100, false);
    expect(f.push(new Int16Array(1600)).frames).toHaveLength(0); // 未開始は送らない
    f.startGeneration(0);
    f.push(new Int16Array(1600 * 3));
    expect(f.startGeneration(5000)).toBe(1);
    const { frames } = f.push(new Int16Array(1600));
    expect(frames[0]!.header).toMatchObject({ streamGeneration: 1, sequence: 0, audioStartMs: 5000 });
  });

  it('SELF の VAD 遷移を返す', () => {
    const f = new SourceFramer('s1', 'SELF', 100, true);
    f.startGeneration(0);
    const loud = new Int16Array(1600).map((_, i) => (i % 2 ? 8000 : -8000));
    const r = f.push(new Int16Array([...loud, ...loud]));
    expect(r.vad).toEqual([{ speaking: true, atMs: 0 }]);
  });
});

describe('BackpressureSender', () => {
  function frames(n: number) {
    const f = new SourceFramer('s1', 'REMOTE', 100, false);
    f.startGeneration(0);
    return f.push(new Int16Array(1600 * n)).frames;
  }

  it('bufferedAmount が上限を超えたら破棄して欠落区間を記録、復旧後に古い音声を再送しない', () => {
    const sock = new FakeSocket();
    const events: string[] = [];
    const s = new BackpressureSender(sock, 10_000, (g, p) => events.push(`${p}:${g.fromMs}-${g.toMs}`));
    const fs = frames(4);
    expect(s.send(fs[0]!)).toBe('sent');
    sock.bufferedAmount = 9_000;
    expect(s.send(fs[1]!)).toBe('dropped');
    expect(s.send(fs[2]!)).toBe('dropped');
    sock.bufferedAmount = 0;
    expect(s.send(fs[3]!)).toBe('sent');
    expect(sock.sent).toHaveLength(2);
    expect(s.gaps).toEqual([{ source: 'REMOTE', streamGeneration: 0, fromMs: 100, toMs: 300, droppedFrames: 2 }]);
    expect(events).toEqual(['start:100-200', 'end:100-300']);
  });

  it('停止後・切断後は送らない', () => {
    const sock = new FakeSocket();
    const s = new BackpressureSender(sock);
    const fs = frames(2);
    s.disable();
    expect(s.send(fs[0]!)).toBe('closed');
    const sock2 = new FakeSocket();
    sock2.readyState = 3;
    expect(new BackpressureSender(sock2).send(fs[1]!)).toBe('closed');
    expect(sock.sent).toHaveLength(0);
  });
});
