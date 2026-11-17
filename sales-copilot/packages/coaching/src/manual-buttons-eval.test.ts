import { describe, expect, it } from 'vitest';
import type { AdviceLlmOutput } from '@sales-copilot/contracts';
import { loadConversationFixture } from '@sales-copilot/test-fixtures';
import { createAdviceEngine } from './engine';
import { classifyObjection, detectDecline, hasNextStepAsk, manualAnchor, respondsToObjection, type ObjectionType } from './objection';
import { buildAdvicePrompt } from './prompt';
import { contextFromFixture, FakeAdviceLlm, RuleBasedOfflineLlm } from './testing';
import { validateAdvice } from './validate';
import type { AdviceContext } from './types';

const sig = () => new AbortController().signal;

/** プロンプトの <latest_customer_data> を取り出す（データとして JSON.parse で戻る）。 */
function latestBlock(user: string): Array<{ utteranceId: string; text: string }> {
  const m = user.match(/<latest_customer_data>\n([\s\S]*?)\n<\/latest_customer_data>/);
  if (!m) throw new Error('latest_customer_data missing');
  return JSON.parse(m[1]!) as Array<{ utteranceId: string; text: string }>;
}

const REBUTTAL_CASES: Array<{ id: string; objection: string; type: ObjectionType }> = [
  { id: 'r01-rebuttal-price-objection', objection: 'うーん、ちょっと高いですね。', type: 'price' },
  { id: 'r02-rebuttal-no-need', objection: '今は特に困っていないんですよ。', type: 'no_need' },
  { id: 'r03-rebuttal-compare', objection: '他社さんとも比較してから決めたいと思っています。', type: 'compare' },
  { id: 'r04-rebuttal-decline', objection: '社内でも話したんですが、今回は見送りにさせてください。', type: 'decline' },
];

describe('objection classification and decline detection (pure)', () => {
  it.each([
    ['ちょっと高いですね', 'price'],
    ['予算的に厳しいです', 'price'],
    ['結局、月いくらですか？', 'price_question'],
    ['今は特に困っていないんですよ', 'no_need'],
    ['他社さんとも比較してから決めたい', 'compare'],
    ['今回は見送りにさせてください', 'decline'],
    ['今回は結構です', 'decline'],
    ['うちには必要ないです', 'decline'],
    ['今は時期が悪くて', 'timing'],
    ['上司に相談してからにします', 'authority'],
    ['社内で検討します', 'consider'],
    ['画面はだいたい分かりました', 'other'],
  ] as const)('%s → %s', (text, type) => {
    expect(classifyObjection(text)).toBe(type);
  });

  it('detectDecline looks only at the latest customer (REMOTE) turns, never SELF', () => {
    const w = (texts: Array<['SELF' | 'REMOTE', string]>) => texts.map(([source, text], i) => ({ utteranceId: `u${i}`, source, text }));
    expect(detectDecline(w([['REMOTE', '今回は見送りにさせてください。']]))).toEqual({ declined: true, evidenceUtteranceIds: ['u0'] });
    expect(detectDecline(w([['REMOTE', '今回は結構です']])).declined).toBe(true);
    expect(detectDecline(w([['REMOTE', '必要ないです']])).declined).toBe(true);
    expect(detectDecline(w([['REMOTE', '今は特に困っていないんですよ']])).declined).toBe(false);
    expect(detectDecline(w([['SELF', '今回は見送りでも大丈夫です']])).declined).toBe(false);
    // 古い見送りは lookback を過ぎたら効かない
    expect(
      detectDecline(w([['REMOTE', '今回は見送ります'], ['REMOTE', 'あ、でも'], ['REMOTE', 'やっぱり一件で'], ['REMOTE', '試したいです']])).declined,
    ).toBe(false);
  });

  it('anchor skips a trailing backchannel and answers the objection before it', () => {
    const a = manualAnchor([
      { utteranceId: 'u1', source: 'REMOTE', text: 'ちょっと高いですね' },
      { utteranceId: 'u2', source: 'SELF', text: 'そうですよね' },
      { utteranceId: 'u3', source: 'REMOTE', text: 'はい' },
    ]);
    expect(a.target?.utteranceId).toBe('u1');
    expect(a.type).toBe('price');
  });

  it('hasNextStepAsk recognises an ask', () => {
    expect(hasNextStepAsk('来週の火曜か木曜で30分ほどお時間をいただけますか？')).toBe(true);
    expect(hasNextStepAsk('本日はありがとうございました。')).toBe(false);
  });
});

