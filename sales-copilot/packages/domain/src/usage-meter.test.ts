import { describe, expect, it } from 'vitest';
import { UsageSnapshot } from '@sales-copilot/contracts';
import { UsageMeter } from './usage-meter';

const price = {
  currency: 'USD' as const,
  source: 'test price sheet',
  checkedDate: '2026-11-16',
  sttPerMinute: 0.01,
  llmInputPerMTok: 1,
  llmOutputPerMTok: 5,
};

describe('UsageMeter', () => {
  it('sums STT seconds per source separately and validates against contract', () => {
    const m = new UsageMeter();
    for (let i = 0; i < 10; i++) m.addSttFrame({ source: 'REMOTE', streamGeneration: 0, sequence: i, durationMs: 100 });
    for (let i = 0; i < 5; i++) m.addSttFrame({ source: 'SELF', streamGeneration: 0, sequence: i, durationMs: 200 });
    const snap = m.snapshot();
    expect(snap.sttSecondsBySource).toEqual({ SELF: 1, REMOTE: 1, UNKNOWN: 0 });
    expect(UsageSnapshot.safeParse(snap).success).toBe(true);
  });

  it('SPEC §16-1 #17: duplicate frames and duplicate LLM usage reports are not billed twice', () => {
    const m = new UsageMeter();
    expect(m.addSttFrame({ source: 'REMOTE', streamGeneration: 0, sequence: 1, durationMs: 100 })).toBe(true);
    expect(m.addSttFrame({ source: 'REMOTE', streamGeneration: 0, sequence: 1, durationMs: 100 })).toBe(false);
    expect(m.addSttFrame({ source: 'REMOTE', streamGeneration: 1, sequence: 1, durationMs: 100 })).toBe(true);
    expect(m.addLlmUsage({ callId: 'c1', inputTokens: 100, outputTokens: 10 })).toBe(true);
    expect(m.addLlmUsage({ callId: 'c1', inputTokens: 100, outputTokens: 10 })).toBe(false);
    const s = m.snapshot();
    expect(s.sttSecondsBySource.REMOTE).toBeCloseTo(0.2);
    expect(s.calls).toBe(1);
    expect(s.llmInputTokens).toBe(100);
  });

  it('no price table → cost null (never guessed); partial prices → null', () => {
    const m = new UsageMeter();
    m.addLlmUsage({ callId: 'c1', inputTokens: 1000, outputTokens: 100 });
    expect(m.snapshot().estimatedCost).toBeNull();
    const p = new UsageMeter({ ...price, llmOutputPerMTok: null });
    p.addLlmUsage({ callId: 'c1', inputTokens: 1000, outputTokens: 100 });
    expect(p.snapshot().estimatedCost).toBeNull();
    const u = new UsageMeter(price);
    u.addLlmUsage({ callId: 'c1', inputTokens: null, outputTokens: null });
    expect(u.snapshot().estimatedCost).toBeNull();
    expect(u.unreportedLlmCalls).toBe(1);
  });

  it('computes cost with currency and price source/date when configured', () => {
    const m = new UsageMeter(price);
    for (let i = 0; i < 600; i++) m.addSttFrame({ source: 'REMOTE', streamGeneration: 0, sequence: i, durationMs: 100 });
    m.addLlmUsage({ callId: 'c1', inputTokens: 1_000_000, outputTokens: 100_000 });
    expect(m.snapshot().estimatedCost).toEqual({
      amount: 0.01 + 1 + 0.5,
      currency: 'USD',
      priceSource: 'test price sheet',
      priceCheckedDate: '2026-11-16',
    });
  });

  it('manual-button calls (different model) are priced with the manual unit prices; missing → null', () => {
    const m = new UsageMeter({ ...price, sttPerMinute: null, llmManualInputPerMTok: 20, llmManualOutputPerMTok: 100 });
    m.addLlmUsage({ callId: 'a1', inputTokens: 1_000_000, outputTokens: 0 });
    m.addLlmUsage({ callId: 'm1', inputTokens: 100_000, outputTokens: 10_000, tier: 'manual' });
    expect(m.snapshot().estimatedCost?.amount).toBeCloseTo(1 + 2 + 1, 10);
    expect(m.snapshot().llmInputTokens).toBe(1_100_000);
    expect(m.snapshot().calls).toBe(2);

    const noManualPrice = new UsageMeter({ ...price, sttPerMinute: null });
    noManualPrice.addLlmUsage({ callId: 'a1', inputTokens: 10, outputTokens: 10 });
    expect(noManualPrice.snapshot().estimatedCost).not.toBeNull();
    noManualPrice.addLlmUsage({ callId: 'm1', inputTokens: 10, outputTokens: 10, tier: 'manual' });
    expect(noManualPrice.snapshot().estimatedCost).toBeNull();
  });

  it('warns at 80% and blocks new external calls at 100%', () => {
    const m = new UsageMeter(null, {
      maxSttSeconds: null,
      maxLlmCalls: 5,
      maxLlmInputTokens: null,
      maxLlmOutputTokens: null,
      maxCost: null,
    });
    for (let i = 0; i < 3; i++) m.addLlmUsage({ callId: `c${i}`, inputTokens: 1, outputTokens: 1 });
    expect(m.budgetState().level).toBe('ok');
    m.addLlmUsage({ callId: 'c3', inputTokens: 1, outputTokens: 1 });
    expect(m.budgetState().level).toBe('warn');
    expect(m.canStartExternalCall('llm')).toBe(true);
    m.addLlmUsage({ callId: 'c4', inputTokens: 1, outputTokens: 1 });
    expect(m.budgetState().level).toBe('blocked');
    expect(m.canStartExternalCall('llm')).toBe(false);
    expect(m.canStartExternalCall('stt')).toBe(true);
  });

  it('cost limit blocks all external calls', () => {
    const m = new UsageMeter(price, {
      maxSttSeconds: null,
      maxLlmCalls: null,
      maxLlmInputTokens: null,
      maxLlmOutputTokens: null,
      maxCost: 1,
    });
    m.addLlmUsage({ callId: 'c1', inputTokens: 1_000_000, outputTokens: 0 });
    expect(m.canStartExternalCall('stt')).toBe(false);
    expect(m.canStartExternalCall('llm')).toBe(false);
  });
});
