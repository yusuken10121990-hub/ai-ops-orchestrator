import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock';
import { ConversationState } from './conversation-state';
import { TranscriptStore } from './transcript-store';
import { stt } from './test-helpers';

function setup() {
  const clock = new ManualClock(0);
  const ts = new TranscriptStore();
  const cs = new ConversationState({ clock, windowMs: 90_000 });
  const say = (text: string, startMs: number, source: 'SELF' | 'REMOTE' | 'UNKNOWN' = 'REMOTE') => {
    const r = ts.ingest(stt({ text, startMs, endMs: startMs + 1000, source, isFinal: true, speechFinal: true }));
    const up = cs.upsertUtterance(r.utterance!);
    for (const o of r.otherUtterancesFlagged) cs.upsertUtterance(o);
    return { id: r.utterance!.utteranceId, up, r };
  };
  return { clock, ts, cs, say };
}

describe('ConversationState', () => {
  it('rejects window outside 60–120s', () => {
    expect(() => new ConversationState({ windowMs: 30_000 })).toThrow();
  });

  it('rolling window keeps only recent finals but unresolved questions persist', () => {
    const { cs, say } = setup();
    const q = say('保守費用は月いくらですか？', 0);
    const memo = cs.upsertMemoItem({ field: 'openQuestions', text: '保守費用の月額', status: 'fact', evidenceUtteranceIds: [q.id] });
    expect(memo.ok).toBe(true);
    say('業務フローの説明です', 50_000);
    say('別の話題です', 200_000);
    expect(cs.window().map((u) => u.text)).toEqual(['別の話題です']);
    const unresolved = cs.unresolvedQuestions();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.evidenceUtteranceIds).toEqual([q.id]);
    // 根拠発話はウィンドウ外でも保持されている
    expect(cs.getUtterance(q.id)).toBeDefined();
  });

  it('memo requires existing evidence ids (no facts from nothing)', () => {
    const { cs } = setup();
    expect(cs.upsertMemoItem({ field: 'issues', text: 'x', status: 'fact', evidenceUtteranceIds: [] }).warnings).toEqual([
      'missing_evidence',
    ]);
    expect(cs.upsertMemoItem({ field: 'issues', text: 'x', status: 'fact', evidenceUtteranceIds: ['utt_999'] }).ok).toBe(false);
  });

  it('question / correction bumps contextRevision; backchannel does not', () => {
    const { cs, say } = setup();
    const r0 = cs.contextRevision;
    expect(say('なるほど', 0).up).toMatchObject({ significant: false, backchannel: true });
    expect(cs.contextRevision).toBe(r0);
    expect(say('データ移行はできますか？', 2000).up.significant).toBe(true);
    expect(say('いや、そうではなくて', 4000).up.significant).toBe(true);
    expect(cs.contextRevision).toBe(r0 + 2);
  });

  it('SPEC §16-1 #2: utterance revision marks dependent memo for recheck and bumps revision', () => {
    const { cs, ts, say } = setup();
    const u = say('それはできます', 0);
    const m = cs.upsertMemoItem({ field: 'proposalsAndAgreements', text: '対応可能', status: 'fact', evidenceUtteranceIds: [u.id] });
    const before = cs.contextRevision;
    const rev = ts.ingest(stt({ text: 'それはできません', startMs: 0, endMs: 1000, isFinal: true, speechFinal: true }));
    const res = cs.upsertUtterance(rev.utterance!);
    expect(res.significant).toBe(true);
    expect(res.recheckItemIds).toEqual([m.item!.itemId]);
    expect(cs.contextRevision).toBe(before + 1);
    const item = cs.memoItems('proposalsAndAgreements')[0]!;
    expect(item.needsRecheck).toBe(true);
    expect(item.status).toBe('unverified');
  });

  it('SPEC §16-1 #4: UNKNOWN / echo / one-side-lost never become confirmed facts', () => {
    const { cs, say } = setup();
    const unk = say('導入で進めます', 0, 'UNKNOWN');
    const r1 = cs.upsertMemoItem({ field: 'proposalsAndAgreements', text: '導入合意', status: 'fact', evidenceUtteranceIds: [unk.id] });
    expect(r1.item!.status).toBe('unverified');
    expect(r1.warnings).toContain('unknown_source_evidence');

    const a = say('来週デモを見たいです', 10_000, 'REMOTE');
    say('来週デモを見たいです', 10_050, 'SELF');
    const r2 = cs.upsertMemoItem({ field: 'nextActions', text: 'デモ', status: 'fact', evidenceUtteranceIds: [a.id] });
    expect(r2.item!.status).toBe('unverified');
    expect(r2.warnings).toContain('echo_evidence');

    // 事後に回り込みが判明した場合も、既存の fact を下げる
    const b = say('費用は年額で払います', 30_000, 'REMOTE');
    const r4 = cs.upsertMemoItem({ field: 'checkItems', text: '年額払い', status: 'fact', evidenceUtteranceIds: [b.id] });
    expect(r4.item!.status).toBe('fact');
    say('費用は年額で払います', 30_020, 'SELF');
    expect(cs.memoItems('checkItems')[0]!.status).toBe('unverified');

    cs.setSourceAvailability({ REMOTE: false });
    expect(cs.isDegraded()).toBe(true);
    const s = say('見積もりお願いします', 20_000, 'SELF');
    const r3 = cs.upsertMemoItem({ field: 'proposalsAndAgreements', text: '見積依頼', status: 'fact', evidenceUtteranceIds: [s.id] });
    expect(r3.item!.status).toBe('hypothesis');
    expect(r3.warnings).toContain('degraded_capture');
  });

  it('next action due date is not confirmed unless agreed', () => {
    const { cs, say } = setup();
    const u = say('来週あたりで調整しましょうか', 0);
    const r = cs.upsertMemoItem({
      field: 'nextActions',
      text: '日程調整',
      status: 'hypothesis',
      evidenceUtteranceIds: [u.id],
      meta: { due: '来週' },
    });
    expect(r.item!.meta.dueAgreed).toBe(false);
    expect(r.warnings).toContain('due_not_agreed');
  });

  it('resolving a question requires evidence and removes it from unresolved', () => {
    const { cs, say } = setup();
    const q = say('権利は誰に帰属しますか？', 0);
    const a = say('契約書で確認してお伝えします', 3000, 'SELF');
    const m = cs.upsertMemoItem({ field: 'openQuestions', text: '権利帰属', status: 'fact', evidenceUtteranceIds: [q.id] });
    expect(cs.resolveMemoItem(m.item!.itemId, [])).toBe(false);
    expect(cs.resolveMemoItem(m.item!.itemId, [a.id])).toBe(true);
    expect(cs.unresolvedQuestions()).toHaveLength(0);
  });
});
