import { z } from 'zod';
import { AdviceKind } from './advice';
import { FeedbackRating } from './messages';
import { EstimatedCost } from './usage';

/**
 * 学習（承認制）。SPEC §13: 改善ルールは提案として出し、承認後にバージョン管理して適用する。
 * - 提案文はモデル出力＝データ。表示前に長さ・形を検証する。
 * - 承認済みルールは次のセッションから助言プロンプトに入る（進行中のセッションは変えない）。
 * - 価格・契約条件はルールにしない（承認済み商談条件の役目）。
 */
export const LEARNING_LIMITS = {
  ruleText: 120,
  reason: 200,
  maxProposals: 5,
  /** 同時に有効にできるルール数（プロンプトの肥大化を防ぐ）。 */
  maxActiveRules: 20,
  /** 改善案づくりに必要な評価（文面つき）の最小件数。 */
  minSamplesForProposal: 3,
  /** 改善案づくりに送る評価の最大件数（新しい順）。 */
  maxSamplesForProposal: 60,
  /** 役立った率を「データ不足」とする件数の境目（n < これ）。 */
  minSampleForRate: 10,
} as const;

/** ルールの対象場面。all=全部 / それ以外はカードの種類（AdviceKind）。 */
export const RuleScope = z.enum(['all', ...AdviceKind.options]);
export type RuleScope = z.infer<typeof RuleScope>;

const Id = z.string().min(1).max(128);
const EpochMs = z.number().int().nonnegative();
const RuleText = z.string().trim().min(4).max(LEARNING_LIMITS.ruleText);

/** モデルが返す提案1件（未検証のデータ）。 */
export const RuleProposalDraft = z
  .object({
    rule: RuleText,
    reason: z.string().trim().min(1).max(LEARNING_LIMITS.reason),
    scope: RuleScope,
  })
  .strict();
export type RuleProposalDraft = z.infer<typeof RuleProposalDraft>;

/** モデル出力全体（structured outputs のスキーマ元）。 */
export const RuleProposalOutput = z
  .object({ proposals: z.array(RuleProposalDraft).max(LEARNING_LIMITS.maxProposals) })
  .strict();
export type RuleProposalOutput = z.infer<typeof RuleProposalOutput>;

export const ProposalStatus = z.enum(['pending', 'approved', 'rejected']);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const RuleProposal = RuleProposalDraft.extend({
  proposalId: Id,
  status: ProposalStatus,
  createdAt: EpochMs,
  decidedAt: EpochMs.nullable(),
}).strict();
export type RuleProposal = z.infer<typeof RuleProposal>;

export const RuleStatus = z.enum(['active', 'disabled']);
export type RuleStatus = z.infer<typeof RuleStatus>;

/** 承認済みの営業補正ルール。 */
export const CoachingRule = z
  .object({
    ruleId: Id,
    text: RuleText,
    scope: RuleScope,
    status: RuleStatus,
    /** epoch ms（承認した時刻）。 */
    approvedAt: EpochMs,
    /** ルール全体の版（rulesVersion）のうち、このルールが承認された版。 */
    version: z.number().int().positive(),
    sourceProposalId: Id.nullable(),
  })
  .strict();
export type CoachingRule = z.infer<typeof CoachingRule>;

export const RuleHistoryAction = z.enum(['approved', 'edited_and_approved', 'rejected', 'disabled', 'enabled', 'deleted']);
export type RuleHistoryAction = z.infer<typeof RuleHistoryAction>;

export const RuleHistoryEntry = z
  .object({
    ruleId: Id.nullable(),
    proposalId: Id.nullable(),
    action: RuleHistoryAction,
    text: z.string().max(LEARNING_LIMITS.ruleText),
    scope: RuleScope,
    /** この変更後のルール全体の版。却下は版を変えない。 */
    rulesVersion: z.number().int().nonnegative(),
    changedAt: EpochMs,
  })
  .strict();
export type RuleHistoryEntry = z.infer<typeof RuleHistoryEntry>;

