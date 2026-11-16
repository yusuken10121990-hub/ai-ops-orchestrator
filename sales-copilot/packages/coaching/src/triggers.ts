import type { ApprovedFact } from '@sales-copilot/contracts';
import { isBackchannel, looksLikeQuestion } from '@sales-copilot/domain';
import { approvedOnly, unresolvedMemoItems } from './prompt';
import {
  DECLINE_RE,
  FREE_RE,
  REDUCTION_RE,
  WAITING_TIME_RE,
  PER_PERSON_RE,
  COMPANY_WIDE_RE,
  STRONG_INTENT_RE,
  WEAK_POSITIVE_RE,
  extractNumericExprs,
  findGuarantee,
  normalizeForRules,
  numericKeys,
} from './text-rules';
import type { AdviceMemoSnapshot, AdviceWindowUtterance } from './types';

export type AutoTriggerReason =
  | 'backchannel'
  | 'empty'
  | 'possible_echo'
  | 'customer_question'
  | 'customer_concern'
  | 'consideration_or_hold'
  | 'operation_condition'
  | 'next_step_agreement'
  | 'customer_decline'
  | 'positive_with_unresolved'
  | 'positive_after_explanation'
  | 'self_unverified_claim'
  | 'self_repeated_free'
  | 'self_scope_expansion'
  | 'self_ignored_question'
  | 'self_time_conflation'
  | 'self_no_risk'
  | 'no_signal';

export interface AutoTriggerInput {
  /** 今確定した発話。 */
  utterance: AdviceWindowUtterance;
  /** 直近ウィンドウ（utterance を含んでいてもいなくてもよい）。 */
  window: readonly AdviceWindowUtterance[];
  /** ConversationState#snapshot() 互換（未解決の質問・確認事項を見る）。 */
  memo?: AdviceMemoSnapshot;
  /** 野中の言い切りを照合する承認済み条件。 */
  approvedFacts?: readonly ApprovedFact[];
}

export interface AutoTriggerDecision {
  trigger: boolean;
  reason: AutoTriggerReason;
}

const CONCERN_RE = /不安|心配|難しい|大変|手間|負担|時間がない|時間がありません|余裕がない|高い|高く|コスト|リスク|困って|面倒|ハードル|怖い|懸念|^(でも|ただ|とはいえ|うーん)/;
const CONSIDER_RE = /検討|持ち帰|相談します|相談して|上司|部長|社長|決裁|稟議|一人では決め|保留|また連絡|改めて|考えます|考えさせ/;
const OPERATION_RE = /運用|保守|更新|担当者|誰が|サポート|障害|セキュリティ|バックアップ|権限|データ移行|教育|マニュアル|社内で回せ|引き継/;
const AGREEMENT_RE = /やってみ|お願いします|お願いしたい|進めたい|一件で確認|見てみたい|その方向|試してみ|ぜひ|良さそうです|いいと思います/;
const ASK_RE = /教えて|知りたい|伺いたい|どうなり|どうなって|どのくらい|どれくらい|いくら|いつ|何が|どこまで/;
const SCOPE_EXPANSION_RE = /(ついでに|さらに|あと|それから|これも|あれも|全部|まとめて)[^。]{0,20}(入れ|追加|付け|対応|自動化|載せ|組み込)/;
const SELF_ASSERT_RE = /(納期|精度|性能|速度|処理時間|期間|月額|費用|料金|価格|解約)[^。]{0,20}(です|ます|できます|大丈夫)/;
const SELF_COMPANY_RE = /うち|弊社|ZEROSYS|私たち|僕ら|当社/;

/** 漢字・カタカナの2文字以上の語（質問と返答の重なりを見る簡易キーワード）。 */
function contentTokens(text: string): Set<string> {
  const t = normalizeForRules(text);
  const toks = t.match(/[\p{Script=Han}]{2,}|[\p{Script=Katakana}ー]{2,}|[A-Za-z0-9]{2,}/gu) ?? [];
  return new Set(toks);
}

function traceable(text: string, facts: readonly ApprovedFact[], customerTexts: string[]): boolean {
  const allowed = new Set<string>();
  for (const f of facts) for (const k of numericKeys(f.value)) allowed.add(k);
  for (const t of customerTexts) for (const k of numericKeys(t)) allowed.add(k);
  return extractNumericExprs(text).every((n) => allowed.has(n.key));
}

/**
 * 自動助言の契機判定（SPEC §8-1）。単語一致だけでなく、直前の会話と未解決事項を見る。
 * - 相づちは契機にしない
 * - 顧客側: 質問・具体的懸念・検討/保留・運用条件・次の行動への合意・見送り
 * - 野中側: 未確認の価格/納期/性能の言い切り、無料説明の繰り返し、確認前の機能拡大、
 *           質問に答えず自社説明、待ち時間と実作業時間（1人当たりと全社）の混同 → 注意候補
 * - 長く話しただけでは契機にしない
 */
