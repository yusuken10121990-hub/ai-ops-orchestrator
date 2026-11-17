import type {
  AudioSource,
  BudgetLevel,
  BudgetLimits,
  BudgetMetric,
  BudgetState,
  EstimatedCost,
  PriceTable,
  UsageSnapshot,
} from '@sales-copilot/contracts';

export const BUDGET_WARN_RATIO = 0.8;

export const NO_BUDGET_LIMITS: BudgetLimits = {
  maxSttSeconds: null,
  maxLlmCalls: null,
  maxLlmInputTokens: null,
  maxLlmOutputTokens: null,
  maxCost: null,
};

export interface SttFrameUsage {
  source: AudioSource;
  streamGeneration: number;
  sequence: number;
  durationMs: number;
}

export interface LlmUsage {
  /** 呼び出しID（同じ呼び出しの usage を二重計上しない）。 */
  callId: string;
  /** プロバイダーが報告した実 usage。未報告なら null（推測で埋めない）。 */
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * auto = 自動カード（ANTHROPIC_MODEL）/ manual = 手動ボタン（ANTHROPIC_MANUAL_MODEL）。
   * 単価がモデルごとに違うため金額は分けて計算する。省略時は auto。
   */
  tier?: 'auto' | 'manual';
}

export type ExternalCallKind = 'stt' | 'llm';

/**
 * 使用量・費用・上限（SPEC §15）。
 * - STT 秒数は自分側・会議側を別集計、(source, generation, sequence) で重複計上しない
 * - LLM は実 usage のみ、callId で重複計上しない
 * - 価格表が無い・単価が欠けていれば金額は null（推測しない）
 * - 80% で警告、100% で新規外部処理を停止
 */
export class UsageMeter {
  private readonly sttMs: Record<AudioSource, number> = { SELF: 0, REMOTE: 0, UNKNOWN: 0 };
  private readonly seenFrames = new Set<string>();
  private readonly seenCalls = new Set<string>();
  private inTok = 0;
  private outTok = 0;
  /** 上のうち手動ボタン分（単価が別）。 */
  private manualInTok = 0;
  private manualOutTok = 0;
  private manualCalls = 0;
  private calls = 0;
  private unreportedCalls = 0;

  constructor(
    private readonly priceTable: PriceTable | null = null,
    private readonly limits: BudgetLimits = NO_BUDGET_LIMITS,
  ) {}

  /** STT へ送った音声フレームを計上。重複なら false。 */
  addSttFrame(f: SttFrameUsage): boolean {
    const key = `${f.source}|${f.streamGeneration}|${f.sequence}`;
    if (this.seenFrames.has(key)) return false;
    this.seenFrames.add(key);
    this.sttMs[f.source] += Math.max(0, f.durationMs);
    return true;
  }

  /** LLM 呼び出しを計上。重複 callId なら false。 */
  addLlmUsage(u: LlmUsage): boolean {
    if (this.seenCalls.has(u.callId)) return false;
    this.seenCalls.add(u.callId);
    this.calls++;
    if (u.inputTokens === null || u.outputTokens === null) this.unreportedCalls++;
    const inTok = Math.max(0, u.inputTokens ?? 0);
    const outTok = Math.max(0, u.outputTokens ?? 0);
    this.inTok += inTok;
    this.outTok += outTok;
    if (u.tier === 'manual') {
      this.manualCalls++;
      this.manualInTok += inTok;
      this.manualOutTok += outTok;
    }
    return true;
  }

  get sttSecondsTotal(): number {
    return (this.sttMs.SELF + this.sttMs.REMOTE + this.sttMs.UNKNOWN) / 1000;
  }

  /** usage 未報告の呼び出し数（この分のトークン・金額は不明）。 */
  get unreportedLlmCalls(): number {
    return this.unreportedCalls;
  }

  estimatedCost(): EstimatedCost | null {
    const p = this.priceTable;
    if (!p) return null;
    const usesStt = this.sttSecondsTotal > 0;
    const usesAutoLlm = this.calls - this.manualCalls > 0;
    const usesManualLlm = this.manualCalls > 0;
    if (usesStt && p.sttPerMinute === null) return null;
    if (usesAutoLlm && (p.llmInputPerMTok === null || p.llmOutputPerMTok === null)) return null;
    // 手動ボタン用モデルの単価が無ければ推測しない（別モデルの単価で代用しない）
    const mIn = p.llmManualInputPerMTok ?? null;
    const mOut = p.llmManualOutputPerMTok ?? null;
    if (usesManualLlm && (mIn === null || mOut === null)) return null;
    if (this.unreportedCalls > 0) return null;
    const autoIn = this.inTok - this.manualInTok;
    const autoOut = this.outTok - this.manualOutTok;
    const amount =
      (usesStt ? (this.sttSecondsTotal / 60) * (p.sttPerMinute ?? 0) : 0) +
      (usesAutoLlm ? (autoIn / 1e6) * (p.llmInputPerMTok ?? 0) + (autoOut / 1e6) * (p.llmOutputPerMTok ?? 0) : 0) +
      (usesManualLlm ? (this.manualInTok / 1e6) * (mIn ?? 0) + (this.manualOutTok / 1e6) * (mOut ?? 0) : 0);
    return { amount, currency: p.currency, priceSource: p.source, priceCheckedDate: p.checkedDate };
  }

  budgetState(): BudgetState {
    const metrics: BudgetState['metrics'] = [];
    const check = (metric: BudgetMetric, value: number, limit: number | null) => {
      if (limit === null || limit <= 0) return;
      const ratio = value / limit;
      if (ratio >= BUDGET_WARN_RATIO) metrics.push({ metric, ratio, level: ratio >= 1 ? 'blocked' : 'warn' });
    };
    check('stt_seconds', this.sttSecondsTotal, this.limits.maxSttSeconds);
    check('llm_calls', this.calls, this.limits.maxLlmCalls);
    check('llm_input_tokens', this.inTok, this.limits.maxLlmInputTokens);
    check('llm_output_tokens', this.outTok, this.limits.maxLlmOutputTokens);
    const cost = this.estimatedCost();
    if (cost) check('cost', cost.amount, this.limits.maxCost);
    const level: BudgetLevel = metrics.some((m) => m.level === 'blocked')
      ? 'blocked'
      : metrics.length > 0
        ? 'warn'
        : 'ok';
    return { level, metrics };
  }

  /** 新規外部処理を開始してよいか（上限到達で停止）。 */
  canStartExternalCall(kind: ExternalCallKind): boolean {
    const st = this.budgetState();
    if (st.level !== 'blocked') return true;
    const blocked = new Set(st.metrics.filter((m) => m.level === 'blocked').map((m) => m.metric));
    // 金額上限は全外部処理を止める。種類別の上限はその種類だけ止める。
    if (blocked.has('cost')) return false;
    if (kind === 'stt') return !blocked.has('stt_seconds');
    return !(blocked.has('llm_calls') || blocked.has('llm_input_tokens') || blocked.has('llm_output_tokens'));
  }

  snapshot(): UsageSnapshot {
    return {
      sttSecondsBySource: {
        SELF: this.sttMs.SELF / 1000,
        REMOTE: this.sttMs.REMOTE / 1000,
        UNKNOWN: this.sttMs.UNKNOWN / 1000,
      },
      llmInputTokens: this.inTok,
      llmOutputTokens: this.outTok,
      calls: this.calls,
      estimatedCost: this.estimatedCost(),
      budget: this.budgetState(),
    };
  }
}
