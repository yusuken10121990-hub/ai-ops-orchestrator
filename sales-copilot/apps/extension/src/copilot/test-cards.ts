import type { AdviceCard } from '@sales-copilot/contracts';

/** テスト用の検証済みカード。 */
export function makeCard(over: Partial<AdviceCard> = {}): AdviceCard {
  return {
    action: 'show',
    kind: 'answer',
    headline: '費用の前提を確認',
    say: '月額の前提を確認してからお答えしてもよろしいでしょうか。',
    avoid: '金額の断定',
    briefReason: '価格が未承認',
    evidenceUtteranceIds: ['u1'],
    approvedFactIds: [],
    missingItems: ['月額の承認'],
    evidenceLevel: 'supported',
    nextStepType: 'clarify',
    adviceId: 'a1',
    sessionId: 's1',
    contextRevision: 1,
    promptVersion: 'p1',
    createdAt: 1000,
    expiresAt: 9000,
    trigger: 'auto',
    status: 'current',
    warnings: [],
    ...over,
  };
}
