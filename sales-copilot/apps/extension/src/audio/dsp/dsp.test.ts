import { describe, expect, it } from 'vitest';
import { AUDIO_SAMPLE_RATE } from '@sales-copilot/contracts';
import { StreamingResampler } from './resampler';
import { downmixToMono, floatToPcm16, rms, toDbfs } from './pcm';
import { FrameChunker, clampFrameMs } from './chunker';
import { EnergyVad } from './vad';
import { CaptureDsp, TARGET_SAMPLE_RATE } from './capture-dsp';

function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** Goertzel でその周波数の振幅を推定。 */
function toneAmplitude(x: Float32Array, freq: number, rate: number): number {
  const w = (2 * Math.PI * freq) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i]! + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - c * s1 * s2;
  return (2 * Math.sqrt(Math.max(0, power))) / x.length;
}

function zeroCrossingFreq(x: Float32Array, rate: number): number {
  let z = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 !== x[i]! < 0) z++;
  return (z / 2) * (rate / x.length);
}

/** 実運用と同じく 128 サンプルずつ流す。 */
function runInBlocks(r: StreamingResampler, x: Float32Array, block = 128): Float32Array {
  const parts: Float32Array[] = [];
  for (let i = 0; i < x.length; i += block) parts.push(r.process(x.subarray(i, i + block)));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('StreamingResampler 48k → 16k', () => {
  it('1kHz のサイン波は 16kHz 出力でも 1kHz のまま（ラベル付け替えなら 333Hz になる）', () => {
    const r = new StreamingResampler(48000, 16000);
    const out = runInBlocks(r, sine(1000, 48000, 1));
    const steady = out.subarray(200, out.length - 200);
    expect(zeroCrossingFreq(steady, 16000)).toBeGreaterThan(990);
    expect(zeroCrossingFreq(steady, 16000)).toBeLessThan(1010);
    expect(toneAmplitude(steady, 1000, 16000)).toBeGreaterThan(0.45);
    expect(toneAmplitude(steady, 333.33, 16000)).toBeLessThan(0.02);
  });

  it('出力サンプル数は入力時間 × 16000 に一致（フィルタ遅延分を除く）', () => {
    const r = new StreamingResampler(48000, 16000);
    const out = runInBlocks(r, sine(440, 48000, 2));
    const expected = 32000;
    const latencyOut = Math.ceil(r.filterHalfWidth / 3) + 1;
    expect(out.length).toBeLessThanOrEqual(expected);
    expect(out.length).toBeGreaterThanOrEqual(expected - latencyOut);
    expect(r.outputCount).toBe(out.length);
  });

  it('出力ナイキスト（8kHz）より上の 12kHz 成分は低域通過で除去され、折り返し（4kHz）も出ない', () => {
    const r = new StreamingResampler(48000, 16000);
    const out = runInBlocks(r, sine(12000, 48000, 1));
    const steady = out.subarray(200, out.length - 200);
    expect(rms(steady)).toBeLessThan(0.005);
    expect(toneAmplitude(steady, 4000, 16000)).toBeLessThan(0.005);
  });

  it('44.1kHz（非整数比）でも周波数を保つ', () => {
    const r = new StreamingResampler(44100, 16000);
    const out = runInBlocks(r, sine(1500, 44100, 1));
    const steady = out.subarray(200, out.length - 200);
    expect(Math.abs(zeroCrossingFreq(steady, 16000) - 1500)).toBeLessThan(10);
    expect(Math.abs(out.length - 16000)).toBeLessThan(40);
  });

  it('ブロック分割の仕方に依存しない（境界で欠落・重複しない）', () => {
    const x = sine(700, 48000, 0.5);
    const a = runInBlocks(new StreamingResampler(48000, 16000), x, 128);
    const b = runInBlocks(new StreamingResampler(48000, 16000), x, 1000);
    expect(a.length).toBe(b.length);
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    expect(maxDiff).toBeLessThan(1e-5);
  });

  it('DC は利得 1', () => {
    const r = new StreamingResampler(48000, 16000);
    const out = runInBlocks(r, new Float32Array(48000).fill(0.25));
    for (let i = 100; i < out.length - 10; i++) expect(Math.abs(out[i]! - 0.25)).toBeLessThan(1e-4);
  });
});

describe('PCM 変換', () => {
  it('Float32 → PCM16 はクリップ・丸め・NaN を扱う', () => {
    const p = floatToPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5, NaN]));
    expect(Array.from(p)).toEqual([0, 32767, -32768, 32767, -32768, 16384, 0]);
  });
  it('ダウンミックスは平均', () => {
    const m = downmixToMono([Float32Array.from([1, 0]), Float32Array.from([0, 1])]);
    expect(Array.from(m)).toEqual([0.5, 0.5]);
  });
  it('RMS と dBFS', () => {
    expect(rms(new Float32Array(10).fill(0.5))).toBeCloseTo(0.5);
    expect(toDbfs(1)).toBeCloseTo(0);
    expect(toDbfs(0)).toBe(-100);
  });
});

