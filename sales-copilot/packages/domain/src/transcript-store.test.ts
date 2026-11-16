import { describe, expect, it } from 'vitest';
import { TranscriptStore } from './transcript-store';
import { stt } from './test-helpers';

describe('TranscriptStore — SPEC §16-1 #1 interim updates are not duplicated', () => {
  it('interim updates reuse the same segment and the final completes it', () => {
    const ts = new TranscriptStore();
    const a = ts.ingest(stt({ text: '御社の', startMs: 1000 }));
    const b = ts.ingest(stt({ text: '御社のシステムは', startMs: 1000 }));
    const c = ts.ingest(stt({ text: '御社のシステムは連携', startMs: 1005 }));
    const d = ts.ingest(stt({ text: '御社のシステムは連携できますか？', startMs: 1000, isFinal: true, speechFinal: true }));
    expect(a.change).toBe('interim_created');
    expect(b.change).toBe('interim_updated');
    expect(c.change).toBe('interim_updated');
    expect(d.change).toBe('final_created');
    expect(new Set([a, b, c, d].map((r) => r.segment!.segmentId)).size).toBe(1);
    expect(ts.allSegments()).toHaveLength(1);
    expect(ts.finalUtterances()).toHaveLength(1);
    expect(ts.finalUtterances()[0]!.text).toBe('御社のシステムは連携できますか？');
    expect(d.segment!.revision).toBeGreaterThan(a.segment!.revision);
  });

  it('interim with drifting start time still updates the single in-flight interim', () => {
    const ts = new TranscriptStore();
    ts.ingest(stt({ text: 'えっと', startMs: 1000 }));
    ts.ingest(stt({ text: 'えっと月額は', startMs: 1200 }));
    expect(ts.allSegments()).toHaveLength(1);
  });

  it('late interim after final is ignored (does not regress text)', () => {
    const ts = new TranscriptStore();
    ts.ingest(stt({ text: 'できません', startMs: 0, isFinal: true }));
    const r = ts.ingest(stt({ text: 'できます', startMs: 0 }));
    expect(r.change).toBe('stale_interim_ignored');
    expect(ts.finalUtterances()[0]!.text).toBe('できません');
  });

  it('interim text is never part of utterance (final-only) text', () => {
    const ts = new TranscriptStore();
    ts.ingest(stt({ text: 'できます', startMs: 0 }));
    expect(ts.finalUtterances()).toHaveLength(0);
  });

  it('separate final segments group into one utterance until speechFinal', () => {
    const ts = new TranscriptStore();
    ts.ingest(stt({ text: '連携は', startMs: 0, endMs: 700, isFinal: true }));
    ts.ingest(stt({ text: 'できますか？', startMs: 700, endMs: 1500, isFinal: true, speechFinal: true }));
    ts.ingest(stt({ text: '次の話です', startMs: 3000, endMs: 3800, isFinal: true, speechFinal: true }));
    const u = ts.finalUtterances();
    expect(u.map((x) => x.text)).toEqual(['連携はできますか？', '次の話です']);
  });
});

