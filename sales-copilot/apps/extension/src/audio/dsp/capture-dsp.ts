import { downmixToMono, floatToPcm16, rms, toDbfs } from './pcm';
import { StreamingResampler } from './resampler';

/**
 * 送信形式のサンプルレート。contracts の AUDIO_SAMPLE_RATE と同値（テストで一致を確認）。
 * worklet バンドルに zod を含めないため、ここでは定数を直接持つ。
 */
export const TARGET_SAMPLE_RATE = 16000;
const AUDIO_SAMPLE_RATE = TARGET_SAMPLE_RATE;

export interface DspBlock {
  /** 16kHz モノラル PCM16（実際にリサンプリング済み）。 */
  pcm: Int16Array;
  /** 元のサンプルレート（ラベル付け替えでないことの記録）。 */
  inputSampleRate: number;
  /** このブロックの入力側レベル（dBFS）。 */
  levelDb: number;
}

/**
 * AudioWorklet 内で使う純粋処理: ダウンミックス → 窓付き sinc で 16kHz へ → PCM16。
 * レンダー量子（128 サンプル）ごとに呼ばれ、約 batchMs ごとにまとめて返す（postMessage 回数削減）。
 */
export class CaptureDsp {
  private readonly resampler: StreamingResampler;
  private readonly batchSamples: number;
  private parts: Float32Array[] = [];
  private partsLen = 0;
  private sumSq = 0;
  private count = 0;

  constructor(
    readonly inputSampleRate: number,
    batchMs = 20,
  ) {
    this.resampler = new StreamingResampler(inputSampleRate, AUDIO_SAMPLE_RATE);
    this.batchSamples = Math.round((AUDIO_SAMPLE_RATE * batchMs) / 1000);
  }

  process(channels: readonly Float32Array[]): DspBlock | null {
    if (channels.length === 0 || !channels[0] || channels[0].length === 0) return null;
    const mono = downmixToMono(channels);
    const r = rms(mono);
    this.sumSq += r * r * mono.length;
    this.count += mono.length;
    const out = this.resampler.process(mono);
    if (out.length > 0) {
      this.parts.push(out);
      this.partsLen += out.length;
    }
    if (this.partsLen < this.batchSamples) return null;
    const joined = new Float32Array(this.partsLen);
    let o = 0;
    for (const p of this.parts) {
      joined.set(p, o);
      o += p.length;
    }
    const levelDb = toDbfs(this.count > 0 ? Math.sqrt(this.sumSq / this.count) : 0);
    this.parts = [];
    this.partsLen = 0;
    this.sumSq = 0;
    this.count = 0;
    return { pcm: floatToPcm16(joined), inputSampleRate: this.inputSampleRate, levelDb };
  }
}
