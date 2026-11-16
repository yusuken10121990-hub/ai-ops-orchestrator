import { describe, expect, it } from 'vitest';
import { AdviceScheduler, type SchedulerEvent } from './advice-scheduler';
import { ManualClock } from './clock';
import { PinController } from './pin';
import { llmOut } from './test-helpers';

function setup() {
  const clock = new ManualClock(0);
  const s = new AdviceScheduler({ sessionId: 's1', promptVersion: 'p1', clock, staleMs: 8000 });
  const pin = new PinController();
  const make = (headline: string) => {
    const ev = s.requestManual('rebuttal', 0);
    const job = ev.find((e): e is Extract<SchedulerEvent, { type: 'start' }> => e.type === 'start')!.job;
    const d = s.complete(job.jobId, llmOut({ headline }));
    clock.advance(2000);
    return d.find((e): e is Extract<SchedulerEvent, { type: 'display' }> => e.type === 'display')!.card;
  };
  return { clock, s, pin, make };
}

describe('PinController — SPEC §16-1 #6 pin / unpin / expiry stay consistent', () => {
  it('pinned card stays visible while new cards arrive, flagged hasNewerCard', () => {
    const { s, pin, make, clock } = setup();
    const a = make('A');
    expect(pin.pin(s.getCard(a.adviceId))).toEqual({ ok: true });
    make('B');
    const v = pin.view(s.currentCard, clock.now());
    expect(v.mode).toBe('pinned');
    expect(v.card!.headline).toBe('A');
    expect(v.hasNewerCard).toBe(true);
  });

  it('pinned card past expiry shows as reference with warning, never current', () => {
    const { s, pin, make, clock } = setup();
    const a = make('A');
    pin.pin(s.getCard(a.adviceId));
    clock.set(a.expiresAt);
    const v = pin.view(s.currentCard, clock.now());
    expect(v.displayStatus).toBe('reference');
    expect(v.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['stale', 'pinned_stale']));
  });

  it('pinned card that gets invalidated shows invalidated with warning', () => {
    const { s, pin, make, clock } = setup();
    const a = make('A');
    pin.pin(s.getCard(a.adviceId));
    s.invalidate(a.adviceId);
    pin.sync(s.getCard(a.adviceId)!);
    const v = pin.view(s.currentCard, clock.now());
    expect(v.displayStatus).toBe('invalidated');
    expect(v.warnings.map((w) => w.code)).toContain('pinned_stale');
  });

  it('cannot pin invalidated or missing; unpin rules', () => {
    const { s, pin, make, clock } = setup();
    const a = make('A');
    s.invalidate(a.adviceId);
    expect(pin.pin(s.getCard(a.adviceId))).toEqual({ ok: false, error: 'invalidated' });
    expect(pin.pin(undefined)).toEqual({ ok: false, error: 'not_found' });
    expect(pin.unpin('x')).toEqual({ ok: false, error: 'not_pinned' });
    const b = make('B');
    pin.pin(s.getCard(b.adviceId));
    expect(pin.unpin('x')).toEqual({ ok: false, error: 'other_card_pinned' });
    expect(pin.unpin(b.adviceId)).toEqual({ ok: true });
    const v = pin.view(s.currentCard, clock.now());
    expect(v.mode).toBe('live');
    expect(v.card!.adviceId).toBe(b.adviceId);
  });

  it('unpinning after expiry shows the live card status consistently (reference)', () => {
    const { s, pin, make, clock } = setup();
    const a = make('A');
    pin.pin(s.getCard(a.adviceId));
    clock.advance(20_000);
    s.tick();
    pin.unpin(a.adviceId);
    const v = pin.view(s.currentCard, clock.now());
    expect(v.displayStatus).toBe('reference');
    expect(v.warnings.map((w) => w.code)).not.toContain('pinned_stale');
  });
});
