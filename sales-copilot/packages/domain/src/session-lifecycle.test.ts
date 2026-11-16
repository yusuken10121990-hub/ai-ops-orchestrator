import { describe, expect, it } from 'vitest';
import { AdviceScheduler } from './advice-scheduler';
import { ManualClock } from './clock';
import { SessionLifecycle } from './session-lifecycle';

const frame = (seq: number, source: 'SELF' | 'REMOTE' = 'REMOTE', gen = 0) => ({
  sessionId: 's1',
  source,
  streamGeneration: gen,
  sequence: seq,
});

describe('SessionLifecycle', () => {
  it('requires explicit consent and follows idle→consented→capturing→paused→ended', () => {
    const l = new SessionLifecycle('s1');
    expect(l.consent({ consentConfirmed: false, mode: 'LIVE', selfCaptureEnabled: true })).toMatchObject({
      ok: false,
      reason: 'consent_required',
    });
    expect(l.startCapture().ok).toBe(false);
    expect(l.consent({ consentConfirmed: true, mode: 'LIVE', selfCaptureEnabled: true }).ok).toBe(true);
    expect(l.startCapture().ok).toBe(true);
    expect(l.pause().ok).toBe(true);
    expect(l.resume().ok).toBe(true);
    expect(l.end().ok).toBe(true);
    expect(l.resume()).toMatchObject({ ok: false, reason: 'already_ended' });
    expect(l.state).toBe('ended');
  });

  it('SPEC §16-1 #5: no frames, STT forwarding or LLM calls when paused or ended', () => {
    const clock = new ManualClock(0);
    const l = new SessionLifecycle('s1');
    const sched = new AdviceScheduler({ sessionId: 's1', promptVersion: 'p', clock, canStart: () => l.canCallLlm() });
    const cleanups: string[] = [];
    l.onTransition((_f, to) => {
      if (to === 'paused' || to === 'ended') {
        cleanups.push(to);
        sched.shutdown();
      } else if (to === 'capturing') sched.resume();
    });
    // before capture: nothing
    expect(l.acceptAudioFrame(frame(0))).toEqual({ ok: false, reason: 'not_capturing' });
    l.consent({ consentConfirmed: true, mode: 'OFFLINE', selfCaptureEnabled: true });
    l.startCapture();
    expect(l.acceptAudioFrame(frame(0)).ok).toBe(true);
    expect(l.canForwardToStt('REMOTE')).toBe(true);
    l.pause();
    expect(l.acceptAudioFrame(frame(1))).toEqual({ ok: false, reason: 'not_capturing' });
    expect(l.canForwardToStt('REMOTE')).toBe(false);
    expect(l.canCallLlm()).toBe(false);
    expect(sched.requestManual('rebuttal', 0).some((e) => e.type === 'start')).toBe(false);
    l.resume();
    expect(sched.requestManual('rebuttal', 0).some((e) => e.type === 'start')).toBe(true);
    l.end();
    expect(cleanups).toEqual(['paused', 'ended']);
    expect(l.acceptAudioFrame(frame(2))).toEqual({ ok: false, reason: 'not_capturing' });
    expect(l.canCallLlm()).toBe(false);
    expect(sched.isStopped).toBe(true);
    expect(sched.tick().some((e) => e.type === 'start')).toBe(false);
  });

  it('self capture OFF blocks SELF frames independently of REMOTE', () => {
    const l = new SessionLifecycle('s1');
    l.consent({ consentConfirmed: true, mode: 'LIVE', selfCaptureEnabled: true });
    l.startCapture();
    l.setSelfCapture(false);
    expect(l.acceptAudioFrame(frame(0, 'SELF'))).toEqual({ ok: false, reason: 'self_capture_off' });
    expect(l.canForwardToStt('SELF')).toBe(false);
    expect(l.acceptAudioFrame(frame(0, 'REMOTE')).ok).toBe(true);
  });

  it('SPEC §16-1 #17: duplicate / old sequence and stale generation frames are rejected', () => {
    const l = new SessionLifecycle('s1');
    l.consent({ consentConfirmed: true, mode: 'LIVE', selfCaptureEnabled: false });
    l.startCapture();
    expect(l.acceptAudioFrame(frame(5)).ok).toBe(true);
    expect(l.acceptAudioFrame(frame(5))).toEqual({ ok: false, reason: 'duplicate_or_old_sequence' });
    expect(l.acceptAudioFrame(frame(4))).toEqual({ ok: false, reason: 'duplicate_or_old_sequence' });
    expect(l.acceptAudioFrame(frame(0, 'REMOTE', 1)).ok).toBe(true); // reconnect: new generation
    expect(l.acceptAudioFrame(frame(6, 'REMOTE', 0))).toEqual({ ok: false, reason: 'stale_generation' });
    expect(l.acceptAudioFrame({ ...frame(9), sessionId: 'other' })).toEqual({ ok: false, reason: 'session_mismatch' });
  });
});
