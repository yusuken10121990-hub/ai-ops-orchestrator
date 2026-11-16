import { describe, expect, it } from 'vitest';
import type { AdviceCard } from '@sales-copilot/contracts';
import { makeCard } from './test-cards';
import { copilotReducer, initialCopilotState, selectCardView, selectTranscript, type CopilotState } from './state';


const status = {
  type: 'status',
  sessionId: 's1',
  lifecycle: 'capturing',
  mode: 'LIVE',
  externalSending: true,
  storage: 'memory_only',
  pipelines: {
    capture: { SELF: { state: 'active', reason: null, since: 0 }, REMOTE: { state: 'active', reason: null, since: 0 } },
    stt: { state: 'active', reason: null, since: 0 },
    advice: { state: 'waiting', reason: 'cooldown', since: 0 },
  },
  at: 1,
};

function apply(state: CopilotState, ...messages: unknown[]): CopilotState {
  return messages.reduce<CopilotState>((s, m) => copilotReducer(s, { type: 'server', message: m }), state);
}
const card = (c: AdviceCard) => ({ type: 'advice.card', card: c });

describe('copilotReducer: 原子的なカード差し替え', () => {
  it('完全な advice.card だけで差し替え、不完全なものは捨てる（途中文を描画しない）', () => {
    let s = apply(initialCopilotState, status, card(makeCard()));
    expect(selectCardView(s, 2000).card?.adviceId).toBe('a1');
    s = apply(s, { type: 'advice.card', card: { ...makeCard({ adviceId: 'a2', createdAt: 2000 }), say: undefined } });
    s = apply(s, { type: 'advice.card', card: { adviceId: 'a3', say: '途中まで' } });
    expect(selectCardView(s, 2000).card?.adviceId).toBe('a1');
    expect(s.rejected).toBe(2);
  });

  it('返却順が逆転しても古いカードで新しい表示を上書きしない', () => {
    const s = apply(
      initialCopilotState,
      status,
      card(makeCard({ adviceId: 'new', createdAt: 5000, contextRevision: 4 })),
      card(makeCard({ adviceId: 'old', createdAt: 3000, contextRevision: 2 })),
    );
    expect(selectCardView(s, 5100).card?.adviceId).toBe('new');
  });

  it('別セッションのカードは表示しない', () => {
    const s = apply(initialCopilotState, status, card(makeCard({ sessionId: 'other' })));
    expect(selectCardView(s, 0).mode).toBe('empty');
  });

  it('advice.invalidated で無効表示、カードより先に届いた無効化も尊重', () => {
    let s = apply(initialCopilotState, status, card(makeCard()));
    s = apply(s, { type: 'advice.invalidated', adviceId: 'a1', reason: 'transcript_revised' });
    const v = selectCardView(s, 2000);
    expect(v.displayStatus).toBe('invalidated');
    expect(v.invalidReason).toBe('transcript_revised');

    let t = apply(initialCopilotState, status, card(makeCard({ adviceId: 'x', createdAt: 100 })));
    t = apply(t, { type: 'advice.invalidated', adviceId: 'late', reason: 'context_changed' });
    t = apply(t, card(makeCard({ adviceId: 'late', createdAt: 900 })));
    expect(selectCardView(t, 500).card?.adviceId).toBe('x');
  });

  it('期限切れは「参考」＋警告', () => {
    const s = apply(initialCopilotState, status, card(makeCard({ expiresAt: 3000 })));
    const v = selectCardView(s, 3000);
    expect(v.displayStatus).toBe('reference');
    expect(v.warnings.map((w) => w.code)).toContain('stale');
  });
});

describe('表示固定', () => {
  it('固定中は固定カードを残し、新しいカードが来たら「参考」＋お知らせ', () => {
    let s = apply(initialCopilotState, status, card(makeCard()));
    s = copilotReducer(s, { type: 'pin', adviceId: 'a1' });
    s = apply(s, card(makeCard({ adviceId: 'a2', createdAt: 2000, headline: '新しい' })));
    const v = selectCardView(s, 2100);
    expect(v.mode).toBe('pinned');
    expect(v.card?.adviceId).toBe('a1');
    expect(v.hasNewerCard).toBe(true);
    expect(v.displayStatus).toBe('reference');
    expect(v.warnings.map((w) => w.code)).toContain('pinned_stale');
    s = copilotReducer(s, { type: 'unpin' });
    expect(selectCardView(s, 2100).card?.adviceId).toBe('a2');
  });

  it('固定中のカードが無効化されたら現行推奨として扱わない', () => {
    let s = apply(initialCopilotState, status, card(makeCard()));
    s = copilotReducer(s, { type: 'pin', adviceId: 'a1' });
    s = apply(s, { type: 'advice.invalidated', adviceId: 'a1', reason: 'fact_revoked' });
    const v = selectCardView(s, 1500);
    expect(v.displayStatus).toBe('invalidated');
    expect(v.warnings.map((w) => w.code)).toContain('pinned_stale');
  });

  it('無効カードは固定できない', () => {
    let s = apply(initialCopilotState, status, card(makeCard({ status: 'invalidated' })));
    s = copilotReducer(s, { type: 'pin', adviceId: 'a1' });
    expect(s.pinnedId).toBeNull();
  });

  it('サーバーの pin.state（参考扱い）を反映', () => {
    let s = apply(initialCopilotState, status, card(makeCard()));
    s = copilotReducer(s, { type: 'pin', adviceId: 'a1' });
    s = apply(s, {
      type: 'card.pin.state',
      pinnedAdviceId: 'a1',
      displayStatus: 'reference',
      warnings: [{ code: 'topic_changed', message: '話題が変わりました' }],
      hasNewerCard: false,
    });
    const v = selectCardView(s, 1500);
    expect(v.displayStatus).toBe('reference');
    expect(v.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['topic_changed', 'pinned_stale']));
  });
});

describe('文字起こし', () => {
  const seg = (over: object) => ({
    type: 'transcript.segment',
    segmentId: 'g1',
    utteranceId: 'u1',
    source: 'REMOTE',
    streamGeneration: 0,
    text: 'できます',
    isFinal: false,
    speechFinal: false,
    startMs: 0,
    endMs: 500,
    revision: 0,
    ...over,
  });
  it('同じ segment の interim は更新扱い（重複しない）、古い revision は無視', () => {
    let s = apply(initialCopilotState, status, seg({}), seg({ text: 'できますか？', revision: 2, isFinal: true }));
    s = apply(s, seg({ text: 'できます', revision: 1 }));
    const t = selectTranscript(s);
    expect(t).toHaveLength(1);
    expect(t[0]!.text).toBe('できますか？');
  });
});