describe('切り返し: anchored on the latest customer objection (fixture evals)', () => {
  for (const c of REBUTTAL_CASES) {
    describe(c.id, () => {
      const f = loadConversationFixture(c.id);
      const ctx = contextFromFixture(f);

      it('prompt quotes the actual objection verbatim as the anchor', () => {
        const { user } = buildAdvicePrompt(ctx);
        const latest = latestBlock(user);
        expect(latest[latest.length - 1]).toEqual({ utteranceId: 'u4', text: c.objection });
        expect(user).toContain('答える対象: utteranceId=u4');
        // 自分（SELF）の発言は直近の相手の発言に入れない
        expect(latest.every((t) => f.window.find((u) => u.utteranceId === t.utteranceId)?.source === 'REMOTE')).toBe(true);
        expect(manualAnchor(ctx.window).type).toBe(c.type);
      });

      it('OFFLINE generator responds to the actual objection (not a hold / not another topic)', async () => {
        const res = await createAdviceEngine({ llm: new RuleBasedOfflineLlm() }).generate(ctx, sig());
        expect(res.outcome).not.toBe('fallback');
        expect(res.output.action).toBe('show');
        expect(res.output.evidenceUtteranceIds).toContain('u4');
        if (c.type === 'decline') {
          expect(res.output.nextStepType).toBe('defer');
          expect(res.output.say ?? '').not.toMatch(/[？?]/);
        } else {
          expect(respondsToObjection(res.output, c.type)).toBe(true);
        }
      });
    });
  }

  it('a card that answers a DIFFERENT objection is rejected (cross-check of every pair)', () => {
    const relevant = REBUTTAL_CASES.filter((c) => c.type !== 'decline');
    for (const target of relevant) {
      const ctx = contextFromFixture(loadConversationFixture(target.id));
      for (const other of relevant) {
        if (other === target) continue;
        const wrongCard = loadConversationFixture(other.id).candidates.good[0]!;
        const v = validateAdvice(wrongCard, ctx);
        expect(v.verdict, `${other.id} card shown for ${target.id}`).toBe('blocked');
        expect(v.issues.map((i) => i.rule)).toContain('off_topic');
      }
    }
  });

  it('engine: off-topic twice → relevant safe fallback (never an unrelated card, never just "listen")', async () => {
    const ctx = contextFromFixture(loadConversationFixture('r01-rebuttal-price-objection'));
    const offTopic = loadConversationFixture('r03-rebuttal-compare').candidates.good[0]!;
    const llm = new FakeAdviceLlm([{ output: offTopic }, { output: offTopic }]);
    const res = await createAdviceEngine({ llm }).generate(ctx, sig());
    expect(llm.callCount).toBe(2);
    expect(llm.requests[1]!.user).toContain('<latest_customer_data> の最後の発言');
    expect(res.outcome).toBe('fallback');
    expect(res.output.action).toBe('show');
    expect(respondsToObjection(res.output, 'price')).toBe(true);
    expect(res.output.say ?? '').not.toMatch(/\d|値引|割引/);
  });

  it('engine: off-topic then relevant → shows the relevant retry', async () => {
    const f = loadConversationFixture('r02-rebuttal-no-need');
    const ctx = contextFromFixture(f);
    const offTopic = loadConversationFixture('r01-rebuttal-price-objection').candidates.good[0]!;
    const llm = new FakeAdviceLlm([{ output: offTopic }, { output: f.candidates.good[0]! }]);
    const res = await createAdviceEngine({ llm }).generate(ctx, sig());
    expect(res.outcome).toBe('ok');
    expect(res.output).toEqual(f.candidates.good[0]);
  });
});

