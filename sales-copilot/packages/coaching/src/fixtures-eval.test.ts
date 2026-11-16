import { describe, expect, it } from 'vitest';
import { checkJudgement, loadAllConversationFixtures } from '@sales-copilot/test-fixtures';
import { createAdviceEngine } from './engine';
import { validateAdvice } from './validate';
import { contextFromFixture, FakeAdviceLlm, RuleBasedOfflineLlm } from './testing';

const fixtures = loadAllConversationFixtures();

describe('fixture evaluation harness (SPEC §16-1 7–14, 18)', () => {
  it('covers the required SPEC items and context-dependence pairs', () => {
    const items = new Set(fixtures.flatMap((f) => f.specItems));
    for (const n of [7, 8, 9, 10, 11, 12, 13, 14, 18]) expect(items, `item ${n}`).toContain(n);
    const groups = new Map<string, number>();
    for (const f of fixtures) if (f.contextGroup) groups.set(f.contextGroup, (groups.get(f.contextGroup) ?? 0) + 1);
    expect([...groups.values()].filter((n) => n >= 2).length).toBeGreaterThanOrEqual(2);
  });

  for (const f of fixtures) {
    describe(`${f.id}: ${f.title}`, () => {
      const ctx = contextFromFixture(f);

      it.each(f.candidates.good.map((o, i) => [i, o] as const))('good candidate #%i passes validation and judgement', (_i, out) => {
        const v = validateAdvice(out, ctx);
        expect(v.issues).toEqual([]);
        expect(v.verdict).toBe('ok');
        const j = checkJudgement(v.output, f.expect, 'full');
        expect(j.failures).toEqual([]);
      });

      it.each(f.candidates.bad.map((b) => [b.note, b.output] as const))('bad candidate is blocked or repaired: %s', (_note, out) => {
        const v = validateAdvice(out, ctx);
        expect(v.verdict).not.toBe('ok');
        if (v.verdict === 'repaired') {
          const j = checkJudgement(v.output, f.expect, 'safety');
          expect(j.failures).toEqual([]);
        }
      });

      it('engine: bad → bad (retry) → safe fallback that respects safety constraints', async () => {
        const bad = f.candidates.bad[0]!.output;
        const llm = new FakeAdviceLlm([{ output: bad }]);
        const res = await createAdviceEngine({ llm }).generate(ctx, new AbortController().signal);
        expect(res.outcome).not.toBe('ok');
        expect(llm.callCount).toBeLessThanOrEqual(2);
        expect(checkJudgement(res.output, f.expect, 'safety').failures).toEqual([]);
      });

      it('engine: bad then good → shows the good candidate (or a repair)', async () => {
        const firstBadBlocks = validateAdvice(f.candidates.bad[0]!.output, ctx).verdict === 'blocked';
        const llm = new FakeAdviceLlm([{ output: f.candidates.bad[0]!.output }, { output: f.candidates.good[0]! }]);
        const res = await createAdviceEngine({ llm }).generate(ctx, new AbortController().signal);
        if (firstBadBlocks) {
          expect(res.outcome).toBe('ok');
          expect(res.attempts).toBe(2);
          expect(res.output).toEqual(f.candidates.good[0]);
        } else {
          expect(res.outcome).toBe('repaired');
          expect(res.attempts).toBe(1);
        }
        expect(checkJudgement(res.output, f.expect, 'safety').failures).toEqual([]);
      });

      it('OFFLINE rule-based generator stays within safety constraints', async () => {
        const res = await createAdviceEngine({ llm: new RuleBasedOfflineLlm() }).generate(ctx, new AbortController().signal);
        expect(res.outcome).not.toBe('fallback');
        expect(res.model).toBe('offline-rule-based');
        expect(res.output.briefReason.startsWith('[OFFLINE規則]')).toBe(true);
        expect(checkJudgement(res.output, f.expect, 'safety').failures).toEqual([]);
      });
    });
  }

  it('context dependence: same customer line, different context → different judgement', async () => {
    const byId = new Map(fixtures.map((f) => [f.id, f]));
    const offline = createAdviceEngine({ llm: new RuleBasedOfflineLlm() });
    const run = async (id: string) => (await offline.generate(contextFromFixture(byId.get(id)!), new AbortController().signal)).output;
    // 「検討します」: 未解決あり → 確認 / 見送り明言後 → 終える
    const a = await run('ctx-kentou-unresolved');
    const b = await run('ctx-kentou-declined');
    expect(a.nextStepType).not.toBe('defer');
    expect(a.say).toMatch(/データ/);
    expect(b.nextStepType).toBe('defer');
    expect(b.say ?? '').not.toMatch(/[？?]/);
    // 「結局、月いくらですか？」: 未承認 → 金額なし / 承認済み → 金額と条件ID
    const p1 = await run('f08-price-unapproved');
    const p2 = await run('f08b-price-approved');
    expect(p1.say ?? '').not.toMatch(/\d/);
    expect(p1.approvedFactIds).toEqual([]);
    expect(p2.approvedFactIds).toEqual(['fact-price-monthly']);
    expect(p2.say ?? '').toMatch(/30,000円|3万円/);
  });
});
