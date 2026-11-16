import type { ConversationState, MemoItemInput } from '@sales-copilot/domain';
import { isBackchannel, looksLikeQuestion, normalizeText } from '@sales-copilot/domain';
import { DECLINE_RE, normalizeForRules, topicLabel } from './text-rules';
import type { AdviceWindowUtterance } from './types';

type CheckCategory = NonNullable<MemoItemInput['meta']>['checkCategory'];

/** 費用・期間・解約など、会話から出た条件の手がかり（確認候補止まり）。 */
const CONDITION_RULES: { re: RegExp; category: CheckCategory }[] = [
  { re: /いくら|料金|費用|価格|値段|金額|見積|月額|初期費用|円|万/, category: 'cost' },
  { re: /解約|やめられ|辞められ|違約|契約期間|最低|縛り/, category: 'cost' },
  { re: /納期|いつまで|いつから|何日|何ヶ月|何か月|期間|スケジュール/, category: 'timing' },
  { re: /精度|3D|データ|形式|連携|できますか|対応できますか|可能ですか/, category: 'feasibility' },
  { re: /運用|保守|更新|サポート|担当/, category: 'operation' },
  { re: /上司|部長|社長|決裁|承認|稟議/, category: 'approval' },
];

const MEMO_TEXT_MAX = 80;

function clip(s: string): string {
  const chars = [...s.trim()];
  return chars.length <= MEMO_TEXT_MAX ? chars.join('') : chars.slice(0, MEMO_TEXT_MAX - 1).join('') + '…';
}

/**
 * 1発話から構造化メモの更新候補を規則で抜き出す（安価・同期・LLM 不使用）。
 * - 顧客の質問 → openQuestions（質問があったこと自体は発話で確認済み = fact）
 * - 見送り・連絡不要 → declineSignals
 * - 価格・解約・期間・可否などの言及 → checkItems（status=unverified の確認候補）
 * 会話由来の条件を承認済み条件へ昇格させない（ApprovedFact は作らない）。
 * 返り値は ConversationState#upsertMemoItem にそのまま渡せる。UNKNOWN 帰属・回り込み疑いの確度は domain 側で下げる。
 */
export function extractMemoCandidates(
  utt: AdviceWindowUtterance,
  state: Pick<ConversationState, 'memoItems'>,
): MemoItemInput[] {
  const text = utt.text.trim();
  if (text.length === 0 || isBackchannel(text)) return [];
  const norm = normalizeForRules(text);
  const existing = state.memoItems().filter((i) => !i.resolved);
  const has = (field: MemoItemInput['field'], t: string) =>
    existing.some((i) => i.field === field && normalizeText(i.text) === normalizeText(t));
  const out: MemoItemInput[] = [];
  const ev = [utt.utteranceId];

  if (utt.source !== 'SELF') {
    if (DECLINE_RE.test(norm)) {
      const t = clip(text);
      if (!has('declineSignals', t)) out.push({ field: 'declineSignals', text: t, status: 'fact', evidenceUtteranceIds: ev });
    }
    if (looksLikeQuestion(text) || /[？?]/.test(text)) {
      const t = clip(text);
      if (!has('openQuestions', t)) out.push({ field: 'openQuestions', text: t, status: 'fact', evidenceUtteranceIds: ev });
    }
    if (/上司|部長|社長|決裁|承認|稟議|担当/.test(norm)) {
      const t = clip(`関係者の言及: ${text}`);
      if (!has('stakeholders', t)) out.push({ field: 'stakeholders', text: t, status: 'hypothesis', evidenceUtteranceIds: ev });
    }
  }

  // 条件の言及は話者を問わず確認候補（野中の言い切りも正式条件ではない）
  for (const rule of CONDITION_RULES) {
    if (!rule.re.test(norm)) continue;
    const label = topicLabel(text);
    const t = clip(`${label}（会話中の言及・未確認）: ${text}`);
    const dupTopic = existing.some((i) => i.field === 'checkItems' && i.text.startsWith(`${label}（`));
    if (!dupTopic && !has('checkItems', t) && !out.some((o) => o.field === 'checkItems')) {
      out.push({ field: 'checkItems', text: t, status: 'unverified', evidenceUtteranceIds: ev, meta: { checkCategory: rule.category } });
    }
    break;
  }
  return out;
}
