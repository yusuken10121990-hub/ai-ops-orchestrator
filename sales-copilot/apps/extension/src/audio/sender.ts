import type { CaptureSource } from '@sales-copilot/contracts';
import type { EncodedFrame } from './framer';

/** WebSocket の必要最小限（テストで差し替える）。 */
export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export const WS_OPEN = 1;

/** 既定の送信待ち上限: 約 2 秒分（16kHz×2byte×2系統 = 64KB/s）。 */
export const DEFAULT_MAX_BUFFERED_BYTES = 128 * 1024;

export interface AudioGap {
  source: CaptureSource;
  streamGeneration: number;
  fromMs: number;
  toMs: number;
  droppedFrames: number;
}

/**
 * バックプレッシャー付き送信（SPEC §6-3）。
 * bufferedAmount が上限を超えている間のフレームは破棄し、欠落区間として記録する。
 * 復旧後に破棄した音声を再送しない（無制限に溜めない）。
 */
export class BackpressureSender {
  private open: Partial<Record<CaptureSource, AudioGap>> = {};
  private closed = false;
  readonly gaps: AudioGap[] = [];
  sentFrames = 0;
  droppedFrames = 0;

  constructor(
    private readonly socket: SocketLike,
    private readonly maxBufferedBytes: number = DEFAULT_MAX_BUFFERED_BYTES,
    private readonly onGap: (gap: AudioGap, phase: 'start' | 'end') => void = () => {},
  ) {}

  /** まだ閉じていない欠落区間を確定して返す（停止・終了の直前に呼ぶ）。 */
  flushOpenGaps(): AudioGap[] {
    const out: AudioGap[] = [];
    for (const src of ['SELF', 'REMOTE'] as const) {
      const g = this.open[src];
      if (!g) continue;
      delete this.open[src];
      this.gaps.push(g);
      out.push(g);
    }
    return out;
  }

  /** 停止後は何も送らない。 */
  disable(): void {
    this.closed = true;
  }

  send(frame: EncodedFrame): 'sent' | 'dropped' | 'closed' {
    if (this.closed || this.socket.readyState !== WS_OPEN) return 'closed';
    const src = frame.header.source === 'SELF' ? 'SELF' : 'REMOTE';
    const endMs = frame.header.audioStartMs + frame.header.durationMs;
    if (this.socket.bufferedAmount + frame.bytes.byteLength > this.maxBufferedBytes) {
      this.droppedFrames++;
      const g = this.open[src];
      if (g && g.streamGeneration === frame.header.streamGeneration) {
        g.toMs = endMs;
        g.droppedFrames++;
      } else {
        const gap: AudioGap = {
          source: src,
          streamGeneration: frame.header.streamGeneration,
          fromMs: frame.header.audioStartMs,
          toMs: endMs,
          droppedFrames: 1,
        };
        this.open[src] = gap;
        this.onGap(gap, 'start');
      }
      return 'dropped';
    }
    const g = this.open[src];
    if (g) {
      delete this.open[src];
      this.gaps.push(g);
      this.onGap(g, 'end');
    }
    this.socket.send(frame.bytes);
    this.sentFrames++;
    return 'sent';
  }
}
