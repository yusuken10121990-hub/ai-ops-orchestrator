import { describe, expect, it } from 'vitest';
import { AnthropicAdviceLlm } from './anthropic-advice-llm';
import { AdviceLlmError } from './llm-port';

const KEY = 'sk-ant-test-DO-NOT-LEAK-0123456789';
const SCHEMA = { type: 'object', properties: { action: { type: 'string' } }, required: ['action'], additionalProperties: false };

type Captured = { url: string; init: RequestInit; body: any };

function mockFetch(respond: (c: Captured) => Response | Promise<Response>, captured: Captured[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const c: Captured = { url: String(input), init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : null };
    captured.push(c);
    return respond(c);
  }) as typeof fetch;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const okMessage = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: '{"action":"none"}' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 812, output_tokens: 41 },
};

function req(signal = new AbortController().signal) {
  return { system: 'SYS', user: 'USER', jsonSchema: SCHEMA, maxOutputTokens: 600, signal };
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    expect(e).toBeInstanceOf(AdviceLlmError);
    expect(String((e as Error).message)).not.toContain(KEY);
    return (e as AdviceLlmError).kind;
  }
}

describe('AnthropicAdviceLlm', () => {
  it('sends structured-output request (json_schema), model from config, no streaming; returns text + real usage', async () => {
    const cap: Captured[] = [];
    const llm = new AnthropicAdviceLlm({ apiKey: KEY, model: 'claude-haiku-5-5', fetch: mockFetch(() => json(200, okMessage), cap) });
    const res = await llm.complete(req());
    expect(res).toEqual({ text: '{"action":"none"}', usage: { inputTokens: 812, outputTokens: 41 }, model: 'claude-haiku-5-5' });
    expect(cap).toHaveLength(1);
    const body = cap[0]!.body;
    expect(cap[0]!.url).toMatch(/\/v1\/messages$/);
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBe(600);
    expect(body.system).toBe('SYS');
    expect(body.messages).toEqual([{ role: 'user', content: 'USER' }]);
    expect(body.output_config.format).toEqual({ type: 'json_schema', schema: SCHEMA });
    expect(body.output_config.effort).toBe('low');
    expect(body.stream).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('not configured → not_configured without any network call', async () => {
    const cap: Captured[] = [];
    const llm = new AnthropicAdviceLlm({ apiKey: '', model: 'claude-haiku-5-5', fetch: mockFetch(() => json(200, okMessage), cap) });
    expect(llm.configured).toBe(false);
    expect(await kindOf(llm.complete(req()))).toBe('not_configured');
    expect(cap).toHaveLength(0);
  });

  it.each([
    [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'auth_failed'],
    [403, { type: 'error', error: { type: 'permission_error', message: 'nope' } }, 'auth_failed'],
    [429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'rate_limited'],
    [529, { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }, 'rate_limited'],
    [500, { type: 'error', error: { type: 'api_error', message: 'boom' } }, 'unknown'],
    [400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 'unknown'],
  ])('HTTP %i → %s (single attempt, no SDK retries)', async (status, body, kind) => {
    const cap: Captured[] = [];
    const llm = new AnthropicAdviceLlm({ apiKey: KEY, model: 'm', fetch: mockFetch(() => json(status, body, { 'retry-after': '0' }), cap) });
    expect(await kindOf(llm.complete(req()))).toBe(kind);
    expect(cap).toHaveLength(1);
  });

  it('network failure → network', async () => {
    const llm = new AnthropicAdviceLlm({
      apiKey: KEY,
      model: 'm',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    expect(await kindOf(llm.complete(req()))).toBe('network');
  });

  it('timeout → timeout', async () => {
    const llm = new AnthropicAdviceLlm({
      apiKey: KEY,
      model: 'm',
      timeoutMs: 50,
      fetch: ((_: unknown, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })) as typeof fetch,
    });
    expect(await kindOf(llm.complete(req()))).toBe('timeout');
  });

  it('caller abort → aborted', async () => {
    const ac = new AbortController();
    const llm = new AnthropicAdviceLlm({
      apiKey: KEY,
      model: 'm',
      fetch: ((_: unknown, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        })) as typeof fetch,
    });
    const p = llm.complete(req(ac.signal));
    setTimeout(() => ac.abort(), 10);
    expect(await kindOf(p)).toBe('aborted');
  });

  it('already-aborted signal → aborted without a network call', async () => {
    const cap: Captured[] = [];
    const ac = new AbortController();
    ac.abort();
    const llm = new AnthropicAdviceLlm({ apiKey: KEY, model: 'm', fetch: mockFetch(() => json(200, okMessage), cap) });
    expect(await kindOf(llm.complete(req(ac.signal)))).toBe('aborted');
    expect(cap).toHaveLength(0);
  });

  it('max_tokens truncation → invalid_json (never shows partial output) and keeps usage', async () => {
    const llm = new AnthropicAdviceLlm({
      apiKey: KEY,
      model: 'm',
      fetch: mockFetch(() => json(200, { ...okMessage, content: [{ type: 'text', text: '{"action":"sh' }], stop_reason: 'max_tokens' })),
    });
    try {
      await llm.complete(req());
      expect.unreachable();
    } catch (e) {
      expect((e as AdviceLlmError).kind).toBe('invalid_json');
      expect((e as { usage?: unknown }).usage).toEqual({ inputTokens: 812, outputTokens: 41 });
    }
  });

  it('refusal stop_reason → unknown', async () => {
    const llm = new AnthropicAdviceLlm({
      apiKey: KEY,
      model: 'm',
      fetch: mockFetch(() => json(200, { ...okMessage, content: [], stop_reason: 'refusal' })),
    });
    expect(await kindOf(llm.complete(req()))).toBe('unknown');
  });

  it('missing usage → null (not guessed)', async () => {
    const llm = new AnthropicAdviceLlm({
      apiKey: KEY,
      model: 'm',
      fetch: mockFetch(() => json(200, { ...okMessage, usage: {} })),
    });
    const r = await llm.complete(req());
    expect(r.usage).toEqual({ inputTokens: null, outputTokens: null });
  });
});
