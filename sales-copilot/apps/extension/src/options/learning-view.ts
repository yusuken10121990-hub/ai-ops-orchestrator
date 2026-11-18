import { LEARNING_LIMITS, type ProposalEstimateResponse, type RuleHistoryAction, type RuleScope, type RulesVersionStat } from '@sales-copilot/contracts';

/** 学習（承認制）の表示用の文言・整形（画面から切り離してテストする）。 */

export const SCOPE_LABEL: Record<RuleScope, string> = {
  all: 'すべての場面',
  answer: '質問に答えるとき',
  clarify: '確認するとき',
  reframe: '論点を整理するとき',
  next_step: '次の一歩を出すとき',
  risk: '自分の発言に注意するとき',
  listen: '聞くとき',
};

export const HISTORY_LABEL: Record<RuleHistoryAction, string> = {
  approved: '承認',
  edited_and_approved: '編集して承認',
  rejected: '却下',
  disabled: '停止',
  enabled: '再開',
  deleted: '削除',
};

export function versionLabel(v: number | null): string {
  if (v === null) return '記録なし（学習機能より前）';
  if (v === 0) return '版0（ルールなし）';
  return `版${v}`;
}

/** 「役立った」率の表示。n < 10 は率を出さず「データ不足」と書く。 */
export function rateText(s: RulesVersionStat): string {
  if (s.insufficient || s.rate === null) return `データ不足（${s.n}件・あと${Math.max(0, LEARNING_LIMITS.minSampleForRate - s.n)}件）`;
  return `${Math.round(s.rate * 100)}%（${s.helpful}/${s.n}件）`;
}

/** 実行前に見せる費用の目安。料金表が無ければ金額は出さない（推測しない）。 */
export function estimateText(e: ProposalEstimateResponse): string {
  const tokens = `送る評価 ${e.sampleCount}件・最大 入力${e.maxInputTokens.toLocaleString('ja-JP')} / 出力${e.maxOutputTokens.toLocaleString('ja-JP')}トークン（${e.model}）`;
  if (!e.maxCost) return `${tokens}。料金表が未設定のため金額は表示できません（.env の PRICE_* で設定できます）`;
  const amount =
    e.maxCost.currency === 'JPY' ? `${Math.ceil(e.maxCost.amount).toLocaleString('ja-JP')}円` : `$${e.maxCost.amount.toFixed(4)}`;
  return `${tokens}。費用は多く見ても約${amount}（${e.maxCost.priceCheckedDate}時点の料金表）`;
}

export function shouldSuggestProposal(newSamples: number): boolean {
  return newSamples >= LEARNING_LIMITS.minSamplesForProposal;
}
