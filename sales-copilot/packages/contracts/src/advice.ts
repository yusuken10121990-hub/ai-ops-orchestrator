import { z } from 'zod';

/** 表示文字数の上限（SPEC §4-1, §12）。文字数は JS の string.length（UTF-16 単位）で数える。 */
export const ADVICE_LIMITS = {
  headline: 30,
  say: 180,
  avoid: 40,
  briefReason: 80,
  missingItem: 40,
  maxMissingItems: 5,
  maxEvidenceIds: 12,
  maxFactIds: 12,
} as const;

export const AdviceAction = z.enum(['show', 'hold', 'none']);
export type AdviceAction = z.infer<typeof AdviceAction>;

export const AdviceKind = z.enum(['answer', 'clarify', 'reframe', 'next_step', 'risk', 'listen']);
export type AdviceKind = z.infer<typeof AdviceKind>;

export const EvidenceLevel = z.enum(['supported', 'tentative', 'insufficient']);
export type EvidenceLevel = z.infer<typeof EvidenceLevel>;

export const NextStepType = z.enum([
  'clarify',
  'technical_check',
  'demo_review',
  'quote_review',
  'stakeholder_review',
  'contract_discussion',
  'defer',
  'none',
]);
export type NextStepType = z.infer<typeof NextStepType>;

const Id = z.string().min(1).max(128);

/**
 * LLM の構造化出力（SPEC §12）。ID・時刻・期限・sessionId 等は含めない（アプリ側で付与）。
 */
/** refinement なしの素のオブジェクト（JSON Schema 生成・extend 用）。 */
export const AdviceLlmOutputBase = z
  .object({
    action: AdviceAction,
    kind: AdviceKind,
    headline: z.string().max(ADVICE_LIMITS.headline),
    say: z.string().min(1).max(ADVICE_LIMITS.say).nullable(),
    avoid: z.string().min(1).max(ADVICE_LIMITS.avoid).nullable(),
    briefReason: z.string().max(ADVICE_LIMITS.briefReason),
    evidenceUtteranceIds: z.array(Id).max(ADVICE_LIMITS.maxEvidenceIds),
    approvedFactIds: z.array(Id).max(ADVICE_LIMITS.maxFactIds),
    missingItems: z.array(z.string().min(1).max(ADVICE_LIMITS.missingItem)).max(ADVICE_LIMITS.maxMissingItems),
    evidenceLevel: EvidenceLevel,
    nextStepType: NextStepType,
  })
  .strict();

function requireHeadlineWhenShown(v: { action: AdviceAction; headline: string }, ctx: z.RefinementCtx): void {
  if (v.action === 'show' && v.headline.trim().length === 0) {
    ctx.addIssue({ code: 'custom', path: ['headline'], message: 'headline is required when action=show' });
  }
}

export const AdviceLlmOutput = AdviceLlmOutputBase.superRefine(requireHeadlineWhenShown);
export type AdviceLlmOutput = z.infer<typeof AdviceLlmOutput>;

export const AdviceTrigger = z.enum(['auto', 'manual_rebuttal', 'manual_next_question', 'manual_next_step']);
export type AdviceTrigger = z.infer<typeof AdviceTrigger>;

/** 手動ボタンの種類（SPEC §4-2: 切り返し / 次に聞く / 次の約束）。 */
export const ManualAdviceKind = z.enum(['rebuttal', 'next_question', 'next_step']);
export type ManualAdviceKind = z.infer<typeof ManualAdviceKind>;

export const MANUAL_KIND_TO_TRIGGER: Record<ManualAdviceKind, AdviceTrigger> = {
  rebuttal: 'manual_rebuttal',
  next_question: 'manual_next_question',
  next_step: 'manual_next_step',
};

/** current = 現行推奨 / reference = 参考（古い・話題変化） / invalidated = 前提が崩れた */
export const AdviceCardStatus = z.enum(['current', 'reference', 'invalidated']);
export type AdviceCardStatus = z.infer<typeof AdviceCardStatus>;

export const AdviceWarningCode = z.enum([
  'stale',
  'topic_changed',
  'transcript_revised',
  'pinned_stale',
  'contradicts_fact',
  'unverified_promise',
  'fact_revoked',
  'insufficient_evidence',
  'degraded_capture',
]);
export type AdviceWarningCode = z.infer<typeof AdviceWarningCode>;

export const AdviceWarning = z
  .object({
    code: AdviceWarningCode,
    message: z.string().max(200),
  })
  .strict();
export type AdviceWarning = z.infer<typeof AdviceWarning>;

/** LLM 出力 + アプリ側付与情報。検証済みカードだけを原子的に表示する（SPEC §12）。 */
export const AdviceCard = AdviceLlmOutputBase.extend({
  adviceId: Id,
  sessionId: Id,
  contextRevision: z.number().int().nonnegative(),
  promptVersion: z.string().min(1).max(64),
  /** 生成時に有効だった営業補正ルール（承認済み）の版。0 = ルールなし。旧データでは欠ける。 */
  rulesVersion: z.number().int().nonnegative().optional(),
  /** epoch ms */
  createdAt: z.number().int().nonnegative(),
  /** epoch ms。これを過ぎたら current ではなく reference。 */
  expiresAt: z.number().int().nonnegative(),
  trigger: AdviceTrigger,
  status: AdviceCardStatus,
  warnings: z.array(AdviceWarning),
})
  .strict()
  .superRefine(requireHeadlineWhenShown);
export type AdviceCard = z.infer<typeof AdviceCard>;

export const AdviceInvalidationReason = z.enum([
  'transcript_revised',
  'context_changed',
  'stale',
  'superseded',
  'fact_revoked',
  'validation_failed',
  'session_ended',
]);
export type AdviceInvalidationReason = z.infer<typeof AdviceInvalidationReason>;
