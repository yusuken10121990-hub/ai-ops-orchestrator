import { describe, expect, it } from 'vitest';
import {
  checkJudgement,
  listConversationFixtures,
  listReplayScripts,
  loadAllConversationFixtures,
  loadReplayScript,
} from './index';

describe('conversation fixtures', () => {
  it('load and validate against the contracts', () => {
    const all = loadAllConversationFixtures();
    expect(all.length).toBe(listConversationFixtures().length);
    expect(all.length).toBeGreaterThanOrEqual(10);
    for (const f of all) {
      expect(f.candidates.good.length).toBeGreaterThan(0);
      expect(f.candidates.bad.length).toBeGreaterThan(0);
      const ids = new Set(f.window.map((u) => u.utteranceId));
      for (const o of [...f.candidates.good, ...f.candidates.bad.map((b) => b.output)]) {
        for (const id of o.evidenceUtteranceIds) expect(ids.has(id), `${f.id}:${id}`).toBe(true);
      }
    }
  });

  it('use no real-looking personal data (synthetic only)', () => {
    const text = JSON.stringify(loadAllConversationFixtures());
    expect(text).not.toMatch(/@[a-z0-9-]+\.(com|jp)|\d{2,4}-\d{2,4}-\d{4}/i);
  });

  it('checkJudgement catches forbidden patterns, invented numbers and question count', () => {
    const f = loadAllConversationFixtures().find((x) => x.id === 'f08-price-unapproved')!;
    const bad = { ...f.candidates.good[0]!, say: '月3万円です。どうですか？いかがですか？' };
    const r = checkJudgement(bad, f.expect, 'safety');
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual(expect.arrayContaining(['invented number', 'too many questions (2)']));
  });
});

describe('replay scripts', () => {
  it('lists at least two ~1–2 minute scripts', () => {
    const names = listReplayScripts();
    expect(names.length).toBeGreaterThanOrEqual(2);
    for (const n of names) {
      const s = loadReplayScript(n);
      expect(s.durationMs).toBeGreaterThanOrEqual(50_000);
      expect(s.durationMs).toBeLessThanOrEqual(120_000);
      expect(s.lines.some((l) => l.source === 'SELF')).toBe(true);
      expect(s.lines.some((l) => l.source === 'REMOTE')).toBe(true);
      expect(s.lines.some((l) => !l.isFinal)).toBe(true);
    }
  });

  it('include the interim "できます" → final "できますか？" revision case', () => {
    const s = loadReplayScript('demo-next-step');
    const i = s.lines.findIndex((l) => !l.isFinal && l.text.endsWith('できます'));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(s.lines.slice(i).find((l) => l.isFinal && l.source === 'REMOTE')!.text).toMatch(/できますか？$/);
  });

  it('rejects path-like names', () => {
    expect(() => loadReplayScript('../conversations/f07-benri-only')).toThrow();
  });
});