/** 版ごとの「役立った」率。n < minSampleForRate は insufficient=true（データ不足）。 */
export const RulesVersionStat = z
  .object({
    /** null = 学習機能より前の評価（版の記録なし）。 */
    rulesVersion: z.number().int().nonnegative().nullable(),
    n: z.number().int().nonnegative(),
    helpful: z.number().int().nonnegative(),
    rate: z.number().min(0).max(1).nullable(),
    insufficient: z.boolean(),
  })
  .strict();
export type RulesVersionStat = z.infer<typeof RulesVersionStat>;

export const LearningSettings = z.object({ saveCardText: z.boolean() }).strict();
export type LearningSettings = z.infer<typeof LearningSettings>;

// --- HTTP（settings スコープ） ----------------------------------------------------

export const LearningOverviewResponse = z
  .object({
    settings: LearningSettings,
    rulesVersion: z.number().int().nonnegative(),
    rules: z.array(CoachingRule),
    proposals: z.array(RuleProposal),
    history: z.array(RuleHistoryEntry),
    stats: z.array(RulesVersionStat),
    /** 文面つきで保存された評価の件数（改善案づくりに使える数）。 */
    samplesWithText: z.number().int().nonnegative(),
    /** 前回の改善案づくり以降に増えた評価（文面つき）の件数。 */
    newSamplesSinceLastProposal: z.number().int().nonnegative(),
  })
  .strict();
export type LearningOverviewResponse = z.infer<typeof LearningOverviewResponse>;

export const LearningSettingsPatch = LearningSettings.partial().strict();
export type LearningSettingsPatch = z.infer<typeof LearningSettingsPatch>;

export const ProposalEstimateResponse = z
  .object({
    configured: z.boolean(),
    model: z.string().max(100),
    sampleCount: z.number().int().nonnegative(),
    enoughSamples: z.boolean(),
    /** 多めに見積もった入力・出力トークン数（上限）。 */
    maxInputTokens: z.number().int().nonnegative(),
    maxOutputTokens: z.number().int().nonnegative(),
    /** 料金表が無ければ null（金額は推測しない）。 */
    maxCost: EstimatedCost.nullable(),
  })
  .strict();
export type ProposalEstimateResponse = z.infer<typeof ProposalEstimateResponse>;

export const ProposalGenerateResponse = z
  .object({
    proposals: z.array(RuleProposal),
    /** 検証で落とした提案の数（長さ・形・金額や条件を含む等）。 */
    dropped: z.number().int().nonnegative(),
  })
  .strict();
export type ProposalGenerateResponse = z.infer<typeof ProposalGenerateResponse>;

/** 承認（text/scope を渡すと「編集して承認」）。 */
export const ProposalApproveRequest = z
  .object({ text: RuleText.optional(), scope: RuleScope.optional() })
  .strict();
export type ProposalApproveRequest = z.infer<typeof ProposalApproveRequest>;

export const RuleResponse = z.object({ rule: CoachingRule, rulesVersion: z.number().int().nonnegative() }).strict();
export type RuleResponse = z.infer<typeof RuleResponse>;

export const LearningOkResponse = z.object({ ok: z.literal(true), rulesVersion: z.number().int().nonnegative() }).strict();
export type LearningOkResponse = z.infer<typeof LearningOkResponse>;

export const LearningErrorCode = z.enum([
  'invalid_body',
  'not_found',
  'already_decided',
  'rule_rejected',
  'too_many_rules',
  'not_enough_samples',
  'not_configured',
  'llm_failed',
]);
export type LearningErrorCode = z.infer<typeof LearningErrorCode>;

/** 改善案づくりに渡す、評価済みカード1件（会話本文・顧客名は含まない）。 */
export const RatedCardSample = z
  .object({
    rating: FeedbackRating,
    kind: z.string().max(32).nullable(),
    headline: z.string().max(200).nullable(),
    say: z.string().max(400).nullable(),
    avoid: z.string().max(200).nullable(),
    situation: z.array(z.string().max(40)).max(12),
    purpose: z.string().max(500).nullable(),
    rulesVersion: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type RatedCardSample = z.infer<typeof RatedCardSample>;