describe('クロージング (manual_closing)', () => {
  const ctxOf = (id: string): AdviceContext => contextFromFixture(loadConversationFixture(id));

  it('prompt states the closing instruction and whether the customer declined', () => {
    const normal = buildAdvicePrompt(ctxOf('c01-closing-normal')).user;
    expect(normal).toContain('［クロージング］');
    expect(normal).toContain('顧客の見送り: なし');
    expect(latestBlock(normal).at(-1)?.text).toBe('一度、普段の見積で試してみたいですね。');
    const declined = buildAdvicePrompt(ctxOf('c03-closing-after-decline')).user;
    expect(declined).toContain('顧客の見送り: あり');
  });

  it('normal closing (OFFLINE) has a concrete next-step ask', async () => {
    const res = await createAdviceEngine({ llm: new RuleBasedOfflineLlm() }).generate(ctxOf('c01-closing-normal'), sig());
    expect(res.outcome).not.toBe('fallback');
    expect(res.output.kind).toBe('next_step');
    expect(hasNextStepAsk(res.output.say)).toBe(true);
    expect(res.output.say ?? '').not.toMatch(/ご契約|お申し込み/);
  });

  it('closing after a price objection (OFFLINE) asserts no price and still asks for the next step', async () => {
    const res = await createAdviceEngine({ llm: new RuleBasedOfflineLlm() }).generate(ctxOf('c02-closing-after-price'), sig());
    expect(res.output.say ?? '').not.toMatch(/\d|円|値引|割引/);
    expect(res.output.approvedFactIds).toEqual([]);
    expect(hasNextStepAsk(res.output.say)).toBe(true);
  });

  it('closing after a clear decline (OFFLINE) thanks them and does not pressure', async () => {
    const res = await createAdviceEngine({ llm: new RuleBasedOfflineLlm() }).generate(ctxOf('c03-closing-after-decline'), sig());
    expect(res.output.nextStepType).toBe('defer');
    expect(res.output.say ?? '').toMatch(/ありがとう/);
    expect(res.output.say ?? '').not.toMatch(/[？?]|日程|来週|お時間をいただけ|値引/);
  });

  it('validation: after decline, a pushy closing is replaced by a polite close', () => {
    const ctx = ctxOf('c03-closing-after-decline');
    const pushy: AdviceLlmOutput = {
      ...loadConversationFixture('c01-closing-normal').candidates.good[0]!,
      evidenceUtteranceIds: ['u5'],
    };
    const v = validateAdvice(pushy, ctx);
    expect(v.verdict).toBe('repaired');
    expect(v.issues.map((i) => i.rule)).toContain('declined_push');
    expect(v.output.nextStepType).toBe('defer');
    expect(v.output.say).toMatch(/ありがとう/);
  });

  it('validation: closing without any ask is blocked; engine falls back to a closing with an ask', async () => {
    const ctx = ctxOf('c01-closing-normal');
    const bare = loadConversationFixture('c01-closing-normal').candidates.bad[0]!.output;
    expect(validateAdvice(bare, ctx).issues.map((i) => i.rule)).toContain('closing_without_ask');
    const res = await createAdviceEngine({ llm: new FakeAdviceLlm([{ output: bare }]) }).generate(ctx, sig());
    expect(res.outcome).toBe('fallback');
    expect(hasNextStepAsk(res.output.say)).toBe(true);
  });

  it('validation: a meeting length ask (30分ほどお時間) is allowed, but a 30-minute effect claim is not', () => {
    const ctx = ctxOf('c01-closing-normal');
    const good = loadConversationFixture('c01-closing-normal').candidates.good[0]!;
    expect(validateAdvice(good, ctx).verdict).toBe('ok');
    const claim = { ...good, say: '入力作業は30分で終わります。来週お時間をいただけますか？' };
    expect(validateAdvice(claim, ctx).issues.map((i) => i.rule)).toContain('unverified_number');
  });

  it('validation: unapproved price or discount in a closing is blocked', () => {
    const ctx = ctxOf('c02-closing-after-price');
    for (const b of loadConversationFixture('c02-closing-after-price').candidates.bad) {
      expect(validateAdvice(b.output, ctx).verdict, b.note).toBe('blocked');
    }
  });
});
