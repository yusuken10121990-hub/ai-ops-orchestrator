import { AdviceLlmOutput, type AdviceWarning, type AdviceWarningCode, type ApprovedFact, type NextStepType } from '@sales-copilot/contracts';
import { activeDeclineItems, approvedOnly, bannedPhrases, memoItemsOf, unresolvedMemoItems } from './prompt';
import {
  ACCURACY_CLAIM_RE,
  CANCELLATION_CLAIM_RE,
  CANCELLATION_TOPIC_RE,
  CAPABILITY_RE,
  COMPANY_WIDE_RE,
  CONTACT_PUSH_RE,
  CONTRACT_PUSH_RE,
  DECLINE_RE,
  FEASIBILITY_TOPIC_RE,
  FREE_RE,
  PER_PERSON_RE,
  REDUCTION_RE,
  RESTRICTIVE_TERM_RE,
  STRONG_INTENT_RE,
  countQuestions,
  countSentences,
  extractNumericExprs,
  findForcedBinary,
  findGuarantee,
  normalizeForRules,
  numericKeys,
  topicLabel,
} from './text-rules';
import type { AdviceContext } from './types';

/** 表示前検証のルールコード（会話本文を含まない。ログに出してよい）。 */
export type ValidationRule =
  | 'schema'
  | 'unknown_evidence_id'
  | 'unknown_fact_id'
  | 'fact_id_with_say'
  | 'supported_without_evidence'
  | 'degraded_supported'
  | 'unverified_number'
  | 'guarantee_word'
  | 'banned_phrase'
  | 'unverified_free_offer'
  | 'reduction_promise'
  | 'capability_claim'
  | 'scope_conflation'
  | 'forced_binary'
  | 'too_many_questions'
  | 'too_many_sentences'
  | 'declined_push'
  | 'next_step_unresolved'
  | 'weak_positive_contract'
  | 'terms_contradiction';

export type IssueSeverity = 'block' | 'repair' | 'warn';

export interface ValidationIssue {
  rule: ValidationRule;
  severity: IssueSeverity;
}

/** block の種類 → 安全カードの選び方。 */
export type BlockCategory = 'unverified_promise' | 'style' | 'schema';

export interface ValidationResult {
  verdict: 'ok' | 'repaired' | 'blocked';
  /** verdict=blocked のときは元の出力（表示してはならない）。それ以外は表示してよい出力。 */
  output: AdviceLlmOutput;
  issues: ValidationIssue[];
  warnings: AdviceWarning[];
  blockCategory?: BlockCategory;
}

const PROMISE_RULES: ReadonlySet<ValidationRule> = new Set([
  'fact_id_with_say',
  'unverified_number',
  'guarantee_word',
  'unverified_free_offer',
  'reduction_promise',
  'capability_claim',
  'scope_conflation',
]);

const PUSHING_NEXT_STEPS: ReadonlySet<NextStepType> = new Set([
  'technical_check',
  'demo_review',
  'quote_review',
  'stakeholder_review',
  'contract_discussion',
]);
/** 未解決の質問がある間は先に確認へ回す次の一歩（技術検証は疑問の確認そのものになり得るので除く）。 */
const UNRESOLVED_BLOCKED_STEPS: ReadonlySet<NextStepType> = new Set([
  'demo_review',
  'quote_review',
  'stakeholder_review',
  'contract_discussion',
]);

const WARNING_TEXT: Partial<Record<ValidationRule, { code: AdviceWarningCode; message: string }>> = {
  unknown_evidence_id: { code: 'insufficient_evidence', message: '根拠として存在しない発言IDを除外しました' },
  unknown_fact_id: { code: 'insufficient_evidence', message: '承認済みでない条件IDを除外しました' },
  supported_without_evidence: { code: 'insufficient_evidence', message: '根拠の発言が無いため確度を下げました' },
  degraded_supported: { code: 'degraded_capture', message: '片側の音声だけで判断しているため確度を下げました' },
  declined_push: { code: 'insufficient_evidence', message: '見送り・連絡不要の意思を優先し、引き止めない案に切り替えました' },
  next_step_unresolved: { code: 'insufficient_evidence', message: '未解決の質問があるため、日程より確認を優先する案に切り替えました' },
  weak_positive_contract: { code: 'insufficient_evidence', message: '前向きな反応だけでは導入意思と判断できないため、契約の提案を止めました' },
  terms_contradiction: { code: 'contradicts_fact', message: '顧客の認識と承認済み条件が食い違うため、確認を促す案に切り替えました' },
};

