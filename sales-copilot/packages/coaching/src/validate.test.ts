import { describe, expect, it } from 'vitest';
import type { AdviceLlmOutput, ApprovedFact } from '@sales-copilot/contracts';
import { validateAdvice } from './validate';
import { extractNumericExprs, findGuarantee } from './text-rules';
import type { AdviceContext } from './types';

function out(o: Partial<AdviceLlmOutput> = {}): AdviceLlmOutput {
  return {
    action: 'show',
    kind: 'answer',
    headline: '質問に答える',
    say: '確認して正確にお伝えします。',
    avoid: null,
    briefReason: 'テスト',
    evidenceUtteranceIds: ['u1'],
    approvedFactIds: [],
    missingItems: [],
    evidenceLevel: 'tentative',
    nextStepType: 'none',
    ...o,
  };
}

function fact(o: Partial<ApprovedFact> & { factId: string; value: string }): ApprovedFact {
  return { category: 'price_monthly', scope: '架空', sourceNote: '架空', approvedAt: 1, version: 1, status: 'approved', ...o };
}

function ctx(o: Partial<AdviceContext> = {}): AdviceContext {
  return {
    sessionId: 's',
    contextRevision: 1,
    trigger: 'auto',
    purpose: '架空の商談',
    window: [{ utteranceId: 'u1', source: 'REMOTE', text: 'どうなりますか？' }],
    memo: { memo: {} },
    approvedFacts: [],
    degraded: false,
    ...o,
  };
}

describe('numeric extraction', () => {
  it('normalizes money, percent, periods and kanji numerals', () => {
    const keys = (s: string) => extractNumericExprs(s).map((n) => n.key);
    expect(keys('月額3万円です')).toEqual(['money:30000']);
    expect(keys('月額 30,000円（税別）')).toEqual(['money:30000']);
    expect(keys('３０％ と 2割')).toEqual(['pct:30', 'pct:20']);
    expect(keys('最低一年、一週間で、3ヶ月')).toEqual(['year:1', 'week:1', 'month:3']);
    expect(keys('十万円')).toEqual(['money:100000']);
  });
  it('ignores verification units and non-number words', () => {
    expect(extractNumericExprs('まず一件で確認、1件だけ、十分に、一緒に、3Dデータ、2つ')).toEqual([]);
  });
});

describe('guarantee words', () => {
  it.each(['絶対大丈夫です', '必ず減ります', '全部できます', '何でもできます', '精度を保証します', 'いつでも解約できます', '誰も損しない仕組みです', '情報は漏洩しません', '100%です'])(
    'blocks %s',
    (s) => expect(findGuarantee(s)).toBe(true),
  );
  it.each(['必ずしも必要ではありません', '精度まで保証はできないので', '絶対とは言えません'])('allows hedge %s', (s) =>
    expect(findGuarantee(s)).toBe(false),
  );
});

