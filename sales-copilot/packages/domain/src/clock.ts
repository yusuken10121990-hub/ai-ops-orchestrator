/** 時刻の注入点。ドメインは Date.now() を直接呼ばない。 */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** テスト用の手動時計。 */
export class ManualClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): number {
    this.t += ms;
    return this.t;
  }
}

export type IdGenerator = (prefix: string) => string;

/** 連番 ID 生成器（決定的・テスト向け。本番は crypto.randomUUID ベースを注入してよい）。 */
export function createSequentialIdGenerator(): IdGenerator {
  const counters = new Map<string, number>();
  return (prefix) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}_${n}`;
  };
}
