import type { AdviceLlmOutput } from '@sales-copilot/contracts';
import { AdviceLlmError } from './errors';
import type { AdviceLlm, AdviceLlmRequest, AdviceLlmResponse } from './types';

/**
 * FakeAdviceLlm の1ステップ。
 * - string: そのまま text として返す（不正JSONの再現にも使う）
 * - { output }: JSON.stringify して返す
 * - { error }: そのエラーを投げる（AdviceLlmError で 429/認証/timeout 等を再現）
 * - { hang: true }: signal が中止されるまで応答しない（timeout/abort の再現）
 * - function: 要求を見て応答を決める
 * delayMs を付けるとその分待つ（signal 中止で aborted エラー）。
 */
export type FakeStep =
  | string
  | { output: AdviceLlmOutput | Record<string, unknown>; delayMs?: number; model?: string }
  | { text: string; delayMs?: number }
  | { error: Error; delayMs?: number }
  | { hang: true }
  | ((req: AdviceLlmRequest) => AdviceLlmResponse | Promise<AdviceLlmResponse>);

export interface FakeAdviceLlmOptions {
  /** 台本を使い切った後に最後のステップを繰り返すか（既定 true）。false なら unknown エラー。 */
  repeatLast?: boolean;
  usage?: { inputTokens: number | null; outputTokens: number | null };
}

/** 台本どおりに応答し、受け取った要求を記録するテスト用 LLM（サーバーテスト・OFFLINE 用）。 */
export class FakeAdviceLlm implements AdviceLlm {
  readonly requests: AdviceLlmRequest[] = [];
  private i = 0;
  private readonly repeatLast: boolean;
  private readonly usage: { inputTokens: number | null; outputTokens: number | null };

  constructor(
    private readonly script: FakeStep[],
    opts: FakeAdviceLlmOptions = {},
  ) {
    this.repeatLast = opts.repeatLast ?? true;
    this.usage = opts.usage ?? { inputTokens: 100, outputTokens: 50 };
  }

  get callCount(): number {
    return this.requests.length;
  }

  async complete(req: AdviceLlmRequest): Promise<AdviceLlmResponse> {
    this.requests.push(req);
    const step = this.i < this.script.length ? this.script[this.i] : this.repeatLast ? this.script[this.script.length - 1] : undefined;
    this.i++;
    if (step === undefined) throw new AdviceLlmError('unknown', 'FakeAdviceLlm: script exhausted');
    if (typeof step === 'function') return step(req);
    if (typeof step === 'string') return this.respond(step);
    if ('hang' in step) {
      return new Promise((_, reject) => {
        const fail = () => reject(new AdviceLlmError('aborted', 'aborted'));
        if (req.signal.aborted) fail();
        req.signal.addEventListener('abort', fail, { once: true });
      });
    }
    if (step.delayMs) await delay(step.delayMs, req.signal);
    if ('error' in step) throw step.error;
    if ('text' in step) return this.respond(step.text);
    return this.respond(JSON.stringify(step.output), step.model);
  }

  private respond(text: string, model = 'fake-advice-llm'): AdviceLlmResponse {
    return { text, usage: { ...this.usage }, model };
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AdviceLlmError('aborted', 'aborted'));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AdviceLlmError('aborted', 'aborted'));
      },
      { once: true },
    );
  });
}