describe('validateAdvice', () => {
  it('passes a clean output unchanged', () => {
    const v = validateAdvice(out(), ctx());
    expect(v.verdict).toBe('ok');
    expect(v.output).toEqual(out());
  });

  it('blocks schema violations (enum, length, extra keys)', () => {
    expect(validateAdvice({ ...out(), kind: 'sell' }, ctx()).blockCategory).toBe('schema');
    expect(validateAdvice(out({ say: 'あ'.repeat(181) }), ctx()).verdict).toBe('blocked');
    expect(validateAdvice({ ...out(), extra: 1 }, ctx()).verdict).toBe('blocked');
    expect(validateAdvice(out({ headline: ' ' }), ctx()).verdict).toBe('blocked');
  });

  it('drops invented utterance IDs and downgrades evidence', () => {
    const v = validateAdvice(out({ evidenceUtteranceIds: ['u1', 'u999'], evidenceLevel: 'supported' }), ctx());
    expect(v.verdict).toBe('repaired');
    expect(v.output.evidenceUtteranceIds).toEqual(['u1']);
    const v2 = validateAdvice(out({ evidenceUtteranceIds: ['zz'], evidenceLevel: 'supported' }), ctx());
    expect(v2.output.evidenceUtteranceIds).toEqual([]);
    expect(v2.output.evidenceLevel).toBe('tentative');
    expect(v2.warnings.map((w) => w.code)).toContain('insufficient_evidence');
  });

  it('accepts utterance IDs that only exist as memo evidence', () => {
    const c = ctx({ memo: { memo: { openQuestions: [{ itemId: 'm1', field: 'openQuestions', text: '月額', status: 'fact', evidenceUtteranceIds: ['old7'], resolved: false }] } } });
    expect(validateAdvice(out({ evidenceUtteranceIds: ['old7'] }), c).verdict).toBe('ok');
  });

  it('invented or unapproved fact IDs block when the say depends on them', () => {
    const c = ctx({ approvedFacts: [fact({ factId: 'f-unv', value: '月額 5万円', status: 'unverified', approvedAt: null })] });
    const v = validateAdvice(out({ say: '確認してお伝えします。', approvedFactIds: ['f-unv'] }), c);
    expect(v.verdict).toBe('blocked');
    expect(v.issues.map((i) => i.rule)).toContain('fact_id_with_say');
    // say が無い hold なら ID を落とすだけ
    const h = validateAdvice(out({ action: 'hold', kind: 'listen', say: null, approvedFactIds: ['nope'] }), c);
    expect(h.verdict).toBe('repaired');
    expect(h.output.approvedFactIds).toEqual([]);
  });

  it('numbers must trace to an approved fact value or the customer’s own words', () => {
    const c = ctx({
      window: [
        { utteranceId: 'u1', source: 'REMOTE', text: '今は月に20時間くらいかかっています。' },
        { utteranceId: 'u2', source: 'SELF', text: '月5万円くらいですかね。' },
        { utteranceId: 'u3', source: 'UNKNOWN', text: '3ヶ月で終わる？' },
      ],
      approvedFacts: [fact({ factId: 'f1', value: '初期費用 300,000円（税別）', category: 'price_initial' })],
    });
    expect(validateAdvice(out({ say: '今は月20時間かかっているんですね。' }), c).verdict).toBe('ok');
    expect(validateAdvice(out({ say: '初期費用は30万円（税別）です。', approvedFactIds: ['f1'] }), c).verdict).toBe('ok');
    // 野中自身の過去発言・帰属不明の発言は出所にならない
    expect(validateAdvice(out({ say: '月5万円です。' }), c).verdict).toBe('blocked');
    expect(validateAdvice(out({ say: '3ヶ月で終わります。' }), c).verdict).toBe('blocked');
    expect(validateAdvice(out({ say: '納期は2週間です。' }), c).verdict).toBe('blocked');
    expect(validateAdvice(out({ say: '効果は30%です。' }), c).verdict).toBe('blocked');
  });

  it('numbers in the headline are checked too', () => {
    expect(validateAdvice(out({ headline: '月3万円と答える', say: '確認します。' }), ctx()).verdict).toBe('blocked');
  });

  it('blocks banned phrases from the system prompt', () => {
    const v = validateAdvice(out({ say: '無料なんだから、とりあえず試しましょう。' }), ctx());
    expect(v.issues.map((i) => i.rule)).toEqual(expect.arrayContaining(['banned_phrase']));
    const v2 = validateAdvice(out({ say: 'まさに弊社の提供価値です。' }), ctx());
    expect(v2.issues.map((i) => i.rule)).toContain('banned_phrase');
    expect(v2.blockCategory).toBe('style');
  });

  it('blocks free offers unless an approved fact says so', () => {
    expect(validateAdvice(out({ say: 'デモは無料でご用意します。' }), ctx()).verdict).toBe('blocked');
    const c = ctx({ approvedFacts: [fact({ factId: 'd', category: 'demo_scope', value: '画面デモは無料（1回）' })] });
    expect(validateAdvice(out({ say: '画面のデモは無料でご用意できます。', approvedFactIds: ['d'] }), c).verdict).toBe('ok');
  });

  it('blocks capability claims in a feasibility context without a tech_spec fact', () => {
    const c = ctx({ window: [{ utteranceId: 'u1', source: 'REMOTE', text: '図面のデータから判断できますか？' }] });
    expect(validateAdvice(out({ say: 'はい、判断できます。' }), c).issues.map((i) => i.rule)).toContain('capability_claim');
    const tc = ctx({
      window: c.window,
      approvedFacts: [fact({ factId: 't', category: 'tech_spec', value: 'PDF図面の寸法読み取りは検証済み' })],
    });
    expect(validateAdvice(out({ say: 'PDFの図面なら読み取りできます。', approvedFactIds: ['t'] }), tc).verdict).toBe('ok');
  });

  it('enforces at most one question and 1–3 sentences', () => {
    expect(validateAdvice(out({ say: 'いつ頃ですか？どなたが使いますか？' }), ctx()).issues.map((i) => i.rule)).toContain('too_many_questions');
    expect(validateAdvice(out({ say: 'はい。そうです。なるほど。分かりました。' }), ctx()).issues.map((i) => i.rule)).toContain('too_many_sentences');
  });

  it('blocks forced in-house vs outsource binary', () => {
    const v = validateAdvice(out({ say: '内製でいくか、うちに外注するか、どちらにしますか？' }), ctx());
    expect(v.issues.map((i) => i.rule)).toContain('forced_binary');
  });

  it('declined → pushing next step becomes a respectful close (no question)', () => {
    const c = ctx({ window: [{ utteranceId: 'u1', source: 'REMOTE', text: '今回は見送ります。連絡も不要です。' }] });
    const v = validateAdvice(out({ kind: 'next_step', say: '来週デモだけでもいかがですか？', nextStepType: 'demo_review' }), c);
    expect(v.verdict).toBe('repaired');
    expect(v.output.nextStepType).toBe('defer');
    expect(v.output.say).not.toMatch(/[？?]/);
  });

  it('next step with unresolved questions → clarify first with a fixed label (no transcript text)', () => {
    const c = ctx({
      trigger: 'manual_next_step',
      memo: { memo: { openQuestions: [{ itemId: 'm1', field: 'openQuestions', text: '月額はいくら？（前は月1万円と聞いた）', status: 'fact', evidenceUtteranceIds: ['u1'], resolved: false }] } },
    });
    const v = validateAdvice(out({ kind: 'next_step', say: 'では次回、デモを見ていただけますか？', nextStepType: 'demo_review' }), c);
    expect(v.verdict).toBe('repaired');
    expect(v.output.nextStepType).toBe('clarify');
    expect(v.output.briefReason).toBe('まだ日程の話より、月額費用の確認が先です。');
    expect(v.output.say).not.toMatch(/1万/);
  });

  it('contract_discussion with only weak positives is downgraded; explicit intent is allowed', () => {
    const weak = ctx({ window: [{ utteranceId: 'u1', source: 'REMOTE', text: 'なるほど、便利そうですね。' }] });
    const say = '手続きの流れをご案内しますね。';
    expect(validateAdvice(out({ kind: 'next_step', say, nextStepType: 'contract_discussion' }), weak).output.nextStepType).toBe('clarify');
    const strong = ctx({ window: [{ utteranceId: 'u1', source: 'REMOTE', text: 'この内容で導入したいので、契約の進め方を教えてください。' }] });
    expect(validateAdvice(out({ kind: 'next_step', say, nextStepType: 'contract_discussion' }), strong).verdict).toBe('ok');
  });

  it('customer cancellation claim contradicting approved terms → clarify with the fact', () => {
    const c = ctx({
      window: [{ utteranceId: 'u1', source: 'REMOTE', text: '解約っていつでもできるって聞いてます。' }],
      approvedFacts: [fact({ factId: 'c1', category: 'cancellation', value: '最低契約期間1年。途中解約は残期間分を支払い' })],
    });
    const v = validateAdvice(out({ say: 'そうですね、問題ありません。' }), c);
    expect(v.verdict).toBe('repaired');
    expect(v.output.approvedFactIds).toEqual(['c1']);
    expect(v.warnings.map((w) => w.code)).toContain('contradicts_fact');
  });

  it('degraded capture downgrades supported evidence', () => {
    const v = validateAdvice(out({ evidenceLevel: 'supported' }), ctx({ degraded: true }));
    expect(v.output.evidenceLevel).toBe('tentative');
    expect(v.warnings.map((w) => w.code)).toContain('degraded_capture');
  });

  it('does not check guarantee words inside avoid (it is what NOT to say)', () => {
    expect(validateAdvice(out({ avoid: '絶対できますと言う' }), ctx()).verdict).toBe('ok');
  });
});
