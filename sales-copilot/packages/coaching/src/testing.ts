/** テスト・OFFLINE 用の LLM 実装とフィクスチャ変換（`@sales-copilot/coaching/testing`）。 */
import type { ConversationFixture } from '@sales-copilot/test-fixtures';
import { fixtureMemoSnapshot } from '@sales-copilot/test-fixtures';
import type { AdviceContext, AdviceMemoSnapshot } from './types';

export { FakeAdviceLlm, type FakeStep, type FakeAdviceLlmOptions } from './fake-llm';
export { RuleBasedOfflineLlm, OFFLINE_MODEL_ID } from './offline-llm';

/** 架空会話フィクスチャ → AdviceContext。 */
export function contextFromFixture(f: ConversationFixture, over: Partial<AdviceContext> = {}): AdviceContext {
  return {
    sessionId: `fixture-${f.id}`,
    contextRevision: 1,
    trigger: f.trigger,
    purpose: f.purpose,
    window: f.window.map((u) => ({ ...u })),
    memo: fixtureMemoSnapshot(f) as unknown as AdviceMemoSnapshot,
    approvedFacts: f.approvedFacts.map((x) => ({ ...x })),
    degraded: f.degraded ?? false,
    ...over,
  };
}
