import type { AdviceLlmOutput, AdviceTrigger, ApprovedFact } from '@sales-copilot/contracts';
import { AdviceLlmError } from './errors';
import { clarifyFirstOutput, interestCheckOutput, respectfulCloseOutput } from './validate';
import { DECLINE_RE, STRONG_INTENT_RE, normalizeForRules, topicLabel } from './text-rules';
import type { AdviceLlm, AdviceLlmRequest, AdviceLlmResponse, AdviceMemoItem, AdviceWindowUtterance } from './types';

export const OFFLINE_MODEL_ID = 'offline-rule-based';
const LABEL = '[OFFLINE規則] ';

type FactLite = Pick<ApprovedFact, 'factId' | 'category' | 'value' | 'scope' | 'version'>;

interface ParsedRequest {
  trigger: AdviceTrigger;
  facts: FactLite[];
  memo: Record<string, AdviceMemoItem[]>;
  window: AdviceWindowUtterance[];
}

function block(user: string, tag: string): unknown {
  const m = user.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  if (!m) throw new AdviceLlmError('invalid_json', `offline: missing <${tag}>`);
  return JSON.parse(m[1]!);
}

export function parseAdviceUserMessage(user: string): ParsedRequest {
  const t = user.match(/<request trigger="([a-z_]+)"/);
  const trigger = (t?.[1] ?? 'auto') as AdviceTrigger;
  return {
    trigger,
    facts: block(user, 'approved_facts') as FactLite[],
    memo: block(user, 'memo_data') as Record<string, AdviceMemoItem[]>,
    window: block(user, 'transcript_data') as AdviceWindowUtterance[],
  };
}

function base(o: Partial<AdviceLlmOutput>): AdviceLlmOutput {
  return {
    action: 'show',
    kind: 'answer',
    headline: '',
    say: null,
    avoid: null,
    briefReason: '',
    evidenceUtteranceIds: [],
    approvedFactIds: [],
    missingItems: [],
    evidenceLevel: 'tentative',
    nextStepType: 'none',
    ...o,
  };
}

function label(o: AdviceLlmOutput): AdviceLlmOutput {
  const reason = (LABEL + o.briefReason).slice(0, 80);
  return { ...o, briefReason: reason };
}

/** 条件の値を1文に収める（句点を読点にして、台詞の文数上限を超えないようにする）。 */
function factPhrase(v: string): string {
  return clip(v.replace(/[。．]\s*/g, '、').replace(/[、\s]+$/, ''), 100);
}

function clip(s: string, n: number): string {
  const c = [...s];
  return c.length <= n ? s : c.slice(0, n - 1).join('') + '…';
}

/**
 * API キーなしの OFFLINE デモ用、規則ベースの助言生成器。AI ではない（model=offline-rule-based、
 * briefReason 先頭に [OFFLINE規則] を付ける）。プロンプトのデータブロックだけを読み、
 * エンジンの表示前検証を通る JSON を決定的に返す。
 */
export class RuleBasedOfflineLlm implements AdviceLlm {
  async complete(req: AdviceLlmRequest): Promise<AdviceLlmResponse> {
    if (req.signal.aborted) throw new AdviceLlmError('aborted', 'aborted');
    let parsed: ParsedRequest;
    try {
      parsed = parseAdviceUserMessage(req.user);
    } catch (e) {
      if (e instanceof AdviceLlmError) throw e;
      throw new AdviceLlmError('invalid_json', 'offline: could not parse prompt data');
    }
    const out = label(decide(parsed));
    return { text: JSON.stringify(out), usage: { inputTokens: null, outputTokens: null }, model: OFFLINE_MODEL_ID };
  }
}

