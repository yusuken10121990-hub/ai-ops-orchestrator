import { normalizeText } from './text';

/**
 * ヘッドセットなしで商談すると、スピーカーから出た相手（REMOTE）の声が自分のマイク（SELF）にも入り、
 * 同じ内容が「自分の発言」として二重に文字起こしされる。SELF の確定発言のうち、
 * 直前（または同時）の REMOTE 発言と本文がほぼ同じものを回り込みとみなして捨てるための純粋ロジック。
 *
 * 保守的に判定する（本人の正当な発言を消さないことを優先）:
 * - 本文がほぼ同じ（類似度 strongThreshold 以上。SELF が REMOTE に丸ごと含まれる場合を含む）:
 *   REMOTE 発言の区間を前後 windowMs 広げた範囲に SELF 発言が重なれば回り込み
 * - 本文が似ている（threshold 以上 strongThreshold 未満）: 実際に時間が重なっている（jitterMs の誤差のみ許容）ときだけ。
 *   相手の言葉を言い直す「オウム返し」は相手が話し終えた後に始まるので、ここで消さない
 * - 短い発言（正規化後 minChars 文字未満。「はい」等）は、本文が完全一致し、かつ実際に時間が重なるときだけ
 */

export interface TimedText {
  text: string;
  /** 比較に使う時刻（同じ時計で測った ms。サーバーでは音声の到着時刻）。 */
  startMs: number;
  endMs: number;
}

export interface EchoMatchOptions {
  /** 類似とみなす下限（0〜1）。この値以上 strongThreshold 未満は「実際に時間が重なる」ときだけ回り込み。 */
  threshold?: number;
  /** ほぼ同じ本文とみなす下限（0〜1）。 */
  strongThreshold?: number;
  /** 2系統の時刻のずれとして許す誤差（ms）。 */
  jitterMs?: number;
  /** REMOTE 発言の終了から SELF 発言の開始までの許容（ms）。開始側にも同じ余裕を持たせる。 */
  windowMs?: number;
  /** これ未満（正規化後の文字数）の短い発言は完全一致のときだけ回り込みとみなす。 */
  minChars?: number;
  /** 含有で判定するときの、短い方の最小文字数。 */
  minContainChars?: number;
}

export const ECHO_DEFAULTS: Required<EchoMatchOptions> = {
  threshold: 0.6,
  strongThreshold: 0.8,
  jitterMs: 300,
  windowMs: 2000,
  minChars: 4,
  minContainChars: 6,
};

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const chars = [...s];
  if (chars.length === 1) {
    m.set(chars[0]!, 1);
    return m;
  }
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i]! + chars[i + 1]!;
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** 文字 bigram の Dice 係数（正規化済み文字列同士）。 */
export function bigramDice(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const n of A.values()) total += n;
  for (const n of B.values()) total += n;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) ?? 0);
  return total === 0 ? 0 : (2 * inter) / total;
}

/** 時刻が重なるか（REMOTE 区間を前後 windowMs だけ広げる）。 */
export function echoTimingMatches(self: TimedText, remote: TimedText, windowMs = ECHO_DEFAULTS.windowMs): boolean {
  return self.startMs <= remote.endMs + windowMs && self.endMs >= remote.startMs - windowMs;
}

/**
 * 回り込み判定用の方向つき類似度: SELF（回り込み側）が REMOTE に丸ごと含まれる（部分的にしか認識されなかった）なら 1。
 * SELF の方が長く REMOTE を含む場合（本人が相手の言葉を引用して付け足した）は含有扱いにせず Dice で比べる。
 */
export function selfEchoSimilarity(selfText: string, remoteText: string, opts: EchoMatchOptions = {}): number {
  const o = { ...ECHO_DEFAULTS, ...opts };
  const ns = normalizeText(selfText);
  const nr = normalizeText(remoteText);
  if (ns.length === 0 || nr.length === 0) return 0;
  if (ns === nr) return 1;
  if ([...ns].length >= o.minContainChars && nr.includes(ns)) return 1;
  return bigramDice(ns, nr);
}

/** SELF の発言が REMOTE の発言の回り込みらしいか。 */
export function isLikelyEcho(self: TimedText, remote: TimedText, opts: EchoMatchOptions = {}): boolean {
  const o = { ...ECHO_DEFAULTS, ...opts };
  if (!echoTimingMatches(self, remote, o.windowMs)) return false;
  const ns = normalizeText(self.text);
  const nr = normalizeText(remote.text);
  if (ns.length === 0 || nr.length === 0) return false;
  const overlapping = echoTimingMatches(self, remote, o.jitterMs);
  if ([...ns].length < o.minChars) {
    // 「はい」「ええ」などは自分も言う。完全一致かつ実際に時間が重なるときだけ
    return ns === nr && overlapping;
  }
  const sim = selfEchoSimilarity(self.text, remote.text, o);
  if (sim >= o.strongThreshold) return true;
  return sim >= o.threshold && overlapping;
}

interface Entry extends TimedText {
  id: string;
}

/**
 * セッション中の回り込み判定器。直近の REMOTE / SELF 確定発言だけを短時間保持する（本文はメモリのみ・ログに出さない）。
 * - SELF が後から届いた: shouldDropSelf で取り込み前に捨てる
 * - SELF が先に届いていた: recordRemote が一致した SELF の ID を返す（呼び出し側で助言に使わないようにする）
 */
export class CrossChannelEchoFilter {
  private readonly o: Required<EchoMatchOptions>;
  private readonly remote = new Map<string, Entry>();
  private readonly self = new Map<string, Entry>();
  /** 保持期間（ms）。これより古い発言とは比べない。 */
  private readonly retainMs: number;
  private dropped = 0;

  constructor(opts: EchoMatchOptions & { retainMs?: number } = {}) {
    this.o = { ...ECHO_DEFAULTS, ...opts };
    this.retainMs = opts.retainMs ?? 15_000;
  }

  /** 捨てた・除外した SELF 発言の件数（ログには件数だけを出す）。 */
  get droppedCount(): number {
    return this.dropped;
  }

  /** REMOTE の確定発言（同じ ID は本文・区間を更新）。先に取り込まれていた一致 SELF の ID を返す。 */
  recordRemote(id: string, t: TimedText): string[] {
    this.prune(t.endMs);
    this.remote.set(id, { id, ...t });
    const hits: string[] = [];
    for (const s of this.self.values()) {
      if (isLikelyEcho(s, t, this.o)) hits.push(s.id);
    }
    for (const h of hits) {
      this.self.delete(h);
      this.dropped++;
    }
    return hits;
  }

  /** SELF の確定発言を取り込む前に呼ぶ。回り込みなら true（取り込まない）。 */
  shouldDropSelf(t: TimedText): boolean {
    this.prune(t.endMs);
    for (const r of this.remote.values()) {
      if (isLikelyEcho(t, r, this.o)) {
        this.dropped++;
        return true;
      }
    }
    return false;
  }

  /** 取り込んだ SELF 発言を記録（後から届く REMOTE と照合するため）。 */
  recordSelf(id: string, t: TimedText): void {
    this.prune(t.endMs);
    this.self.set(id, { id, ...t });
  }

  clear(): void {
    this.remote.clear();
    this.self.clear();
  }

  private prune(now: number): void {
    const cutoff = now - this.retainMs;
    for (const m of [this.remote, this.self]) {
      for (const [id, e] of m) if (e.endMs < cutoff) m.delete(id);
    }
  }
}
