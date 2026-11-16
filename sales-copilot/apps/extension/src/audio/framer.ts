import {
  AUDIO_CHANNELS,
  AUDIO_ENCODING,
  AUDIO_SAMPLE_RATE,
  encodeAudioFrame,
  type AudioFrameHeader,
  type CaptureSource,
} from '@sales-copilot/contracts';
import { FrameChunker } from './dsp/chunker';
import { EnergyVad, type VadTransition } from './dsp/vad';
import { rms, toDbfs } from './dsp/pcm';

export interface EncodedFrame {
  header: AudioFrameHeader;
  bytes: Uint8Array;
}

/**
 * 1系統ぶんのフレーム化（SPEC §6-3）。
 * - streamGeneration: トラック再開・一時停止からの再開ごとに +1
 * - sequence: generation 内で単調増加（送信を破棄した分も番号は進める＝欠落が分かる）
 * - audioStartMs: セッション開始からの時刻。generation 開始時の経過時間 + 生成済みサンプル数で決める
 */
export class SourceFramer {
  private chunker: FrameChunker;
  private generation = -1;
  private sequence = 0;
  private baseMs = 0;
  private emittedSamples = 0;
  private readonly vad: EnergyVad | null;

  constructor(
    readonly sessionId: string,
    readonly source: CaptureSource,
    frameMs: number,
    withVad: boolean,
  ) {
    this.chunker = new FrameChunker(frameMs);
    this.vad = withVad ? new EnergyVad() : null;
  }

  get frameMs(): number {
    return this.chunker.frameMs;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  /** 新しい generation を開始する。sessionElapsedMs はセッション開始からの経過時間。 */
  startGeneration(sessionElapsedMs: number): number {
    this.generation += 1;
    this.sequence = 0;
    this.emittedSamples = 0;
    this.baseMs = Math.max(0, Math.round(sessionElapsedMs));
    this.chunker.reset();
    this.vad?.reset();
    return this.generation;
  }

  /** 16kHz PCM16 を入れ、完成したフレームと VAD 遷移を返す。 */
  push(pcm: Int16Array): { frames: EncodedFrame[]; vad: VadTransition[] } {
    if (this.generation < 0) return { frames: [], vad: [] };
    const frames: EncodedFrame[] = [];
    const vad: VadTransition[] = [];
    for (const chunk of this.chunker.push(pcm)) {
      const audioStartMs = this.baseMs + (this.emittedSamples * 1000) / AUDIO_SAMPLE_RATE;
      const durationMs = (chunk.length * 1000) / AUDIO_SAMPLE_RATE;
      const header: AudioFrameHeader = {
        sessionId: this.sessionId,
        source: this.source,
        streamGeneration: this.generation,
        sequence: this.sequence++,
        audioStartMs,
        durationMs,
        sampleRate: AUDIO_SAMPLE_RATE,
        encoding: AUDIO_ENCODING,
        channels: AUDIO_CHANNELS,
      };
      this.emittedSamples += chunk.length;
      frames.push({ header, bytes: encodeAudioFrame(header, chunk) });
      if (this.vad) {
        const t = this.vad.update(toDbfs(rms(chunk)), durationMs, audioStartMs);
        if (t) vad.push(t);
      }
    }
    return { frames, vad };
  }
}
