/**
 * 実 API による会話品質の評価（任意実行・CI では使わない）。
 *
 *   LIVE_EVAL=1 ANTHROPIC_API_KEY=... pnpm --filter @sales-copilot/coaching eval:live
 *
 * - ANTHROPIC_API_KEY と LIVE_EVAL=1 の両方が無ければ何もせず終了する（SPEC §15: キーを置いただけで有料実行しない）
 * - 呼び出しは最大 LIVE_EVAL_MAX_CALLS 回（既定 20、上限 20）。再試行も1回として数える
 * - モデルは ADVICE_MODEL（既定 claude-opus-5-5）
 * - 会話本文やキーはログに出さない（フィクスチャID・判定・ルールコードのみ）
 */
import Anthropic from '@anthropic-ai/sdk';
import { checkJudgement, loadAllConversationFixtures } from '@sales-copilot/test-fixtures';
import { AdviceLlmError, createAdviceEngine, type AdviceLlm, type AdviceLlmRequest, type AdviceLlmResponse } from '../src/index';
import { contextFromFixture } from '../src/testing';

const HARD_CAP = 20;

if (process.env.LIVE_EVAL !== '1' || !process.env.ANTHROPIC_API_KEY) {
  console.log('eval:live skipped (set LIVE_EVAL=1 and ANTHROPIC_API_KEY to run against the real API)');
  process.exit(0);
}

const maxCalls = Math.min(HARD_CAP, Math.max(1, Number(process.env.LIVE_EVAL_MAX_CALLS ?? HARD_CAP) || HARD_CAP));
const model = process.env.ADVICE_MODEL ?? 'claude-opus-5-5';
const client = new Anthropic({ maxRetries: 0 });
let calls = 0;

/** 評価用の最小アダプター（本番のアダプターは packages/providers が持つ）。 */
class CappedClaudeAdviceLlm implements AdviceLlm {
  async complete(req: AdviceLlmRequest): Promise<AdviceLlmResponse> {
    if (calls >= maxCalls) throw new AdviceLlmError('not_configured', 'live eval call cap reached');
    calls++;
    try {
      const msg = await client.beta.messages.create(
        {
          model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          output_config: { effort: 'low', format: { type: 'json_schema', schema: req.jsonSchema } },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        },
        { signal: req.signal },
      );
      if (msg.stop_reason === 'refusal') throw new AdviceLlmError('unknown', 'model refused');
      if (msg.stop_reason === 'max_tokens') throw new AdviceLlmError('invalid_json', 'output truncated');
      const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return { text, usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens }, model: msg.model };
    } catch (e) {
      if (e instanceof AdviceLlmError) throw e;
      if (e instanceof Anthropic.APIUserAbortError) throw new AdviceLlmError('aborted', 'aborted');
      if (e instanceof Anthropic.APIConnectionTimeoutError) throw new AdviceLlmError('timeout', 'timeout');
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
        throw new AdviceLlmError('auth_failed', 'authentication failed');
      if (e instanceof Anthropic.RateLimitError) throw new AdviceLlmError('rate_limited', 'rate limited');
      if (e instanceof Anthropic.APIConnectionError) throw new AdviceLlmError('network', 'connection error');
      if (e instanceof Anthropic.APIError) throw new AdviceLlmError('unknown', `api error ${String(e.status)}`);
      throw new AdviceLlmError('unknown', 'unexpected error');
    }
  }
}

const engine = createAdviceEngine({ llm: new CappedClaudeAdviceLlm(), maxRetries: 1, timeoutMs: 20_000 });
let pass = 0;
let fail = 0;
let tokensIn = 0;
let tokensOut = 0;

for (const f of loadAllConversationFixtures()) {
  if (calls >= maxCalls) {
    console.log(`call cap ${maxCalls} reached; remaining fixtures skipped`);
    break;
  }
  const t0 = Date.now();
  const res = await engine.generate(contextFromFixture(f), AbortSignal.timeout(30_000));
  tokensIn += res.usage.inputTokens ?? 0;
  tokensOut += res.usage.outputTokens ?? 0;
  const safety = checkJudgement(res.output, f.expect, 'safety');
  const full = checkJudgement(res.output, f.expect, 'full');
  const ok = safety.ok && res.outcome !== 'fallback';
  if (ok) pass++;
  else fail++;
  console.log(
    JSON.stringify({
      fixture: f.id,
      outcome: res.outcome,
      fallbackReason: res.fallbackReason ?? null,
      rules: res.validationRules,
      kind: res.output.kind,
      nextStepType: res.output.nextStepType,
      safety: safety.ok ? 'pass' : safety.failures,
      quality: full.ok ? 'pass' : full.failures,
      ms: Date.now() - t0,
      attempts: res.attempts,
    }),
  );
}

console.log(JSON.stringify({ model, pass, fail, calls, maxCalls, inputTokens: tokensIn, outputTokens: tokensOut }));
process.exit(fail > 0 ? 1 : 0);
