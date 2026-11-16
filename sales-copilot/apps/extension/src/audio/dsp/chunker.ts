import { AUDIO_SAMPLE_RATE } from '@sales-copilot/contracts';

export const DEFAULT_FRAME_MS = 200;
export const MIN_FRAME_MS = 100;
export const MAX_FRAME_MS = 250;

export function clampFrameMs(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_FRAME_MS;
  return Math.min(MAX_FRAME_MS, Math.max(MIN_FRAME_MS, Math.round(ms / 10) * 10));
}

/**
 * 16kHz PCM16 を固定長フレーム（既定 200ms、100〜250ms）に区切る。
 * 端数は次回 push まで保持する。無制限には溜めない（1フレーム未満のみ保持）。
 */
export class FrameChunker {
  readonly frameMs: number;
  readonly frameSamples: number;
  private pending: Int16Array;
  private pendingLen = 0;

  constructor(frameMs: number = DEFAULT_FRAME_MS) {
    this.frameMs = clampFrameMs(frameMs);
    this.frameSamples = (AUDIO_SAMPLE_RATE * this.frameMs) / 1000;
    this.pending = new Int16Array(this.frameSamples);
  }

  push(pcm: Int16Array): Int16Array[] {
    const frames: Int16Array[] = [];
    let offset = 0;
    while (offset < pcm.length) {
      const take = Math.min(this.frameSamples - this.pendingLen, pcm.length - offset);
      this.pending.set(pcm.subarray(offset, offset + take), this.pendingLen);
      this.pendingLen += take;
      offset += take;
      if (this.pendingLen === this.frameSamples) {
        frames.push(this.pending);
        this.pending = new Int16Array(this.frameSamples);
        this.pendingLen = 0;
      }
    }
    return frames;
  }

  /** 端数を破棄（トラック再開・一時停止時）。 */
  reset(): void {
    this.pendingLen = 0;
  }

  get bufferedSamples(): number {
    return this.pendingLen;
  }
}
