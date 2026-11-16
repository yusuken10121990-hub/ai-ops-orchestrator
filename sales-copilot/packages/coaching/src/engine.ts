import type { AdviceLlmOutput, AdviceWarning } from '@sales-copilot/contracts';
import { AdviceLlmError, makeAbortError } from './errors';
import { buildAdvicePrompt, promptVersion } from './prompt';
import { validateAdvice, type BlockCategory, type ValidationRule } from './validate';
import type { AdviceContext, AdviceErrorKind, AdviceLlm, AdviceResult } from './types';

export interface AdviceEngineOptions {
  llm: AdviceLlm;
  /** 不正JSON・検証不合格・通信断のときの再試行回数（既定 1）。無限には繰り返さない。 */
  maxRetries?: number;
  /** 1回の呼び出しの上限（既定 8000ms = SPEC §8-3 の初期目安）。 */
  timeoutMs?: number;
  /** 出力トークン上限（既定 1024）。 */
  maxOutputTokens?: number;
}

export interface AdviceEngine {
  generate(ctx: AdviceContext, signal: AbortSignal): Promise<AdviceResult>;
  promptVersion: string;
}

/** 再試行してよい失敗。429/認証/未設定は即座に縮退（再試行で悪化させない）。timeout は会話が先へ進むので再試行しない。 */
const RETRYABLE: ReadonlySet<AdviceErrorKind | 'schema' | 'blocked'> = new Set(['invalid_json', 'network', 'unknown', 'schema', 'blocked']);

const HOLD_REASON: Record<AdviceErrorKind | 'schema' | 'blocked_style', string> = {
  not_configured: '助言APIが未設定です。設定画面でキーを登録するか、OFFLINEテストで確認できます',
  auth_failed: '助言APIの認証に失敗しました。設定画面でキーを確認してください',
  rate_limited: '助言APIが混み合っています。少し待つと自動で再開します',
  timeout: '助言が時間内に作れませんでした。次の発言で自動で作り直します',
  aborted: '助言の生成を中止しました',
  invalid_json: '助言の形式が不正だったため表示しません。次の発言で作り直します',
  network: '助言APIに接続できません。ネットワークを確認してください',
  unknown: '助言の生成に失敗しました。次の発言で作り直します',
  schema: '助言の形式が不正だったため表示しません。次の発言で作り直します',
  blocked_style: '話し方の決まりに合わない案だったため表示しません。今は相手の話を聞いてください',
};

/** API障害・形式不正・話し方違反のときの安全カード（何も約束しない）。 */
export function holdOutput(reason: string): AdviceLlmOutput {
  return {
    action: 'hold',
    kind: 'listen',
    headline: '今は相手の話を聞く',
    say: null,
    avoid: null,
    briefReason: reason.slice(0, 80),
    evidenceUtteranceIds: [],
    approvedFactIds: [],
    missingItems: [],
    evidenceLevel: 'insufficient',
    nextStepType: 'none',
  };
}

/** 未確認の数値・保証を含む案を止めたときの安全カード（SPEC §12「確認してお伝えする」）。 */
export function confirmLaterOutput(): AdviceLlmOutput {
  return {
    action: 'show',
    kind: 'clarify',
    headline: '条件は確認してから答える',
    say: 'その点は確認して、正確にお伝えします。',
    avoid: '未確認の金額・期間・可否を言い切る',
    briefReason: '根拠のない数値・保証を含む案を表示前に止めました',
    evidenceUtteranceIds: [],
    approvedFactIds: [],
    missingItems: [],
    evidenceLevel: 'insufficient',
    nextStepType: 'clarify',
  };
}

function parseJsonText(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1]!;
  return JSON.parse(t);
}