export function shouldTriggerAuto(input: AutoTriggerInput): AutoTriggerDecision {
  const u = input.utterance;
  const text = u.text.trim();
  if (text.length === 0) return { trigger: false, reason: 'empty' };
  if (isBackchannel(text)) return { trigger: false, reason: 'backchannel' };
  const norm = normalizeForRules(text);
  const prior = input.window.filter((w) => w.utteranceId !== u.utteranceId);
  const facts = approvedOnly(input.approvedFacts ?? []);
  const unresolved = input.memo ? unresolvedMemoItems({ memo: input.memo }) : [];

  if (u.source === 'SELF') {
    const remoteTexts = prior.filter((w) => w.source === 'REMOTE').map((w) => w.text);
    if (findGuarantee(text)) return { trigger: true, reason: 'self_unverified_claim' };
    const nums = extractNumericExprs(text);
    if (nums.length > 0 && !traceable(text, facts, remoteTexts)) return { trigger: true, reason: 'self_unverified_claim' };
    if (SELF_ASSERT_RE.test(norm) && facts.length === 0 && !/確認|お調べ|お伝えします|わかりません|分かりません/.test(norm))
      return { trigger: true, reason: 'self_unverified_claim' };
    // 待ち時間と作業時間、1人当たりと全社の混同
    if (nums.some((n) => n.category === 'hour' || n.category === 'day') && REDUCTION_RE.test(norm)) {
      if (remoteTexts.some((t) => WAITING_TIME_RE.test(t))) return { trigger: true, reason: 'self_time_conflation' };
    }
    if (COMPANY_WIDE_RE.test(norm) && nums.length > 0 && remoteTexts.some((t) => PER_PERSON_RE.test(normalizeForRules(t)))) {
      return { trigger: true, reason: 'self_time_conflation' };
    }
    if (FREE_RE.test(norm) && prior.some((w) => w.source === 'SELF' && FREE_RE.test(normalizeForRules(w.text)))) {
      return { trigger: true, reason: 'self_repeated_free' };
    }
    if (SCOPE_EXPANSION_RE.test(norm) && !prior.some((w) => w.source === 'REMOTE' && /追加|入れ|これも|あれも/.test(w.text))) {
      return { trigger: true, reason: 'self_scope_expansion' };
    }
    // 直前の顧客の質問に答えず自社説明へ移った
    const lastRemote = [...prior].reverse().find((w) => w.source === 'REMOTE');
    const selfSinceQuestion = lastRemote ? prior.slice(prior.indexOf(lastRemote) + 1).filter((w) => w.source === 'SELF') : [];
    if (lastRemote && looksLikeQuestion(lastRemote.text) && selfSinceQuestion.length === 0 && [...norm].length >= 25 && SELF_COMPANY_RE.test(norm)) {
      const q = contentTokens(lastRemote.text);
      const a = contentTokens(text);
      const overlap = [...q].some((t) => a.has(t) || [...a].some((x) => x.includes(t) || t.includes(x)));
      if (!overlap) return { trigger: true, reason: 'self_ignored_question' };
    }
    return { trigger: false, reason: 'self_no_risk' };
  }

  // REMOTE / UNKNOWN
  if (u.flags?.includes('possible_echo')) return { trigger: false, reason: 'possible_echo' };
  if (DECLINE_RE.test(norm)) return { trigger: true, reason: 'customer_decline' };
  if (looksLikeQuestion(text) || ASK_RE.test(norm)) return { trigger: true, reason: 'customer_question' };
  if (CONSIDER_RE.test(norm)) return { trigger: true, reason: 'consideration_or_hold' };
  if (AGREEMENT_RE.test(norm) || STRONG_INTENT_RE.test(norm)) return { trigger: true, reason: 'next_step_agreement' };
  if (OPERATION_RE.test(norm) && /したい|必要|できる|困|心配|気にな|どう/.test(norm)) return { trigger: true, reason: 'operation_condition' };
  if (CONCERN_RE.test(norm) && [...norm].length >= 6) return { trigger: true, reason: 'customer_concern' };
  if (WEAK_POSITIVE_RE.test(norm)) {
    // 「便利そう」だけでは導入意思ではない。未解決事項があるか、野中の説明直後なら確認を促す
    if (unresolved.length > 0) return { trigger: true, reason: 'positive_with_unresolved' };
    const prev = prior[prior.length - 1];
    if (prev && prev.source === 'SELF' && [...normalizeForRules(prev.text)].length >= 20) {
      return { trigger: true, reason: 'positive_after_explanation' };
    }
    return { trigger: false, reason: 'no_signal' };
  }
  return { trigger: false, reason: 'no_signal' };
}
