import Anthropic from '@anthropic-ai/sdk';
import { AdviceLlmError, type AdviceLlm, type AdviceLlmErrorKind, type AdviceLlmRequest, type AdviceLlmResponse } from './llm-port';

export type AnthropicEffort = 'low' | 'medium' | 'high';

export interface AnthropicAdviceLlmOptions {
  /** 空・未設定なら complete() は not_configured を投げ、外部送信しない。 */
  apiKey: string | undefined | null;
  /** モデルIDは環境変数 ANTHROPIC_MODEL から渡す（ハードコードしない）。 */
  model: string;
  /**
   * 構造化出力の短い応答なので低めを既定にする（遅延優先・SPEC §8-3）。
   * thinking は送らない（モデル既定に任せる。disabled はモデルによって 400 になるため）。
   */
  effort?: AnthropicEffort | null;
  /** 1回のリクエストのタイムアウト（ms）。リトライは呼び出し側（AdviceEngine）が有限回で行う。 */
  timeoutMs?: number;
  /** テスト用: SDK の fetch 差し替え。 */
  fetch?: typeof fetch;
  /** テスト用: baseURL 差し替え。 */
  baseURL?: string;
}

/**
 * Claude Messages API + 構造化出力（output_config.format: json_schema）による AdviceLlm 実装。
 * - 途中テキストはストリーミングしない（未検証の途中文を表示しない: SPEC §12）
 * - SDK 内部リトライは 0（タイムアウト × 再試行で遅延が膨らむのを防ぐ。再試行は AdviceEngine が管理）
 * - エラーは AdviceLlmError の kind へ変換。メッセージにキーや本文を含めない
 */
export class AnthropicAdviceLlm implements AdviceLlm {
  readonly model: string;
  private readonly client: Anthropic | null;
  private readonly effort: AnthropicEffort | null;
  private readonly timeoutMs: number;

  constructor(opts: AnthropicAdviceLlmOptions) {
    this.model = opts.model;
    this.effort = opts.effort === undefined ? 'low' : opts.effort;
    this.timeoutMs = opts.timeoutMs ?? 6000;
    const key = (opts.apiKey ?? '').trim();
    this.client =
      key.length > 0
        ? new Anthropic({
            apiKey: key,
            maxRetries: 0,
            timeout: this.timeoutMs,
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
            ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
          })
        : null;
  }

  get configured(): boolean {
    return this.client !== null;
  }

  async complete(req: AdviceLlmRequest): Promise<AdviceLlmResponse> {
    if (!this.client) throw new AdviceLlmError('not_configured', 'ANTHROPIC_API_KEY is not set');
    if (!this.model) throw new AdviceLlmError('not_configured', 'ANTHROPIC_MODEL is not set');
    if (req.signal.aborted) throw new AdviceLlmError('aborted', 'request aborted before start');

    let res: Anthropic.Message;
    try {
      res = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          output_config: {
            format: { type: 'json_schema', schema: req.jsonSchema },
            ...(this.effort ? { effort: this.effort } : {}),
          },
        },
        { signal: req.signal, timeout: this.timeoutMs, maxRetries: 0 },
      );
    } catch (e) {
      throw mapAnthropicError(e, req.signal);
    }

    const usage = {
      inputTokens: typeof res.usage?.input_tokens === 'number' ? res.usage.input_tokens : null,
      outputTokens: typeof res.usage?.output_tokens === 'number' ? res.usage.output_tokens : null,
    };
    if (res.stop_reason === 'refusal') {
      throw withUsage(new AdviceLlmError('unknown', 'model declined the request (refusal)'), usage);
    }
    if (res.stop_reason === 'max_tokens') {
      // 途中で切れた JSON は不正 JSON として扱う（表示しない）
      throw withUsage(new AdviceLlmError('invalid_json', 'output truncated at max_tokens'), usage);
    }
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (text.trim().length === 0) {
      throw withUsage(new AdviceLlmError('invalid_json', 'empty response'), usage);
    }
    return { text, usage, model: res.model ?? this.model };
  }
}

/** エラーにも実 usage を添える（失敗した呼び出しの課金も集計できるように）。 */
export interface AdviceLlmErrorWithUsage extends AdviceLlmError {
  usage?: { inputTokens: number | null; outputTokens: number | null };
}

function withUsage(e: AdviceLlmError, usage: { inputTokens: number | null; outputTokens: number | null }): AdviceLlmError {
  (e as AdviceLlmErrorWithUsage).usage = usage;
  return e;
}

/** SDK の例外 → AdviceLlmError。メッセージは固定文＋ステータスのみ（本文・キーを含めない）。 */
export function mapAnthropicError(e: unknown, signal?: AbortSignal): AdviceLlmError {
  if (e instanceof AdviceLlmError) return e;
  const mk = (kind: AdviceLlmErrorKind, msg: string) => new AdviceLlmError(kind, msg);
  // 具体的なクラスから順に判定する（APIConnectionTimeoutError ⊂ APIConnectionError ⊂ APIError）
  if (e instanceof Anthropic.APIUserAbortError || (signal?.aborted && isAbortLike(e))) {
    return mk('aborted', 'request aborted');
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError) return mk('timeout', 'request timed out');
  if (e instanceof Anthropic.APIConnectionError) return mk('network', 'connection error');
  if (e instanceof Anthropic.AuthenticationError) return mk('auth_failed', 'authentication failed (401)');
  if (e instanceof Anthropic.PermissionDeniedError) return mk('auth_failed', 'permission denied (403)');
  if (e instanceof Anthropic.RateLimitError) return mk('rate_limited', 'rate limited (429)');
  if (e instanceof Anthropic.OverloadedError) return mk('rate_limited', 'overloaded (529)');
  if (e instanceof Anthropic.RequestTimeoutError || e instanceof Anthropic.GatewayTimeoutError) {
    return mk('timeout', `upstream timeout (${(e as { status?: number }).status ?? 'n/a'})`);
  }
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === 'number' ? e.status : 'n/a';
    return mk('unknown', `api error (${status})`);
  }
  if (isAbortLike(e)) return mk('aborted', 'request aborted');
  return mk('unknown', 'unexpected error');
}

function isAbortLike(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}