function issue(issues: ValidationIssue[], rule: ValidationRule, severity: IssueSeverity): void {
  if (!issues.some((i) => i.rule === rule && i.severity === severity)) issues.push({ rule, severity });
}

function truncate(s: string, n: number): string {
  return [...s].length <= n ? s : [...s].slice(0, n - 1).join('') + '…';
}

/** 表示文（say + headline）。avoid は「言わないこと」なので保証語等の検査対象外。 */
function visibleText(o: AdviceLlmOutput): string {
  return `${o.headline}\n${o.say ?? ''}`;
}

function windowIds(ctx: AdviceContext): Set<string> {
  const ids = new Set(ctx.window.map((u) => u.utteranceId));
  for (const i of memoItemsOf(ctx)) for (const id of i.evidenceUtteranceIds) ids.add(id);
  return ids;
}

/** 顧客（REMOTE）発言。UNKNOWN は帰属不明なので数値の出所に使わない。 */
function customerTexts(ctx: AdviceContext): string[] {
  return ctx.window.filter((u) => u.source === 'REMOTE').map((u) => u.text);
}

function isDeclined(ctx: AdviceContext): boolean {
  if (activeDeclineItems(ctx).length > 0) return true;
  const remote = ctx.window.filter((u) => u.source === 'REMOTE');
  return remote.slice(-3).some((u) => DECLINE_RE.test(normalizeForRules(u.text)));
}

function hasStrongIntent(ctx: AdviceContext): boolean {
  if (ctx.window.some((u) => u.source === 'REMOTE' && STRONG_INTENT_RE.test(u.text))) return true;
  return memoItemsOf(ctx).some((i) => i.field === 'proposalsAndAgreements' && i.status === 'fact' && STRONG_INTENT_RE.test(i.text));
}

/** 顧客の解約・期間の主張と、承認済みの制限的な条件の食い違い。 */
function findTermsContradiction(ctx: AdviceContext, facts: ApprovedFact[]): ApprovedFact | null {
  const claim = ctx.window.some((u) => u.source === 'REMOTE' && CANCELLATION_TOPIC_RE.test(u.text) && CANCELLATION_CLAIM_RE.test(u.text));
  if (!claim) return null;
  return facts.find((f) => (f.category === 'cancellation' || f.category === 'min_term') && RESTRICTIVE_TERM_RE.test(f.value)) ?? null;
}

// ---- 安全な置き換え案（会話本文を埋め込まない固定文） ----

export function respectfulCloseOutput(evidence: string[]): AdviceLlmOutput {
  return {
    action: 'show',
    kind: 'next_step',
    headline: '見送りの意思を尊重して終える',
    say: '承知しました。無理に進める必要はないので、今回はここまでにしておきましょう。',
    avoid: '日程・資料送付・デモで引き止める',
    briefReason: '顧客が見送りや連絡不要の意思を示している',
    evidenceUtteranceIds: evidence,
    approvedFactIds: [],
    missingItems: [],
    evidenceLevel: 'supported',
    nextStepType: 'defer',
  };
}

export function clarifyFirstOutput(label: string, evidence: string[]): AdviceLlmOutput {
  return {
    action: 'show',
    kind: 'clarify',
    headline: truncate(`日程より${label}の確認が先`, 30),
    say: `その前に、${label}について確認させてください。`,
    avoid: '未解決のまま日程や契約の話に進む',
    briefReason: truncate(`まだ日程の話より、${label}の確認が先です。`, 80),
    evidenceUtteranceIds: evidence,
    approvedFactIds: [],
    missingItems: [truncate(label, 40)],
    evidenceLevel: 'supported',
    nextStepType: 'clarify',
  };
}

export function interestCheckOutput(evidence: string[]): AdviceLlmOutput {
  return {
    action: 'show',
    kind: 'clarify',
    headline: '使いたい場面を確認する',
    say: 'ありがとうございます。今の作業に当てはめると、実際に使ってみたい場面はありましたか？',
    avoid: '導入意思とみなして契約に進む',
    briefReason: '前向きな反応だけでは導入意向と判断できない',
    evidenceUtteranceIds: evidence,
    approvedFactIds: [],
    missingItems: [],
    evidenceLevel: 'tentative',
    nextStepType: 'clarify',
  };
}

