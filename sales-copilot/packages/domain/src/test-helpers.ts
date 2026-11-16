import type { AdviceLlmOutput } from '@sales-copilot/contracts';
import type { SttResultInput } from './transcript-store';

export function stt(over: Partial<SttResultInput> & { text: string; startMs: number }): SttResultInput {
  return {
    source: 'REMOTE',
    streamGeneration: 0,
    isFinal: false,
    speechFinal: false,
    endMs: over.startMs + 800,
    ...over,
  };
}

export function llmOut(over: Partial<AdviceLlmOutput> = {}): AdviceLlmOutput {
  return {
    action: 'show',
    kind: 'answer',
    headline: '質問に答える',
    say: '対応可否は条件を確認してからお伝えします。',
    avoid: '可否を言い切らない',
    briefReason: '相手の質問',
    evidenceUtteranceIds: [],
    approvedFactIds: [],
    missingItems: [],
    evidenceLevel: 'tentative',
    nextStepType: 'none',
    ...over,
  };
}