describe('FrameChunker', () => {
  it('200ms = 3200 サンプル単位に区切り、端数は保持する', () => {
    const c = new FrameChunker(200);
    expect(c.frameSamples).toBe(3200);
    expect(c.push(new Int16Array(3000))).toHaveLength(0);
    const f = c.push(new Int16Array(3500));
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.length === 3200)).toBe(true);
    expect(c.bufferedSamples).toBe(100);
  });
  it('100〜250ms に制限', () => {
    expect(clampFrameMs(50)).toBe(100);
    expect(clampFrameMs(400)).toBe(250);
    expect(clampFrameMs(NaN)).toBe(200);
  });
});

describe('EnergyVad', () => {
  it('閾値超えが続くと発話開始、静かになって一定時間で終了', () => {
    const v = new EnergyVad({ thresholdDb: -40, attackMs: 100, releaseMs: 400 });
    expect(v.update(-20, 50, 0)).toBeNull();
    expect(v.update(-20, 50, 50)).toEqual({ speaking: true, atMs: 0 });
    expect(v.update(-60, 200, 100)).toBeNull();
    expect(v.update(-60, 200, 300)).toEqual({ speaking: false, atMs: 100 });
  });
  it('一瞬の雑音では発話にしない', () => {
    const v = new EnergyVad({ thresholdDb: -40, attackMs: 100 });
    expect(v.update(-20, 20, 0)).toBeNull();
    expect(v.update(-70, 20, 20)).toBeNull();
    expect(v.update(-20, 20, 40)).toBeNull();
    expect(v.isSpeaking).toBe(false);
  });
});

describe('CaptureDsp（worklet 内処理）', () => {
  it('送信形式の定数は contracts と一致', () => {
    expect(TARGET_SAMPLE_RATE).toBe(AUDIO_SAMPLE_RATE);
  });
  it('48kHz ステレオの 128 サンプル量子を 16kHz モノラル PCM16 にまとめ、実レートを記録する', () => {
    const dsp = new CaptureDsp(48000, 20);
    const x = sine(1000, 48000, 1);
    const blocks: Int16Array[] = [];
    for (let i = 0; i < x.length; i += 128) {
      const q = x.subarray(i, i + 128);
      const b = dsp.process([q, q]);
      if (b) {
        expect(b.inputSampleRate).toBe(48000);
        expect(b.levelDb).toBeGreaterThan(-12);
        blocks.push(b.pcm);
      }
    }
    const total = blocks.reduce((a, b) => a + b.length, 0);
    expect(total).toBeGreaterThan(15600);
    expect(total).toBeLessThanOrEqual(16000);
    const f = new Float32Array(total);
    let o = 0;
    for (const b of blocks) for (const s of b) f[o++] = s / 32768;
    expect(Math.abs(zeroCrossingFreq(f.subarray(200), 16000) - 1000)).toBeLessThan(10);
  });
});