describe('TranscriptStore — SPEC §16-1 #2 「できます」→「できません」 invalidates dependent advice', () => {
  it('final revision changes text and returns dependent advice ids', () => {
    const ts = new TranscriptStore();
    const r = ts.ingest(stt({ text: 'それはできます', startMs: 0, isFinal: true, speechFinal: true }));
    const uttId = r.utterance!.utteranceId;
    ts.registerAdviceDependency('adv_1', [uttId]);
    ts.registerAdviceDependency('adv_2', ['other']);
    const rev = ts.ingest(stt({ text: 'それはできません', startMs: 0, isFinal: true, speechFinal: true }));
    expect(rev.change).toBe('final_revised');
    expect(rev.utteranceTextChanged).toBe(true);
    expect(rev.invalidatedAdviceIds).toEqual(['adv_1']);
    expect(ts.getUtterance(uttId)!.text).toBe('それはできません');
    expect(ts.getUtterance(uttId)!.revision).toBe(2);
    expect(ts.allSegments()).toHaveLength(1);
  });

  it('appending a final segment that turns 「できます」 into 「できますか？」 invalidates advice', () => {
    const ts = new TranscriptStore();
    const r = ts.ingest(stt({ text: 'できます', startMs: 0, endMs: 600, isFinal: true }));
    ts.registerAdviceDependency('adv_1', [r.utterance!.utteranceId]);
    const r2 = ts.ingest(stt({ text: 'か？', startMs: 600, endMs: 900, isFinal: true, speechFinal: true }));
    expect(r2.utterance!.text).toBe('できますか？');
    expect(r2.invalidatedAdviceIds).toEqual(['adv_1']);
  });

  it('interim 「できます」 then final 「できません」 never yields an utterance saying できます', () => {
    const ts = new TranscriptStore();
    ts.ingest(stt({ text: 'できます', startMs: 0 }));
    const f = ts.ingest(stt({ text: 'できません', startMs: 0, isFinal: true, speechFinal: true }));
    expect(f.change).toBe('final_created');
    expect(ts.finalUtterances().map((u) => u.text)).toEqual(['できません']);
  });
});

describe('TranscriptStore — SPEC §16-1 #17 duplicate finals / reconnection', () => {
  it('redelivered identical final is a duplicate (no new segment, no text change)', () => {
    const ts = new TranscriptStore();
    ts.ingest(stt({ text: '月額はいくらですか', startMs: 0, isFinal: true, speechFinal: true }));
    const d = ts.ingest(stt({ text: '月額はいくらですか', startMs: 2, isFinal: true, speechFinal: true }));
    expect(d.change).toBe('duplicate');
    expect(d.utteranceTextChanged).toBe(false);
    expect(ts.allSegments()).toHaveLength(1);
  });

  it('after reconnect (new streamGeneration), overlapping identical final is a duplicate', () => {
    const ts = new TranscriptStore();
    ts.ingest(stt({ text: '月額はいくらですか', startMs: 10_000, endMs: 11_500, isFinal: true, speechFinal: true }));
    const d = ts.ingest(
      stt({ text: '月額は、いくらですか。', startMs: 10_050, endMs: 11_450, streamGeneration: 1, isFinal: true, speechFinal: true }),
    );
    expect(d.change).toBe('duplicate');
    expect(ts.finalUtterances()).toHaveLength(1);
  });

  it('same text at a different time is NOT a duplicate (repeated question is real)', () => {
    const ts = new TranscriptStore();
    ts.ingest(stt({ text: 'はい', startMs: 0, endMs: 300, isFinal: true, speechFinal: true }));
    const r = ts.ingest(stt({ text: 'はい', startMs: 5000, endMs: 5300, isFinal: true, speechFinal: true }));
    expect(r.change).toBe('final_created');
    expect(ts.finalUtterances()).toHaveLength(2);
  });
});

describe('TranscriptStore — SPEC §16-1 #4 UNKNOWN / overlap are flagged, not silently confirmed', () => {
  it('UNKNOWN source is flagged', () => {
    const ts = new TranscriptStore();
    const r = ts.ingest(stt({ text: '導入します', startMs: 0, source: 'UNKNOWN', isFinal: true, speechFinal: true }));
    expect(r.utterance!.flags).toContain('unknown_source');
  });

  it('same text on SELF and REMOTE at the same time is flagged as possible echo on both', () => {
    const ts = new TranscriptStore();
    const a = ts.ingest(stt({ text: '来週デモを見たいです', startMs: 0, endMs: 1500, source: 'REMOTE', isFinal: true, speechFinal: true }));
    const b = ts.ingest(stt({ text: '来週デモを見たいです', startMs: 80, endMs: 1550, source: 'SELF', isFinal: true, speechFinal: true }));
    expect(b.utterance!.flags).toContain('possible_echo');
    expect(ts.getUtterance(a.utterance!.utteranceId)!.flags).toContain('possible_echo');
  });
});
