/**
 * ストリーミング用の窓付き sinc リサンプラー（SPEC §6-3）。
 *
 * 48kHz などの実サンプルレートから 16kHz へ、低域通過フィルタ（Blackman 窓 sinc）を掛けてから
 * 間引く。ラベルだけ 16kHz に付け替える処理ではない（テストで周波数保存・折り返し抑制を確認）。
 *
 * - 遮断周波数 = min(1, outRate/inRate) × rolloff（入力ナイキスト比）
 * - 出力 n 番目の入力上の位置は n × inRate / outRate を毎回計算する（累積誤差なし）
 * - ブロック境界をまたいでも同じ結果になるよう、必要な過去サンプルを保持する
 */
export interface ResamplerOptions {
  /** 片側のゼロ交差数。大きいほど急峻（既定 16）。 */
  zeroCrossings?: number;
  /** 遮断周波数の余裕（既定 0.9 = 出力ナイキストの 90%）。 */
  rolloff?: number;
}

const TABLE_OVERSAMPLE = 256;

export class StreamingResampler {
  readonly inRate: number;
  readonly outRate: number;
  private readonly fc: number;
  private readonly halfWidth: number;
  private readonly table: Float32Array;
  private buf: Float32Array = new Float32Array(0);
  /** buf[0] の絶対入力インデックス。 */
  private bufStart = 0;
  /** buf に入っている最後の絶対インデックス + 1。 */
  private bufEnd = 0;
  /** これまでに出力したサンプル数。 */
  private produced = 0;
  private readonly passthrough: boolean;

  constructor(inRate: number, outRate: number, opts: ResamplerOptions = {}) {
    if (!(inRate > 0) || !(outRate > 0)) throw new Error('sample rates must be positive');
    this.inRate = inRate;
    this.outRate = outRate;
    this.passthrough = inRate === outRate;
    const zc = opts.zeroCrossings ?? 16;
    const rolloff = opts.rolloff ?? 0.9;
    this.fc = Math.min(1, outRate / inRate) * rolloff;
    this.halfWidth = Math.ceil(zc / this.fc);
    // カーネル表: d = i / TABLE_OVERSAMPLE（0 .. halfWidth）
    const n = this.halfWidth * TABLE_OVERSAMPLE + 2;
    this.table = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d = i / TABLE_OVERSAMPLE;
      this.table[i] = d > this.halfWidth ? 0 : this.fc * sinc(this.fc * d) * blackman(d / this.halfWidth);
    }
    // 開始前は無音とみなす（halfWidth 分の 0 を先頭に置く）
    this.buf = new Float32Array(this.halfWidth);
    this.bufStart = -this.halfWidth;
    this.bufEnd = 0;
  }

  /** フィルタの片側幅（入力サンプル数）。遅延 = halfWidth / inRate 秒。 */
  get filterHalfWidth(): number {
    return this.halfWidth;
  }

  private kernel(d: number): number {
    const a = Math.abs(d) * TABLE_OVERSAMPLE;
    const i = Math.floor(a);
    if (i >= this.table.length - 1) return 0;
    const f = a - i;
    return this.table[i]! * (1 - f) + this.table[i + 1]! * f;
  }

  process(input: Float32Array): Float32Array {
    if (this.passthrough) {
      this.produced += input.length;
      return input.slice();
    }
    // 追記
    const keepFrom = this.bufStart;
    const merged = new Float32Array(this.bufEnd - keepFrom + input.length);
    merged.set(this.buf.subarray(0, this.bufEnd - keepFrom), 0);
    merged.set(input, this.bufEnd - keepFrom);
    this.buf = merged;
    this.bufEnd += input.length;

    const out: number[] = [];
    for (;;) {
      const pos = (this.produced * this.inRate) / this.outRate;
      const center = Math.floor(pos);
      if (center + this.halfWidth >= this.bufEnd) break;
      let acc = 0;
      let wsum = 0;
      const lo = Math.max(center - this.halfWidth + 1, this.bufStart);
      const hi = center + this.halfWidth;
      for (let k = lo; k <= hi; k++) {
        const w = this.kernel(pos - k);
        acc += this.buf[k - this.bufStart]! * w;
        wsum += w;
      }
      // DC 利得を正確に 1 にする
      out.push(wsum !== 0 ? acc / wsum : 0);
      this.produced++;
    }
    // 次の出力に必要な範囲だけ残す
    const nextCenter = Math.floor((this.produced * this.inRate) / this.outRate);
    const newStart = Math.max(this.bufStart, nextCenter - this.halfWidth);
    if (newStart > this.bufStart) {
      this.buf = this.buf.slice(newStart - this.bufStart, this.bufEnd - this.bufStart);
      this.bufStart = newStart;
    }
    return Float32Array.from(out);
  }

  /** 出力済みサンプル数。 */
  get outputCount(): number {
    return this.produced;
  }
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function blackman(u: number): number {
  // u ∈ [-1, 1]
  if (Math.abs(u) > 1) return 0;
  return 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
}