function addUsage(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

type AttemptFailure =
  | { type: 'error'; kind: AdviceErrorKind }
  | { type: 'schema' }
  | { type: 'blocked'; category: BlockCategory; rules: ValidationRule[] };

export function createAdviceEngine(opts: AdviceEngineOptions): AdviceEngine {
  const maxRetries = Math.max(0, Math.min(opts.maxRetries ?? 1, 3));
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxOutputTokens = opts.maxOutputTokens ?? 1024;
  const version = promptVersion();

  async function callOnce(
    req: { system: string; user: string; jsonSchema: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<{ text: string; usage: { inputTokens: number | null; outputTokens: number | null }; model: string }> {
    const inner = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => inner.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          inner.abort();
          reject(new AdviceLlmError('timeout', 'advice generation timed out'));
        }, timeoutMs);
      });
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(makeAbortError(signal));
        signal.addEventListener('abort', () => reject(makeAbortError(signal)), { once: true });
      });
      const call = opts.llm.complete({ ...req, maxOutputTokens, signal: inner.signal });
      // LLM 実装が signal を無視しても、中止・期限は必ず効かせる
      call.catch(() => undefined);
      aborted.catch(() => undefined);
      timeout.catch(() => undefined);
      return await Promise.race([call, timeout, aborted]);
    } catch (e) {
      if (signal.aborted) throw makeAbortError(signal);
      if (timedOut) throw new AdviceLlmError('timeout', 'advice generation timed out');
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async function generate(ctx: AdviceContext, signal: AbortSignal): Promise<AdviceResult> {
    if (signal.aborted) throw makeAbortError(signal);
    const prompt = buildAdvicePrompt(ctx);
    let usage = { inputTokens: null as number | null, outputTokens: null as number | null };
    let model: string | null = null;
    let attempts = 0;
    let lastFailure: AttemptFailure | null = null;
    const rulesSeen = new Set<string>();
    let retryNote = '';

    for (let i = 0; i <= maxRetries; i++) {
      attempts++;
      let text: string;
      try {
        const res = await callOnce({ system: prompt.system, user: prompt.user + retryNote, jsonSchema: prompt.jsonSchema }, signal);
        usage = {
          inputTokens: addUsage(usage.inputTokens, res.usage.inputTokens),
          outputTokens: addUsage(usage.outputTokens, res.usage.outputTokens),
        };
        model = res.model;
        text = res.text;
      } catch (e) {
        if (signal.aborted) throw makeAbortError(signal);
        const kind: AdviceErrorKind = e instanceof AdviceLlmError ? e.kind : 'unknown';
        // 外部 signal が中止されていない aborted は、プロバイダー側の中断として unknown 扱い
        lastFailure = { type: 'error', kind: kind === 'aborted' ? 'unknown' : kind };
        if (!RETRYABLE.has(lastFailure.kind)) break;
        continue;
      }

      let raw: unknown;
      try {
        raw = parseJsonText(text);
      } catch {
        lastFailure = { type: 'error', kind: 'invalid_json' };
        rulesSeen.add('invalid_json');
        retryNote =
          '\n\n<retry_note>\n前回の出力は JSON として解析できませんでした。スキーマのオブジェクト1つだけを出力してください。\n</retry_note>';
        continue;
      }

      const v = validateAdvice(raw, ctx);
      for (const iss of v.issues) rulesSeen.add(iss.rule);
      if (v.verdict === 'blocked') {
        lastFailure =
          v.blockCategory === 'schema'
            ? { type: 'schema' }
            : { type: 'blocked', category: v.blockCategory ?? 'style', rules: v.issues.filter((x) => x.severity === 'block').map((x) => x.rule) };
        const codes = v.issues.filter((x) => x.severity === 'block').map((x) => x.rule).join(', ');
        retryNote = `\n\n<retry_note>\n前回の出力は表示前検証で不合格でした（理由コード: ${codes}）。スキーマと上限を守り、承認済み条件や顧客の発言に無い数値・保証・無料・可否の言い切りを含めずに出力し直してください。\n</retry_note>`;
        continue;
      }
      return {
        output: v.output,
        warnings: v.warnings,
        usage,
        outcome: v.verdict === 'repaired' ? 'repaired' : 'ok',
        promptVersion: version,
        validationRules: [...rulesSeen],
        attempts,
        model,
      };
    }

    // 有限回で打ち切り → 安全カード
    let output: AdviceLlmOutput;
    let fallbackReason: string;
    const warnings: AdviceWarning[] = [];
    if (!lastFailure) {
      output = holdOutput(HOLD_REASON.unknown);
      fallbackReason = 'unknown';
    } else if (lastFailure.type === 'error') {
      output = holdOutput(HOLD_REASON[lastFailure.kind]);
      fallbackReason = lastFailure.kind;
    } else if (lastFailure.type === 'schema') {
      output = holdOutput(HOLD_REASON.schema);
      fallbackReason = 'schema_invalid';
    } else if (lastFailure.category === 'unverified_promise') {
      output = confirmLaterOutput();
      fallbackReason = `validation_blocked:${lastFailure.rules.join('+')}`;
      warnings.push({ code: 'unverified_promise', message: '根拠のない数値・保証を含む案を止め、確認を約束する案に切り替えました' });
    } else {
      output = holdOutput(HOLD_REASON.blocked_style);
      fallbackReason = `validation_blocked:${lastFailure.rules.join('+')}`;
    }
    return {
      output,
      warnings,
      usage,
      outcome: 'fallback',
      fallbackReason,
      promptVersion: version,
      validationRules: [...rulesSeen],
      attempts,
      model,
    };
  }

  return { generate, promptVersion: version };
}
