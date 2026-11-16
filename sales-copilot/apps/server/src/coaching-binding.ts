import { createAdviceEngine, extractMemoCandidates, RuleBasedOfflineLlm, shouldTriggerAuto } from '@sales-copilot/coaching';
import type { CoachingPort } from './coaching-port';

/** @sales-copilot/coaching の実体をサーバーのポートへ結線する。 */
export const coachingBinding: CoachingPort = {
  createEngine(llm, opts) {
    return createAdviceEngine({ llm, maxRetries: opts.maxRetries, timeoutMs: opts.timeoutMs });
  },
  createOfflineLlm() {
    return new RuleBasedOfflineLlm();
  },
  shouldTriggerAuto({ utterance, state, approvedFacts }) {
    const snap = state.snapshot();
    const win = snap.window.map((u) => ({ utteranceId: u.utteranceId, source: u.source, text: u.text, flags: [...u.flags] }));
    return shouldTriggerAuto({
      utterance: { utteranceId: utterance.utteranceId, source: utterance.source, text: utterance.text, flags: [...utterance.flags] },
      window: win,
      memo: snap,
      approvedFacts,
    }).trigger;
  },
  extractMemoCandidates(utterance, state) {
    return extractMemoCandidates(
      { utteranceId: utterance.utteranceId, source: utterance.source, text: utterance.text, flags: [...utterance.flags] },
      state,
    );
  },
};
