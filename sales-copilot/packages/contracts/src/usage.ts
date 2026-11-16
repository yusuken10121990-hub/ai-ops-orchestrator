import { z } from 'zod';

/** 通貨は混ぜない（SPEC §15）。価格表は1通貨。 */
export const Currency = z.enum(['USD', 'JPY']);
export type Currency = z.infer<typeof Currency>;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/**
 * 任意の価格表。出典と確認日が必須。未設定なら金額は推測せず null（使用量のみ表示）。
 * 各単価が欠けている場合も、その分の金額は推測しない。
 */
export const PriceTable = z
  .object({
    currency: Currency,
    source: z.string().min(1).max(500),
    checkedDate: IsoDate,
    sttPerMinute: z.number().nonnegative().nullable(),
    llmInputPerMTok: z.number().nonnegative().nullable(),
    llmOutputPerMTok: z.number().nonnegative().nullable(),
  })
  .strict();
export type PriceTable = z.infer<typeof PriceTable>;

/** セッション上限。null は上限なし。80% で警告、100% で新規外部処理を停止。 */
export const BudgetLimits = z
  .object({
    maxSttSeconds: z.number().positive().nullable(),
    maxLlmCalls: z.number().int().positive().nullable(),
    maxLlmInputTokens: z.number().int().positive().nullable(),
    maxLlmOutputTokens: z.number().int().positive().nullable(),
    /** 価格表の通貨での上限。価格表なしでは評価しない。 */
    maxCost: z.number().positive().nullable(),
  })
  .strict();
export type BudgetLimits = z.infer<typeof BudgetLimits>;

export const BudgetLevel = z.enum(['ok', 'warn', 'blocked']);
export type BudgetLevel = z.infer<typeof BudgetLevel>;

export const BudgetMetric = z.enum(['stt_seconds', 'llm_calls', 'llm_input_tokens', 'llm_output_tokens', 'cost']);
export type BudgetMetric = z.infer<typeof BudgetMetric>;

export const BudgetState = z
  .object({
    level: BudgetLevel,
    /** 80% 以上に達した指標と割合（0〜1+）。 */
    metrics: z.array(z.object({ metric: BudgetMetric, ratio: z.number().nonnegative(), level: BudgetLevel }).strict()),
  })
  .strict();
export type BudgetState = z.infer<typeof BudgetState>;

export const EstimatedCost = z
  .object({
    amount: z.number().nonnegative(),
    currency: Currency,
    priceSource: z.string(),
    priceCheckedDate: IsoDate,
  })
  .strict();
export type EstimatedCost = z.infer<typeof EstimatedCost>;

export const UsageSnapshot = z
  .object({
    /** STT へ送った音声秒数（自分側・会議側を別集計）。 */
    sttSecondsBySource: z
      .object({ SELF: z.number().nonnegative(), REMOTE: z.number().nonnegative(), UNKNOWN: z.number().nonnegative() })
      .strict(),
    /** プロバイダーが報告した実 usage のみ。 */
    llmInputTokens: z.number().int().nonnegative(),
    llmOutputTokens: z.number().int().nonnegative(),
    /** LLM 呼び出し回数。 */
    calls: z.number().int().nonnegative(),
    /** 価格表が無い・単価が欠けている場合は null（推測しない）。 */
    estimatedCost: EstimatedCost.nullable(),
    budget: BudgetState,
  })
  .strict();
export type UsageSnapshot = z.infer<typeof UsageSnapshot>;
