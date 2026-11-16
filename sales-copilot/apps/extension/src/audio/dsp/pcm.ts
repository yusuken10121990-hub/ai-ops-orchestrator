/** 複数チャンネルを平均してモノラル化する（SPEC §6-3）。 */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first.slice();
  const n = first.length;
  const out = new Float32Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) out[i]! += ch[i] ?? 0;
  }
  const inv = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i]! *= inv;
  return out;
}

/** Float32 [-1, 1] → PCM16（クリップ・丸め）。 */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = input[i]!;
    if (!(s === s)) s = 0; // NaN
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** RMS（0〜1）。 */
export function rms(input: Float32Array | Int16Array): number {
  if (input.length === 0) return 0;
  const scale = input instanceof Int16Array ? 1 / 0x8000 : 1;
  let acc = 0;
  for (let i = 0; i < input.length; i++) {
    const v = input[i]! * scale;
    acc += v * v;
  }
  return Math.sqrt(acc / input.length);
}

/** RMS → dBFS（下限 -100）。 */
export function toDbfs(value: number): number {
  if (value <= 1e-5) return -100;
  return Math.max(-100, 20 * Math.log10(value));
}
