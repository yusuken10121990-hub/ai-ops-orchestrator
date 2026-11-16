import type { CaptureSource } from '@sales-copilot/contracts';

export interface ReplayLine {
  atMs: number;
  source: CaptureSource | 'UNKNOWN';
  text: string;
  isFinal: boolean;
}

export interface ReplayScript {
  name: string;
  lines: ReplayLine[];
}

export interface ReplayEmit {
  source: CaptureSource;
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
  startMs: number;
  endMs: number;
}

/**
 * OFFLINE 再生（架空会話のタイムライン → 疑似 STT 結果）。外部送信なし。
 * - 区間の開始時刻 = 同じ系統で直前の final 以降の最初の行の時刻（-500ms の推定余白）
 * - final 行は区間 final かつ発話終了（speech_final）として流す
 * - pause/resume で再生位置を保持し、stop 後は何も流さない
 */
export class ReplayDriver {
  private idx = 0;
  private elapsedBeforePause = 0;
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private readonly segStart: Partial<Record<CaptureSource, number>> = {};
  private readonly lines: ReplayLine[];

  constructor(
    script: ReplayScript,
    private readonly speed: number,
    private readonly emit: (e: ReplayEmit) => void,
    private readonly onDone: () => void = () => {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.lines = [...script.lines].filter((l) => l.source !== 'UNKNOWN').sort((a, b) => a.atMs - b.atMs);
  }

  get finished(): boolean {
    return this.idx >= this.lines.length;
  }

  start(): void {
    if (this.stopped || this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.schedule();
  }

  pause(): void {
    if (!this.running) return;
    this.elapsedBeforePause += (this.now() - this.startedAt) * this.speed;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  resume(): void {
    this.start();
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scriptNow(): number {
    return this.elapsedBeforePause + (this.now() - this.startedAt) * this.speed;
  }

  private schedule(): void {
    if (!this.running || this.stopped) return;
    if (this.finished) {
      this.running = false;
      this.onDone();
      return;
    }
    const next = this.lines[this.idx]!;
    const wait = Math.max(0, (next.atMs - this.scriptNow()) / this.speed);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running || this.stopped) return;
      // 同時刻までに到達した行をまとめて流す
      while (!this.finished && this.lines[this.idx]!.atMs <= this.scriptNow() + 1) {
        const l = this.lines[this.idx++]!;
        const src = l.source as CaptureSource;
        const start = this.segStart[src] ?? Math.max(0, l.atMs - 500);
        this.segStart[src] = start;
        if (l.isFinal) delete this.segStart[src];
        this.emit({ source: src, text: l.text, isFinal: l.isFinal, speechFinal: l.isFinal, startMs: start, endMs: l.atMs });
        if (this.stopped || !this.running) return;
      }
      this.schedule();
    }, wait);
  }
}
