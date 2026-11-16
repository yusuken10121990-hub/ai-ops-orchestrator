import { describe, expect, it } from 'vitest';
import { ConversationState, ManualClock } from '@sales-copilot/domain';
import { shouldTriggerAuto } from './triggers';
import { extractMemoCandidates } from './memo-extract';
import type { AdviceWindowUtterance } from './types';

let n = 0;
const R = (text: string, flags?: string[]): AdviceWindowUtterance => ({ utteranceId: `r${++n}`, source: 'REMOTE', text, ...(flags ? { flags } : {}) });
const S = (text: string): AdviceWindowUtterance => ({ utteranceId: `s${++n}`, source: 'SELF', text });

function decide(utterance: AdviceWindowUtterance, window: AdviceWindowUtterance[] = [], extra: Partial<Parameters<typeof shouldTriggerAuto>[0]> = {}) {
  return shouldTriggerAuto({ utterance, window: [...window, utterance], ...extra });
}

describe('shouldTriggerAuto — customer side', () => {
  it.each(['はい', 'なるほど', 'そうですね。', 'はいはい、なるほど'])('backchannel %s never triggers', (t) => {
    expect(decide(R(t))).toEqual({ trigger: false, reason: 'backchannel' });
    expect(decide(S(t)).trigger).toBe(false);
  });

  it.each([
    ['結局、月いくらですか？', 'customer_question'],
    ['どれくらいの期間で使えるようになるか知りたいです', 'customer_question'],
    ['正直、現場が使いこなせるか不安です', 'customer_concern'],
    ['一度持ち帰って部長と相談します', 'consideration_or_hold'],
    ['一件で確認するなら良さそうです', 'next_step_agreement'],
    ['保守を誰がやるのかは気になっています', 'operation_condition'],
    ['今回は見送ります', 'customer_decline'],
  ] as const)('%s → %s', (t, reason) => {
    expect(decide(R(t))).toEqual({ trigger: true, reason });
  });

  it('possible echo of our own voice does not trigger', () => {
    expect(decide(R('月額はいくらですか？', ['possible_echo'])).trigger).toBe(false);
  });

  it('「便利そう」 depends on context: unresolved memo or right after our explanation', () => {
    const line = () => R('便利そうですね');
    expect(decide(line()).trigger).toBe(false);
    expect(decide(line(), [S('見積の入力画面で、過去案件から似た明細を自動で候補に出せる形です。')])).toEqual({
      trigger: true,
      reason: 'positive_after_explanation',
    });
    const memo = { memo: { openQuestions: [{ itemId: 'm', field: 'openQuestions' as const, text: '月額', status: 'fact' as const, evidenceUtteranceIds: ['x'], resolved: false }] } };
    expect(decide(line(), [], { memo })).toEqual({ trigger: true, reason: 'positive_with_unresolved' });
  });

  it('a plain statement without signals does not trigger', () => {
    expect(decide(R('うちは営業が5人います。')).trigger).toBe(false);
  });
});

