import { describe, expect, it } from 'vitest';
import { ApiClient, describeApiError, LearningApi } from '../shared/api';
import { estimateText, rateText, shouldSuggestProposal, versionLabel } from './learning-view';

describe('学習の表示', () => {
  it('n<10 は率を出さず「データ不足」', () => {
    expect(rateText({ rulesVersion: 1, n: 9, helpful: 9, rate: 1, insufficient: true })).toBe('データ不足（9件・あと1件）');
    expect(rateText({ rulesVersion: 1, n: 12, helpful: 9, rate: 0.75, insufficient: false })).toBe('75%（9/12件）');
  });

  it('版の名前', () => {
    expect(versionLabel(null)).toContain('記録なし');
    expect(versionLabel(0)).toContain('ルールなし');
    expect(versionLabel(3)).toBe('版3');
  });

  it('料金表が無ければ金額を出さない', () => {
    const base = { configured: true, model: 'm', sampleCount: 5, enoughSamples: true, maxInputTokens: 3000, maxOutputTokens: 1500 };
    expect(estimateText({ ...base, maxCost: null })).toMatch(/金額は表示できません/);
    expect(estimateText({ ...base, maxCost: { amount: 0.42, currency: 'JPY', priceSource: 's', priceCheckedDate: '2026-11-01' } })).toContain('約1円');
  });

  it('新しい評価が3件以上で改善案づくりを勧める', () => {
    expect(shouldSuggestProposal(2)).toBe(false);
    expect(shouldSuggestProposal(3)).toBe(true);
  });
});

describe('LearningApi', () => {
  it('サーバーの断り理由（日本語）をそのまま表示でき、POST は空でも本文を送る', async () => {
    const calls: RequestInit[] = [];
    const f = (async (_u: string, init: RequestInit) => {
      calls.push(init);
      return new Response(JSON.stringify({ error: 'rule_rejected', message: '金額・期間などの数字はルールに入れられません' }), { status: 422 });
    }) as unknown as typeof fetch;
    const api = new LearningApi(new ApiClient({ baseUrl: 'http://127.0.0.1:8787', token: 't'.repeat(40), fetchImpl: f }));
    const r = await api.approve('p1', { text: '月額は3万円' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(describeApiError(r.error)).toBe('金額・期間などの数字はルールに入れられません');
    const w = await api.wipe();
    expect(w.ok).toBe(false);
    expect(calls[1]!.body).toBe('{}');
  });
});
