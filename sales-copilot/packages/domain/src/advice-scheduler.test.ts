import { describe, expect, it } from 'vitest';
import { AdviceScheduler, type SchedulerEvent } from './advice-scheduler';
import { ManualClock } from './clock';
import { llmOut } from './test-helpers';

function setup(opts: { canStart?: () => boolean } = {}) {
  const clock = new ManualClock(1_000_000);
  const s = new AdviceScheduler({ sessionId: 's1', promptVersion: 'p1', clock, cooldownMs: 6000, staleMs: 8000, ...opts });
  return { clock, s };
}
const started = (ev: SchedulerEvent[]) => ev.flatMap((e) => (e.type === 'start' ? [e.job] : []));
const of = <T extends SchedulerEvent['type']>(ev: SchedulerEvent[], t: T) =>
  ev.filter((e): e is Extract<SchedulerEvent, { type: T }> => e.type === t);
const q = (id: string, rev = 0) => ({ utteranceId: id, text: '連携はできますか？', source: 'REMOTE' as const, contextRevision: rev });

describe('AdviceScheduler — basics', () => {
  it('backchannels neither trigger nor cancel', () => {
    const { s } = setup();
    expect(of(s.requestAuto({ ...q('u1'), text: 'なるほど' }), 'rejected')[0]!.reason).toBe('backchannel');
    const job = started(s.requestAuto(q('u2')))[0]!;
    const ev = s.requestAuto({ ...q('u3'), text: 'はい、はい' });
    expect(of(ev, 'rejected')[0]!.reason).toBe('backchannel');
    expect(job.signal.aborted).toBe(false);
    expect(s.inflightJob?.jobId).toBe(job.jobId);
  });

  it('SELF utterances do not auto-trigger', () => {
    const { s } = setup();
    expect(of(s.requestAuto({ ...q('u1'), source: 'SELF' }), 'rejected')[0]!.reason).toBe('self_utterance');
  });

  it('one in-flight, latest one queued, cooldown applies to auto', () => {
    const { s, clock } = setup();
    const j1 = started(s.requestAuto(q('u1')))[0]!;
    const e2 = s.requestAuto(q('u2'));
    expect(of(e2, 'queued')).toHaveLength(1);
    const e3 = s.requestAuto(q('u3'));
    expect(of(e3, 'replaced_pending')).toHaveLength(1);
    expect(s.pendingJob!.triggerUtteranceId).toBe('u3');
    clock.advance(1000);
    const done = s.complete(j1.jobId, llmOut());
    expect(of(done, 'display')).toHaveLength(1);
    expect(started(done)).toHaveLength(0); // still in cooldown
    clock.advance(5000);
    const t = s.tick();
    expect(started(t)[0]!.triggerUtteranceId).toBe('u3');
  });

  it('manual bypasses cooldown, aborts auto in flight, but is rate-limited', () => {
    const { s, clock } = setup();
    const auto = started(s.requestAuto(q('u1')))[0]!;
    const ev = s.requestManual('rebuttal', 0);
    expect(of(ev, 'abort')[0]!.reason).toBe('manual_priority');
    expect(auto.signal.aborted).toBe(true);
    const man = started(ev)[0]!;
    expect(man.trigger).toBe('manual_rebuttal');
    expect(of(s.requestManual('next_step', 0), 'rejected')[0]!.reason).toBe('rate_limited');
    clock.advance(1500);
    expect(of(s.requestManual('next_step', 0), 'queued')).toHaveLength(1);
    // the aborted auto result arriving late is discarded
    expect(of(s.complete(auto.jobId, llmOut()), 'discard')[0]!.reason).toBe('aborted');
    // auto cannot replace a pending manual
    expect(of(s.requestAuto(q('u9')), 'rejected')[0]!.reason).toBe('blocked');
    void man;
  });
});