describe('shouldTriggerAuto — SELF-side risks', () => {
  it('unverified price/period assertion', () => {
    expect(decide(S('月額は3万円です。'))).toEqual({ trigger: true, reason: 'self_unverified_claim' });
    expect(decide(S('納期は大丈夫です。'))).toEqual({ trigger: true, reason: 'self_unverified_claim' });
    expect(decide(S('精度は絶対出ます。')).reason).toBe('self_unverified_claim');
  });

  it('numbers that trace to approved facts or the customer are fine', () => {
    const facts = [{ factId: 'f', category: 'price_monthly' as const, value: '月額 30,000円', scope: '', sourceNote: '', approvedAt: 1, version: 1, status: 'approved' as const }];
    expect(decide(S('今回のプランは月3万円です。'), [], { approvedFacts: facts }).trigger).toBe(false);
    expect(decide(S('月20時間かかっているんですね。'), [R('月に20時間かかっています。')]).trigger).toBe(false);
  });

  it('repeated free explanation', () => {
    expect(decide(S('無料なのでぜひ。'), [S('無料で試せます。'), R('時間がないんですよね。')])).toEqual({ trigger: true, reason: 'self_repeated_free' });
    expect(decide(S('無料で試せます。')).trigger).toBe(false);
  });

  it('scope expansion before verification', () => {
    expect(decide(S('ついでに請求書の発行も入れておきましょう。'))).toEqual({ trigger: true, reason: 'self_scope_expansion' });
  });

  it('answering a question with a company pitch instead', () => {
    const q = R('既存の図面データは使えますか？');
    expect(decide(S('うちはこれまで製造業向けに多くのシステムを作ってきた会社で、AI活用にも力を入れています。'), [q])).toEqual({
      trigger: true,
      reason: 'self_ignored_question',
    });
    expect(decide(S('図面データは形式を確認してからになりますが、うちでも一度見てみます。'), [q]).trigger).toBe(false);
  });

  it('waiting time vs work time / per person vs company-wide conflation', () => {
    expect(decide(S('2日分の作業が短縮できますね。'), [R('承認待ちで2日止まります。')])).toEqual({ trigger: true, reason: 'self_time_conflation' });
    expect(decide(S('全社で月10時間ですね。'), [R('1人あたり月10時間です。')])).toEqual({ trigger: true, reason: 'self_time_conflation' });
  });

  it('talking long alone is not a trigger', () => {
    expect(decide(S('今日はお時間ありがとうございます。最初に簡単に自己紹介をさせていただいて、そのあと今の業務の流れを伺えればと思っています。')).trigger).toBe(false);
  });
});

describe('extractMemoCandidates', () => {
  function state() {
    return new ConversationState({ clock: new ManualClock(0) });
  }

  it('customer question → openQuestions; price mention → unverified checkItem; never approved facts', () => {
    const st = state();
    const u = { utteranceId: 'u1', source: 'REMOTE' as const, text: '前は月1万円って聞いたんですけど、月額いくらですか？' };
    const c = extractMemoCandidates(u, st);
    expect(c.map((x) => x.field)).toEqual(['openQuestions', 'checkItems']);
    const check = c.find((x) => x.field === 'checkItems')!;
    expect(check.status).toBe('unverified');
    expect(check.meta?.checkCategory).toBe('cost');
    expect(check.evidenceUtteranceIds).toEqual(['u1']);
    // そのまま ConversationState に入る
    st.upsertUtterance({ ...u, startMs: 0, endMs: 1000, flags: [], revision: 1 });
    for (const x of c) expect(st.upsertMemoItem(x).ok).toBe(true);
    expect(st.unresolvedQuestions()).toHaveLength(2);
  });

  it('decline / no contact → declineSignals', () => {
    const c = extractMemoCandidates({ utteranceId: 'u1', source: 'REMOTE', text: '今回は見送ります。連絡も不要です。' }, state());
    expect(c.map((x) => x.field)).toContain('declineSignals');
  });

  it('SELF price assertion becomes a check candidate, not a fact', () => {
    const c = extractMemoCandidates({ utteranceId: 'u1', source: 'SELF', text: '月額は3万円くらいです。' }, state());
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ field: 'checkItems', status: 'unverified' });
  });

  it('cancellation mention → checkItem; no duplicate topic while unresolved', () => {
    const st = state();
    const u1 = { utteranceId: 'u1', source: 'REMOTE' as const, text: '途中解約はできるんですよね。' };
    st.upsertUtterance({ ...u1, startMs: 0, endMs: 1000, flags: [], revision: 1 });
    const c1 = extractMemoCandidates(u1, st);
    expect(c1[0]).toMatchObject({ field: 'checkItems', status: 'unverified' });
    expect(c1[0]!.text.startsWith('途中解約の条件（')).toBe(true);
    st.upsertMemoItem(c1[0]!);
    const c2 = extractMemoCandidates({ utteranceId: 'u2', source: 'REMOTE', text: '解約の違約金とかあります？' }, st);
    expect(c2.filter((x) => x.field === 'checkItems')).toHaveLength(0);
  });

  it('backchannels yield nothing', () => {
    expect(extractMemoCandidates({ utteranceId: 'u1', source: 'REMOTE', text: 'なるほど' }, state())).toEqual([]);
  });
});
