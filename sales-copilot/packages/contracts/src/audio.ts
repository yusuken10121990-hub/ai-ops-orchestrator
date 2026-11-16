import { z } from 'zod';

/**
 * 入力経路の分類（SPEC §6-1）。本人確認・話者分離ではない。
 * REMOTE = 会議タブ音声（相手が複数でも「会議側」）、SELF = 明示的に選択した自分のマイク。
 */
export const AudioSource = z.enum(['SELF', 'REMOTE', 'UNKNOWN']);
export type AudioSource = z.infer<typeof AudioSource>;

/** 取得系統として実在する入力（UNKNOWN は取得系統ではない）。 */
export const CaptureSource = z.enum(['SELF', 'REMOTE']);
export type CaptureSource = z.infer<typeof CaptureSource>;

export const AUDIO_SAMPLE_RATE = 16000 as const;
export const AUDIO_ENCODING = 'pcm16le' as const;
export const AUDIO_CHANNELS = 1 as const;
/** 1フレームの推奨長（SPEC §6-3: 100〜250ms）。 */
export const AUDIO_FRAME_MIN_MS = 20;
export const AUDIO_FRAME_MAX_MS = 1000;
export const AUDIO_FRAME_HEADER_MAX_BYTES = 4096;
/** 1msあたりのバイト数（16kHz × 2byte × 1ch）。 */
export const AUDIO_BYTES_PER_MS = (AUDIO_SAMPLE_RATE / 1000) * 2 * AUDIO_CHANNELS;

export const AudioFrameHeader = z
  .object({
    sessionId: z.string().min(1).max(128),
    source: AudioSource,
    /** 再接続・デバイス変更ごとに増やす。重複排除と時刻整列の単位。 */
    streamGeneration: z.number().int().nonnegative(),
    /** streamGeneration 内で単調増加。 */
    sequence: z.number().int().nonnegative(),
    /** セッション開始からの音声時刻（ms）。 */
    audioStartMs: z.number().nonnegative(),
    durationMs: z.number().positive().max(AUDIO_FRAME_MAX_MS),
    /** 実際に 16kHz へリサンプリング済みであること。48kHz にラベルだけ付けるのは禁止（SPEC §6-3）。 */
    sampleRate: z.literal(AUDIO_SAMPLE_RATE),
    encoding: z.literal(AUDIO_ENCODING),
    channels: z.literal(AUDIO_CHANNELS),
  })
  .strict();
export type AudioFrameHeader = z.infer<typeof AudioFrameHeader>;

export type AudioFrameDecodeErrorCode =
  | 'too_short'
  | 'header_too_large'
  | 'header_not_json'
  | 'header_invalid'
  | 'pcm_odd_length'
  | 'duration_mismatch';

export class AudioFrameError extends Error {
  constructor(
    readonly code: AudioFrameDecodeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AudioFrameError';
  }
}

export interface AudioFrame {
  header: AudioFrameHeader;
  /** PCM16 little-endian のバイト列（コピー済み・offset 0）。 */
  pcm: Uint8Array;
}

/** PCM バイト長から算出した長さと header.durationMs の許容誤差（ms）。 */
const DURATION_TOLERANCE_MS = 1;

function checkDuration(header: AudioFrameHeader, pcmByteLength: number): void {
  if (pcmByteLength % 2 !== 0) {
    throw new AudioFrameError('pcm_odd_length', `PCM16 byte length must be even (got ${pcmByteLength})`);
  }
  const actualMs = pcmByteLength / AUDIO_BYTES_PER_MS;
  if (Math.abs(actualMs - header.durationMs) > DURATION_TOLERANCE_MS) {
    throw new AudioFrameError(
      'duration_mismatch',
      `durationMs=${header.durationMs} does not match PCM length (${actualMs}ms at 16kHz mono PCM16)`,
    );
  }
}

function toBytes(pcm: Uint8Array | Int16Array): Uint8Array {
  if (pcm instanceof Int16Array) {
    // 常に little-endian で書き出す（実行環境のエンディアンに依存しない）。
    const out = new Uint8Array(pcm.length * 2);
    const view = new DataView(out.buffer);
    for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
    return out;
  }
  return pcm;
}

/**
 * バイナリ WS フレーム: [u32 LE ヘッダー長][ヘッダー JSON (UTF-8)][PCM16LE バイト列]
 */
export function encodeAudioFrame(header: AudioFrameHeader, pcm: Uint8Array | Int16Array): Uint8Array {
  const parsed = AudioFrameHeader.safeParse(header);
  if (!parsed.success) {
    throw new AudioFrameError('header_invalid', parsed.error.message);
  }
  const pcmBytes = toBytes(pcm);
  checkDuration(parsed.data, pcmBytes.byteLength);
  const headerBytes = new TextEncoder().encode(JSON.stringify(parsed.data));
  if (headerBytes.byteLength > AUDIO_FRAME_HEADER_MAX_BYTES) {
    throw new AudioFrameError('header_too_large', 'audio frame header too large');
  }
  const out = new Uint8Array(4 + headerBytes.byteLength + pcmBytes.byteLength);
  new DataView(out.buffer).setUint32(0, headerBytes.byteLength, true);
  out.set(headerBytes, 4);
  out.set(pcmBytes, 4 + headerBytes.byteLength);
  return out;
}

export function decodeAudioFrame(data: ArrayBuffer | ArrayBufferView): AudioFrame {
  const bytes =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength < 4) throw new AudioFrameError('too_short', 'audio frame too short');
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (headerLen === 0 || headerLen > AUDIO_FRAME_HEADER_MAX_BYTES) {
    throw new AudioFrameError('header_too_large', `invalid header length ${headerLen}`);
  }
  if (bytes.byteLength < 4 + headerLen) throw new AudioFrameError('too_short', 'audio frame truncated');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(4, 4 + headerLen)));
  } catch {
    throw new AudioFrameError('header_not_json', 'audio frame header is not valid JSON');
  }
  const parsed = AudioFrameHeader.safeParse(raw);
  if (!parsed.success) throw new AudioFrameError('header_invalid', parsed.error.message);
  const pcm = bytes.slice(4 + headerLen);
  checkDuration(parsed.data, pcm.byteLength);
  return { header: parsed.data, pcm };
}

/** PCM16LE バイト列 → Int16Array（エンディアン非依存）。 */
export function pcmBytesToInt16(pcm: Uint8Array): Int16Array {
  const out = new Int16Array(Math.floor(pcm.byteLength / 2));
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

/** サンプル数から durationMs を求める（16kHz）。 */
export function samplesToDurationMs(samples: number): number {
  return (samples * 1000) / AUDIO_SAMPLE_RATE;
}