export function termsClarifyOutput(fact: ApprovedFact, evidence: string[]): AdviceLlmOutput {
  return {
    action: 'show',
    kind: 'clarify',
    headline: '解約条件の認識違いを確認',
    say: '以前お聞きになった内容と、今回のプランの条件が違うかもしれません。正式な条件をそろえて、正確にお伝えします。',
    avoid: '顧客の認識に合わせて言い切る',
    briefReason: '顧客の認識と承認済みの契約条件が食い違う',
    evidenceUtteranceIds: evidence,
    approvedFactIds: [fact.factId],
    missingItems: [],
    evidenceLevel: 'supported',
    nextStepType: 'clarify',
  };
}

/**
 * LLM 出力の表示前検証（SPEC §12）。コードで判定し、LLM に再判断させない。
 * - 根拠ID・条件IDの実在
 * - 数値（金額/割合/期間/日数/時間/件数）の出所（承認済み条件の値 or 顧客自身の発言）
 * - 保証語・使わない表現・無料・削減量・可否の言い切り・単位のすり替え・二者択一
 * - 見送り/未解決/弱い前向き反応/解約条件の矛盾に対する、次の一歩の安全な置き換え
 * - 質問は最大一つ・1〜3文
 */
export function validateAdvice(raw: unknown, ctx: AdviceContext): ValidationResult {
  const parsed = AdviceLlmOutput.safeParse(raw);
  if (!parsed.success) {
    return {
      verdict: 'blocked',
      output: raw as AdviceLlmOutput,
      issues: [{ rule: 'schema', severity: 'block' }],
      warnings: [],
      blockCategory: 'schema',
    };
  }
  let o: AdviceLlmOutput = { ...parsed.data };
  const issues: ValidationIssue[] = [];
  const facts = approvedOnly(ctx.approvedFacts);
  const factIds = new Set(facts.map((f) => f.factId));
  const knownUtt = windowIds(ctx);

  // 1) 根拠IDの実在
  const ev = o.evidenceUtteranceIds.filter((id) => knownUtt.has(id));
  if (ev.length !== o.evidenceUtteranceIds.length) {
    issue(issues, 'unknown_evidence_id', 'repair');
    o.evidenceUtteranceIds = ev;
  }
  const fids = o.approvedFactIds.filter((id) => factIds.has(id));
  if (fids.length !== o.approvedFactIds.length) {
    issue(issues, 'unknown_fact_id', 'repair');
    o.approvedFactIds = fids;
    // 台詞が存在しない/未承認の条件に依存している可能性 → 表示しない
    if (o.action === 'show' && o.say) issue(issues, 'fact_id_with_say', 'block');
  }
  if (o.evidenceLevel === 'supported' && o.evidenceUtteranceIds.length === 0 && o.approvedFactIds.length === 0) {
    issue(issues, 'supported_without_evidence', 'repair');
    o.evidenceLevel = 'tentative';
  }
  if (ctx.degraded && o.evidenceLevel === 'supported') {
    issue(issues, 'degraded_supported', 'repair');
    o.evidenceLevel = 'tentative';
  }

  const lastRemote = [...ctx.window].reverse().find((u) => u.source === 'REMOTE');
  const anchorEvidence = o.evidenceUtteranceIds.length > 0 ? o.evidenceUtteranceIds : lastRemote ? [lastRemote.utteranceId] : [];

  // 2) 文脈に基づく置き換え（拒否・未解決・弱い反応・条件矛盾）
  if (o.action === 'show' && !issues.some((i) => i.severity === 'block')) {
    const say = o.say ?? '';
    const declined = isDeclined(ctx);
    const pushing =
      PUSHING_NEXT_STEPS.has(o.nextStepType) ||
      o.nextStepType === 'clarify' ||
      countQuestions(say) > 0 ||
      CONTACT_PUSH_RE.test(say) ||
      CONTRACT_PUSH_RE.test(say);
    const contradiction = findTermsContradiction(ctx, facts);
    const unresolved = unresolvedMemoItems(ctx);
    if (declined && pushing) {
      issue(issues, 'declined_push', 'repair');
      const declineEv = activeDeclineItems(ctx).flatMap((i) => i.evidenceUtteranceIds).filter((id) => knownUtt.has(id));
      o = respectfulCloseOutput(declineEv.length > 0 ? [...new Set(declineEv)].slice(0, 12) : anchorEvidence);
    } else if (contradiction && !(o.approvedFactIds.includes(contradiction.factId) && !/いつでも|縛りはありません|大丈夫です/.test(say))) {
      issue(issues, 'terms_contradiction', 'repair');
      o = termsClarifyOutput(contradiction, anchorEvidence);
    } else if (
      (o.kind === 'next_step' || ctx.trigger === 'manual_next_step') &&
      UNRESOLVED_BLOCKED_STEPS.has(o.nextStepType) &&
      unresolved.length > 0
    ) {
      issue(issues, 'next_step_unresolved', 'repair');
      const target = unresolved[unresolved.length - 1]!;
      const ev2 = target.evidenceUtteranceIds.filter((id) => knownUtt.has(id));
      o = clarifyFirstOutput(topicLabel(target.text), ev2.length > 0 ? ev2 : anchorEvidence);
    } else if ((o.nextStepType === 'contract_discussion' || CONTRACT_PUSH_RE.test(say)) && !hasStrongIntent(ctx)) {
      issue(issues, 'weak_positive_contract', 'repair');
      o = interestCheckOutput(anchorEvidence);
    }
  }

  // 3) 表示文の検査（置き換え後の文にも当てる）
  if (o.action === 'show') {
    const text = visibleText(o);
    const norm = normalizeForRules(text);
    const say = o.say ?? '';
    const usedFacts = facts;
    const factText = usedFacts.map((f) => f.value).join('\n');

    // 数値の出所
    const nums = extractNumericExprs(text);
    if (nums.length > 0) {
      const allowed = new Set<string>([...numericKeys(factText)]);
      for (const t of customerTexts(ctx)) for (const k of numericKeys(t)) allowed.add(k);
      if (nums.some((n) => !allowed.has(n.key))) issue(issues, 'unverified_number', 'block');

      // 1人当たり → 全社 のすり替え
      if (COMPANY_WIDE_RE.test(norm)) {
        const perPersonKeys = new Set<string>();
        for (const t of customerTexts(ctx)) if (PER_PERSON_RE.test(normalizeForRules(t))) for (const k of numericKeys(t)) perPersonKeys.add(k);
        if (nums.some((n) => perPersonKeys.has(n.key))) issue(issues, 'scope_conflation', 'block');
      }
      // 数値つきの削減・短縮（効果量を作らない）
      if (REDUCTION_RE.test(norm)) issue(issues, 'reduction_promise', 'block');
    }

    if (findGuarantee(text)) issue(issues, 'guarantee_word', 'block');

    const banned = bannedPhrases().map(normalizeForRules);
    if (banned.some((b) => b.length > 0 && norm.includes(b))) issue(issues, 'banned_phrase', 'block');

    if (FREE_RE.test(norm) && !/無料|0円/.test(normalizeForRules(factText))) issue(issues, 'unverified_free_offer', 'block');

    const hasTechFact = o.approvedFactIds.some((id) => usedFacts.find((f) => f.factId === id)?.category === 'tech_spec');
    if (!hasTechFact && (CAPABILITY_RE.test(norm) || ACCURACY_CLAIM_RE.test(norm))) {
      const recentRemote = ctx.window.filter((u) => u.source !== 'SELF').slice(-3);
      const feasibilityContext =
        recentRemote.some((u) => FEASIBILITY_TOPIC_RE.test(normalizeForRules(u.text))) ||
        unresolvedMemoItems(ctx).some((i) => FEASIBILITY_TOPIC_RE.test(normalizeForRules(i.text)) || i.meta?.checkCategory === 'feasibility');
      if (feasibilityContext || ACCURACY_CLAIM_RE.test(norm)) issue(issues, 'capability_claim', 'block');
    }

    if (findForcedBinary(say)) issue(issues, 'forced_binary', 'block');
    if (countQuestions(say) > 1) issue(issues, 'too_many_questions', 'block');
    if (countSentences(say) > 3) issue(issues, 'too_many_sentences', 'block');
  }

  const warnings: AdviceWarning[] = [];
  for (const i of issues) {
    const w = WARNING_TEXT[i.rule];
    if (w && i.severity !== 'block' && !warnings.some((x) => x.code === w.code && x.message === w.message)) warnings.push({ ...w });
  }

  const blocks = issues.filter((i) => i.severity === 'block');
  if (blocks.length > 0) {
    const category: BlockCategory = blocks.some((b) => PROMISE_RULES.has(b.rule)) ? 'unverified_promise' : 'style';
    return { verdict: 'blocked', output: o, issues, warnings, blockCategory: category };
  }
  // 置き換え後も契約上限（長さ等）を満たすことを保証
  const final = AdviceLlmOutput.safeParse(o);
  if (!final.success) {
    return { verdict: 'blocked', output: o, issues: [...issues, { rule: 'schema', severity: 'block' }], warnings, blockCategory: 'schema' };
  }
  return { verdict: issues.length > 0 ? 'repaired' : 'ok', output: final.data, issues, warnings };
}
