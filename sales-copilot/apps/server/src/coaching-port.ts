import type { AdviceLlmOutput, AdviceTrigger, AdviceWarning, ApprovedFact, AudioSource } from '@sales-copilot/contracts';
import type { ConversationState, ConversationUtterance, MemoItemInput } from '@sales-copilot/domain';
import type { AdviceLlm } from '@sales-copilot/providers';

/**
 * サーバーが助言生成（@sales-copilot/coaching）に求める最小の口。
 * 実体の結線は coaching-binding.ts、テストでは差し替え可能。
 */
export interface AdviceContextInput {
  sessionId: string;
  contextRevision: number;
  trigger: AdviceTrigger;
  purpose: string;
  window: Array<{ utteranceId: string; source: AudioSource; text: string; flags?: string[] }>;
  memo: ReturnType<ConversationState['snapshot']>;
  approvedFacts: ApprovedFact[];
  degraded: boolean;
  /** 営業補正ルール（承認済み・有効）。セッション開始時点で固定。 */
  coachingRules?: Array<{ ruleId: string; text: string; scope: string }>;
}

export interface AdviceResultLike {
  output: AdviceLlmOutput;
  warnings: AdviceWarning[];
  usage: { inputTokens: number | null; outputTokens: number | null };
  outcome: 'ok' | 'repaired' | 'fallback';
  fallbackReason?: string;
  promptVersion: string;
  attempts?: number;
}

export interface AdviceEngineLike {
  readonly promptVersion: string;
  generate(ctx: AdviceContextInput, signal: AbortSignal): Promise<AdviceResultLike>;
}

export interface CoachingPort {
  createEngine(llm: AdviceLlm, opts: { maxRetries: number; timeoutMs: number; maxOutputTokens?: number }): AdviceEngineLike;
  /** OFFLINE 用（外部送信なし・ルールベースと明示）。 */
  createOfflineLlm(): AdviceLlm;
  /** 確定発話で自動助言を要求すべきか。 */
  shouldTriggerAuto(args: {
    utterance: ConversationUtterance;
    state: ConversationState;
    approvedFacts: readonly ApprovedFact[];
  }): boolean;
  /** 確定発話から構造化メモ候補を抽出（根拠ID付き）。 */
  extractMemoCandidates(utterance: ConversationUtterance, state: ConversationState): MemoItemInput[];
}
