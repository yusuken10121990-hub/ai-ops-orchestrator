/// <reference lib="webworker" />
/**
 * AudioWorklet プロセッサー（別バンドルで単一ファイル化される）。
 * 入力 1 系統（SELF か REMOTE のどちらか）をモノラル化 → 16kHz へリサンプリング → PCM16 にして
 * メインスレッド（offscreen document）へ転送する。出力は持たない（スピーカーへ流さない）。
 */
import { CaptureDsp } from '../dsp/capture-dsp';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: unknown): void;

class SalesCopilotCaptureProcessor extends AudioWorkletProcessor {
  private readonly dsp: CaptureDsp;
  private enabled = true;

  constructor(options?: unknown) {
    super(options);
    this.dsp = new CaptureDsp(sampleRate);
    this.port.onmessage = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; enabled?: boolean };
      if (d && d.type === 'enable') this.enabled = !!d.enabled;
    };
    this.port.postMessage({ type: 'ready', inputSampleRate: sampleRate });
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!this.enabled || !input || input.length === 0) return true;
    const block = this.dsp.process(input);
    if (block) {
      this.port.postMessage(
        { type: 'pcm', pcm: block.pcm, inputSampleRate: block.inputSampleRate, levelDb: block.levelDb },
        [block.pcm.buffer],
      );
    }
    return true;
  }
}

registerProcessor('sales-copilot-capture', SalesCopilotCaptureProcessor);
