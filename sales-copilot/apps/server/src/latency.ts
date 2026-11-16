import type { CaptureSource, LatencyStats, LatencySummary } from '@sales-copilot/contracts';

export type { LatencyStats } from '@sales-copilot/contracts';

/**
 * 遅延計測（SPEC §8-3, docs/latency.md）。時計はすべてサーバーの Date.now()（epoch ms）に統一。
 *
 * 1. speechEnd   … 相手の発話終了推定。Deepgram の speech_final / UtteranceEnd が示す発話終端（音声時刻）を、
 *                  その音声フレームがサーバーに届いた時刻へ写像した値（クライアント取得遅延 ~100-250ms は含まない）。
 * 2. sttFinal    … その final をサーバーが受信した時刻
 * 3. requested   … 生成要求（スケジューラーが start を出した）時刻
 * 4. validated   … 生成結果の検証完了時刻
 * 5. sent        … advice.card をクライアントへ送信した時刻
 * 6. displayAck  … クライアントの advice.displayed をサーバーが受信した時刻（クライアント時計は使わない）
 */
export type Summary = LatencySummary;

export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  // nearest-rank
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

function summarize(xs: readonly number[]): Summary {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), max: s.length ? s[s.length - 1]! : null };
}

class Bounded {
  readonly xs: number[] = [];
  constructor(private readonly cap = 2000) {}
  push(x: number): void {
    if (!Number.isFinite(x) || x < 0) return;
    this.xs.push(x);
    if (this.xs.length > this.cap) this.xs.shift();
  }
}

interface SpeechMark {
  speechEndAt: number;
  sttFinalAt: number;
}

interface SentMark {
  sentAt: number;
  speechEndAt: number | null;
}

interface JobMark {
  requestedAt: number;
  triggerUtteranceId: string | null;
  validatedAt: number | null;
}

export class LatencyTracker {
  private readonly arrivals: Record<CaptureSource, Array<{ audioEndMs: number; at: number }>> = { SELF: [], REMOTE: [] };
  private readonly speech = new Map<string, SpeechMark>();
  private readonly jobs = new Map<string, JobMark>();
  private readonly sentCards = new Map<string, SentMark>();
  private readonly s = {
    speechToStt: new Bounded(),
    speechToSent: new Bounded(),
    sttToSent: new Bounded(),
    reqToValidated: new Bounded(),
    validatedToSent: new Bounded(),
    sentToDisplayed: new Bounded(),
    speechToDisplayed: new Bounded(),
  };
  readonly counts: LatencyStats['counts'] = {
    eligible: 0,
    started: 0,
    displayed: 0,
    displayAcked: 0,
    noAdvice: 0,
    discarded: 0,
    timeout: 0,
    failed: 0,
    fallback: 0,
  };

  /** 音声フレームの到着（音声時刻 → サーバー時刻の対応を記録）。 */
  audioArrived(source: CaptureSource, audioEndMs: number, at: number): void {
    const a = this.arrivals[source];
    a.push({ audioEndMs, at });
    if (a.length > 3000) a.splice(0, a.length - 3000);
  }

  /** 音声時刻 t を含むフレームがサーバーに届いた時刻。記録が無ければ null。 */
  wallTimeForAudio(source: CaptureSource, audioMs: number): number | null {
    const a = this.arrivals[source];
    let lo = 0;
    let hi = a.length - 1;
    let ans: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid]!.audioEndMs >= audioMs) {
        ans = a[mid]!.at;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
  }

  /** 発話終端（speech_final / UtteranceEnd）を記録。最初の1回だけ有効。 */
  speechEnded(utteranceId: string, speechEndAt: number, sttFinalAt: number): void {
    if (this.speech.has(utteranceId)) return;
    const end = Math.min(speechEndAt, sttFinalAt);
    this.speech.set(utteranceId, { speechEndAt: end, sttFinalAt });
    this.s.speechToStt.push(sttFinalAt - end);
    if (this.speech.size > 1000) this.speech.delete(this.speech.keys().next().value!);
  }

  eligible(): void {
    this.counts.eligible++;
  }

  requested(jobId: string, triggerUtteranceId: string | null, at: number): void {
    this.counts.started++;
    this.jobs.set(jobId, { requestedAt: at, triggerUtteranceId, validatedAt: null });
    if (this.jobs.size > 500) this.jobs.delete(this.jobs.keys().next().value!);
  }

  validated(jobId: string, at: number): void {
    const j = this.jobs.get(jobId);
    if (!j) return;
    j.validatedAt = at;
    this.s.reqToValidated.push(at - j.requestedAt);
  }

  sent(jobId: string, at: number, adviceId?: string): void {
    this.counts.displayed++;
    const j = this.jobs.get(jobId);
    if (!j) return;
    if (j.validatedAt !== null) this.s.validatedToSent.push(at - j.validatedAt);
    const sp = j.triggerUtteranceId ? this.speech.get(j.triggerUtteranceId) : undefined;
    if (sp) {
      this.s.speechToSent.push(at - sp.speechEndAt);
      this.s.sttToSent.push(at - sp.sttFinalAt);
    }
    if (adviceId) {
      this.sentCards.set(adviceId, { sentAt: at, speechEndAt: sp?.speechEndAt ?? null });
      if (this.sentCards.size > 500) this.sentCards.delete(this.sentCards.keys().next().value!);
    }
    this.jobs.delete(jobId);
  }

  /**
   * クライアントが画面に反映した（advice.displayed）。at はサーバーの受信時刻。
   * 未知の adviceId・2回目以降の報告は無視する（重複計上しない）。
   */
  displayed(adviceId: string, at: number): boolean {
    const m = this.sentCards.get(adviceId);
    if (!m) return false;
    this.sentCards.delete(adviceId);
    this.counts.displayAcked++;
    this.s.sentToDisplayed.push(at - m.sentAt);
    if (m.speechEndAt !== null) this.s.speechToDisplayed.push(at - m.speechEndAt);
    return true;
  }

  outcome(kind: 'noAdvice' | 'discarded' | 'timeout' | 'failed' | 'fallback'): void {
    this.counts[kind]++;
  }

  stats(): LatencyStats {
    return {
      counts: { ...this.counts },
      speechEndToSttFinalMs: summarize(this.s.speechToStt.xs),
      speechEndToSentMs: summarize(this.s.speechToSent.xs),
      sttFinalToSentMs: summarize(this.s.sttToSent.xs),
      requestedToValidatedMs: summarize(this.s.reqToValidated.xs),
      validatedToSentMs: summarize(this.s.validatedToSent.xs),
      sentToDisplayedMs: summarize(this.s.sentToDisplayed.xs),
      speechEndToDisplayedMs: summarize(this.s.speechToDisplayed.xs),
      target: { p50Ms: 3000, p95Ms: 5000 },
    };
  }
}