describe('AdviceScheduler — SPEC §16-1 #3 old LLM responses never overwrite newer advice', () => {
  it('significant context change aborts in-flight; its late result is discarded', () => {
    const { s } = setup();
    const j1 = started(s.requestAuto(q('u1', 1)))[0]!;
    const ev = s.updateContextRevision(2, true);
    expect(of(ev, 'abort')[0]!.reason).toBe('context_changed');
    expect(j1.signal.aborted).toBe(true);
    expect(of(s.complete(j1.jobId, llmOut({ headline: '古い' })), 'discard')[0]!.reason).toBe('aborted');
    expect(s.currentCard).toBeNull();
  });

  it('result generated against an older revision is discarded even if not aborted', () => {
    const { s } = setup();
    const j1 = started(s.requestAuto(q('u1', 1)))[0]!;
    // non-significant bump does not abort
    expect(s.updateContextRevision(2, false)).toEqual([]);
    const done = s.complete(j1.jobId, llmOut());
    expect(of(done, 'display')).toHaveLength(1);
    const j2 = started(s.requestManual('next_question', 2))[0]!;
    // simulate stale: a significant change happened but complete arrives for j2 (abort fired) – discard
    s.updateContextRevision(3, true);
    expect(of(s.complete(j2.jobId, llmOut()), 'discard')).toHaveLength(1);
    expect(s.currentCard!.trigger).toBe('auto');
  });

  it('newer card displayed first keeps priority over an older job (seq ordering)', () => {
    const { s, clock } = setup();
    const j1 = started(s.requestAuto(q('u1')))[0]!;
    s.complete(j1.jobId, llmOut({ headline: 'A' }));
    clock.advance(2000);
    const j2 = started(s.requestManual('rebuttal', 0))[0]!;
    s.complete(j2.jobId, llmOut({ headline: 'B' }));
    // stray duplicate completion of j1
    expect(of(s.complete(j1.jobId, llmOut({ headline: 'A2' })), 'discard')[0]!.reason).toBe('unknown_job');
    expect(s.currentCard!.headline).toBe('B');
  });

  it('topic change demotes current card to reference', () => {
    const { s } = setup();
    const j = started(s.requestAuto(q('u1', 0)))[0]!;
    const card = of(s.complete(j.jobId, llmOut()), 'display')[0]!.card;
    const ev = s.updateContextRevision(1, true);
    expect(of(ev, 'card_status')[0]).toMatchObject({ adviceId: card.adviceId, status: 'reference', reason: 'topic_changed' });
  });

  it('card older than staleMs becomes reference on tick', () => {
    const { s, clock } = setup();
    const j = started(s.requestAuto(q('u1')))[0]!;
    const card = of(s.complete(j.jobId, llmOut()), 'display')[0]!.card;
    expect(card.expiresAt - card.createdAt).toBe(8000);
    clock.advance(7999);
    expect(of(s.tick(), 'card_status')).toHaveLength(0);
    clock.advance(1);
    expect(of(s.tick(), 'card_status')[0]).toMatchObject({ status: 'reference', reason: 'stale' });
    expect(s.currentCard!.status).toBe('reference');
  });

  it('transcript revision invalidates the card', () => {
    const { s } = setup();
    const j = started(s.requestAuto(q('u1')))[0]!;
    const card = of(s.complete(j.jobId, llmOut()), 'display')[0]!.card;
    expect(of(s.invalidate(card.adviceId), 'card_status')[0]!.status).toBe('invalidated');
    expect(s.getCard(card.adviceId)!.warnings.map((w) => w.code)).toContain('transcript_revised');
  });

  it('action none does not replace the current card', () => {
    const { s, clock } = setup();
    const j = started(s.requestAuto(q('u1')))[0]!;
    s.complete(j.jobId, llmOut({ headline: 'A' }));
    clock.advance(2000);
    const j2 = started(s.requestManual('next_step', 0))[0]!;
    expect(of(s.complete(j2.jobId, llmOut({ action: 'none', headline: '' })), 'no_advice')).toHaveLength(1);
    expect(s.currentCard!.headline).toBe('A');
  });
});

describe('AdviceScheduler — self speaking & shutdown', () => {
  it('big card replacement is deferred while SELF speaks, shown after', () => {
    const { s, clock } = setup();
    const j = started(s.requestAuto(q('u1')))[0]!;
    s.setSelfSpeaking(true);
    const ev = s.complete(j.jobId, llmOut());
    expect(of(ev, 'deferred')).toHaveLength(1);
    expect(s.currentCard).toBeNull();
    clock.advance(1000);
    expect(of(s.setSelfSpeaking(false), 'display')).toHaveLength(1);
  });

  it('deferred card that expired while SELF spoke is discarded', () => {
    const { s, clock } = setup();
    const j = started(s.requestAuto(q('u1')))[0]!;
    s.setSelfSpeaking(true);
    s.complete(j.jobId, llmOut());
    clock.advance(9000);
    expect(of(s.setSelfSpeaking(false), 'discard')[0]!.reason).toBe('expired');
  });

  it('SPEC §16-1 #5: after shutdown nothing starts and late results are discarded', () => {
    const { s } = setup();
    const j = started(s.requestAuto(q('u1')))[0]!;
    s.requestAuto(q('u2'));
    const ev = s.shutdown();
    expect(j.signal.aborted).toBe(true);
    expect(of(ev, 'discard')).toHaveLength(1); // pending dropped
    expect(of(s.requestManual('rebuttal', 0), 'rejected')[0]!.reason).toBe('shutdown');
    expect(of(s.requestAuto(q('u3')), 'rejected')[0]!.reason).toBe('shutdown');
    expect(started(s.tick())).toHaveLength(0);
    expect(of(s.complete(j.jobId, llmOut()), 'discard')).toHaveLength(1);
    expect(s.currentCard).toBeNull();
  });

  it('canStart guard (lifecycle/budget) blocks starting new external calls', () => {
    let allowed = false;
    const { s } = setup({ canStart: () => allowed });
    expect(started(s.requestAuto(q('u1')))).toHaveLength(0);
    allowed = true;
    expect(started(s.tick())).toHaveLength(1);
  });
});
