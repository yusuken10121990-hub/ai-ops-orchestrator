import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import { LatencyTracker, percentile } from './latency';
import { ReplayDriver, type ReplayEmit } from './replay';
import { testLogger } from './test-support';

describe('logger redaction (defense in depth)', () => {
  it('redacts known sensitive keys even if accidentally passed', () => {
    const { logger, capture } = testLogger('info');
    logger.info(
      { text: '本文が漏れてはいけない', token: 'tok_should_not_appear_0123456789', nested: { apiKey: 'sk-ant-xxx', customerName: '架空商事' } },
      'oops',
    );
    expect(capture.text).not.toContain('本文が漏れて');
    expect(capture.text).not.toContain('tok_should_not_appear');
    expect(capture.text).not.toContain('sk-ant-xxx');
    expect(capture.text).not.toContain('架空商事');
    expect(capture.text).toContain('[redacted]');
  });
});

describe('config', () => {
  it('defaults: loopback, nova-3/ja from env, no price table without source/date, keys absent → null', () => {
    const c = loadConfig({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.deepgram).toMatchObject({ apiKey: null, model: 'nova-3', language: 'ja', endpointingMs: 300, utteranceEndMs: 1000 });
    expect(c.anthropic.apiKey).toBeNull();
    expect(loadConfig({ PRICE_CURRENCY: 'USD', PRICE_STT_PER_MINUTE: '0.01' }).priceTable).toBeNull();
    expect(
      loadConfig({ PRICE_CURRENCY: 'USD', PRICE_SOURCE: 'vendor page', PRICE_CHECKED_DATE: '2026-11-16', PRICE_STT_PER_MINUTE: '0.01' }).priceTable,
    ).toMatchObject({ currency: 'USD', sttPerMinute: 0.01, llmInputPerMTok: null });
  });
});

describe('latency', () => {
  it('nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it('measures speechEnd→sent via audio arrival mapping and counts outcomes', () => {
    const t = new LatencyTracker();
    for (let i = 1; i <= 50; i++) t.audioArrived('REMOTE', i * 100, 10_000 + i * 100);
    // 発話終端（音声時刻 2050ms）を含むフレームは 2100ms（到着 12_100）
    expect(t.wallTimeForAudio('REMOTE', 2050)).toBe(12_100);
    t.speechEnded('u1', 12_100, 12_500);
    t.eligible();
    t.requested('j1', 'u1', 12_600);
    t.validated('j1', 14_000);
    t.sent('j1', 14_010);
    t.outcome('noAdvice');
    const s = t.stats();
    expect(s.speechEndToSentMs).toMatchObject({ n: 1, p50: 1910, p95: 1910 });
    expect(s.sttFinalToSentMs.p50).toBe(1510);
    expect(s.requestedToValidatedMs.p50).toBe(1400);
    expect(s.counts).toMatchObject({ eligible: 1, started: 1, displayed: 1, noAdvice: 1 });
  });
});

describe('ReplayDriver', () => {
  afterEach(() => vi.useRealTimers());

  it('emits interim/final with a shared segment start; pause holds position; stop emits nothing more', () => {
    vi.useFakeTimers();
    let now = 0;
    const out: ReplayEmit[] = [];
    const d = new ReplayDriver(
      {
        name: 't',
        lines: [
          { atMs: 1000, source: 'REMOTE', text: 'それは', isFinal: false },
          { atMs: 1500, source: 'REMOTE', text: 'それはできますか？', isFinal: true },
          { atMs: 3000, source: 'SELF', text: '確認します。', isFinal: true },
          { atMs: 5000, source: 'REMOTE', text: 'お願いします。', isFinal: true },
        ],
      },
      1,
      (e) => out.push(e),
      () => {},
      () => now,
    );
    const adv = (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    };
    d.start();
    adv(1600);
    expect(out.map((e) => [e.text, e.isFinal, e.startMs])).toEqual([
      ['それは', false, 500],
      ['それはできますか？', true, 500],
    ]);
    d.pause();
    adv(10_000);
    expect(out).toHaveLength(2);
    d.resume();
    adv(1500);
    expect(out).toHaveLength(3);
    d.stop();
    adv(10_000);
    expect(out).toHaveLength(3);
  });
});