function decide(p: ParsedRequest): AdviceLlmOutput {
  const remote = p.window.filter((u) => u.source === 'REMOTE');
  const last = remote[remote.length - 1];
  const lastText = last ? normalizeForRules(last.text) : '';
  const ev = last ? [last.utteranceId] : [];
  const memoItems = Object.entries(p.memo).flatMap(([field, items]) => items.map((i) => ({ ...i, field: field as AdviceMemoItem['field'] })));
  const unresolved = memoItems.filter((i) => (i.field === 'openQuestions' || i.field === 'checkItems') && !i.resolved);
  const declined =
    memoItems.some((i) => i.field === 'declineSignals' && !i.resolved) || remote.slice(-3).some((u) => DECLINE_RE.test(normalizeForRules(u.text)));
  const fact = (...cats: string[]) => p.facts.find((f) => cats.includes(f.category));

  if (declined) return respectfulCloseOutput(ev);

  if (p.trigger === 'manual_next_step') {
    if (unresolved.length > 0) {
      const target = unresolved[unresolved.length - 1]!;
      return clarifyFirstOutput(topicLabel(target.text), target.evidenceUtteranceIds.slice(0, 12));
    }
    if (remote.slice(-3).some((u) => /一件|やってみ|良さそう|見てみたい|試してみ/.test(u.text) || STRONG_INTENT_RE.test(u.text))) {
      const demo = fact('demo_scope');
      return base({
        kind: 'next_step',
        headline: '一件での確認を提案する',
        say: 'でしたら次回は、代表的な一件で、手間がどこまで減るかを一緒に見てみませんか？',
        avoid: 'すぐ契約手続きに進む',
        briefReason: '顧客が一件での確認に前向き',
        evidenceUtteranceIds: ev,
        approvedFactIds: demo ? [demo.factId] : [],
        evidenceLevel: 'supported',
        nextStepType: 'technical_check',
      });
    }
    return interestCheckOutput(ev);
  }

  if (!last) return holdListen('まだ顧客の発言がありません');

  if (/いくら|月額|料金|費用|価格|値段/.test(lastText)) {
    const price = fact('price_monthly', 'price_initial');
    if (price) {
      return base({
        headline: '承認済みの金額を先に答える',
        say: `今回の条件は「${factPhrase(price.value)}」です。`,
        avoid: '範囲外の追加対応まで含むと言う',
        briefReason: '承認済みの今回条件で回答',
        evidenceUtteranceIds: ev,
        approvedFactIds: [price.factId],
        evidenceLevel: 'supported',
      });
    }
    return base({
      headline: '確定額は未確認と伝える',
      say: '今回の内容は、まだ確定額を出せていません。月額に加えて、別途の利用料や契約期間もそろえてお伝えします。',
      avoid: '最安プランの金額を今回の価格のように言う',
      briefReason: '今回の価格は未承認',
      evidenceUtteranceIds: ev,
      missingItems: ['今回の月額'],
      nextStepType: 'quote_review',
    });
  }
  if (/解約|やめられ|辞められ|途中で(やめ|辞め)/.test(lastText)) {
    const terms = fact('cancellation', 'min_term');
    if (terms) {
      return base({
        kind: 'clarify',
        headline: '正式な解約条件で答える',
        say: `今回のプランの条件は「${factPhrase(terms.value)}」です。`,
        avoid: 'いつでも解約できると言う',
        briefReason: '承認済みの解約条件で回答',
        evidenceUtteranceIds: ev,
        approvedFactIds: [terms.factId],
        evidenceLevel: 'supported',
        nextStepType: 'clarify',
      });
    }
    return base({
      headline: '解約条件は確認して伝える',
      say: '今回のプランの条件を確認して、正確にお伝えします。途中でやめた場合に支払いが残るかも含めて、ご案内します。',
      avoid: '月額なのでいつでも解約できると言う',
      briefReason: '解約条件は未承認',
      evidenceUtteranceIds: ev,
      missingItems: ['途中解約の条件'],
    });
  }
  if (/精度|3D|データ|図面/.test(lastText) && /(か|\?)$/.test(lastText)) {
    return base({
      headline: '可否は確認してから答える',
      say: 'そこは実際のデータと、何を判断させたいかを確認してからお答えしたいです。まず一件で確認する進め方がよさそうです。',
      avoid: '実データ確認前に精度を言い切る',
      briefReason: '実データ未確認',
      evidenceUtteranceIds: ev,
      missingItems: ['データ形式'],
      nextStepType: 'technical_check',
    });
  }
  if (/更新/.test(lastText) && /自分たち|自社|社内/.test(lastText)) {
    return base({
      kind: 'clarify',
      headline: '更新したい範囲を確認',
      say: '日々の更新は御社でできるようにしておきたい、ということですね。普段変えたいのは、どのような部分ですか？',
      avoid: '内製か外注かの二択を迫る',
      briefReason: '更新範囲が分かれば答えが決まる',
      evidenceUtteranceIds: ev,
      nextStepType: 'clarify',
    });
  }
  if (/検討/.test(lastText)) {
    if (unresolved.length > 0) {
      const l = topicLabel(unresolved[unresolved.length - 1]!.text);
      return base({
        kind: 'clarify',
        headline: '未解決の点の確認を申し出る',
        say: `承知しました。さきほどの${l}は、こちらでも確認が必要ですね。その結果までお渡しした方が、判断しやすいですかね？`,
        avoid: '日程や契約を迫る',
        briefReason: '未解決事項が残っている',
        evidenceUtteranceIds: ev,
        missingItems: [l],
        nextStepType: 'clarify',
      });
    }
    return base({
      kind: 'clarify',
      headline: '検討に必要な情報を聞く',
      say: '承知しました。ご検討の前に、こちらから出しておいた方がいい情報はありますか？',
      avoid: '日程や契約を迫る',
      briefReason: '検討の表明',
      evidenceUtteranceIds: ev,
      nextStepType: 'clarify',
    });
  }
  if (/便利そう|良さそう|いいですね/.test(lastText)) return interestCheckOutput(ev);
  if (/上司|部長|一人では決め|決められ/.test(lastText)) {
    return base({
      kind: 'clarify',
      headline: '整理しておきたい点を聞く',
      say: 'もちろんです。社内で相談する前に、今回の話でまだ整理しておきたいところはありますか？',
      avoid: '担当者を飛ばして決裁者に連絡する',
      briefReason: '社内確認が必要',
      evidenceUtteranceIds: ev,
      nextStepType: 'stakeholder_review',
    });
  }
  if (/[？?]$|(ですか|ますか|でしょうか)$/.test(lastText.replace(/[。]$/, ''))) {
    return base({
      kind: 'clarify',
      headline: '分からない点は確認を約束',
      say: '大事な点なので、確認して正確にお伝えします。',
      avoid: '未確認のまま言い切る',
      briefReason: '承認済み条件に無い質問',
      evidenceUtteranceIds: ev,
      nextStepType: 'clarify',
    });
  }
  return holdListen('今は相手の説明を聞く場面');
}

function holdListen(reason: string): AdviceLlmOutput {
  return base({ action: 'hold', kind: 'listen', headline: '今は相手の話を聞く', briefReason: reason, evidenceLevel: 'insufficient' });
}
