import { describe, expect, it } from 'vitest';
import { ApiClient } from './api';
import { normalizeServerUrl, sanitizeSettings } from './settings';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const fact = {
  factId: 'f1',
  category: 'price_monthly',
  value: '月額5万円',
  scope: '標準プラン',
  sourceNote: '料金表 v3',
  approvedAt: null,
  version: 1,
  status: 'unverified',
};

describe('ApiClient', () => {
  it('トークンは Authorization ヘッダーだけで送り、URL に載せない', async () => {
    const { f, calls } = fakeFetch(200, [fact]);
    const token = 't'.repeat(40);
    const r = await new ApiClient({ baseUrl: 'http://127.0.0.1:8787', token, fetchImpl: f }).listFacts();
    expect(r).toEqual({ ok: true, data: [fact] });
    expect(calls[0]!.url).toBe('http://127.0.0.1:8787/facts');
    expect(calls[0]!.url).not.toContain(token);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`);
  });

  it('{facts:[...]} 形式も受ける／形が違えば invalid_response（推測で埋めない）', async () => {
    expect((await new ApiClient({ baseUrl: 'http://127.0.0.1:1', token: null, fetchImpl: fakeFetch(200, { facts: [fact] }).f }).listFacts()).ok).toBe(true);
    const bad = await new ApiClient({ baseUrl: 'http://127.0.0.1:1', token: null, fetchImpl: fakeFetch(200, [{ value: 1 }]).f }).listFacts();
    expect(bad).toEqual({ ok: false, error: { kind: 'invalid_response' } });
  });

  it('401 は unauthorized、通信失敗は network', async () => {
    expect(await new ApiClient({ baseUrl: 'http://127.0.0.1:1', token: null, fetchImpl: fakeFetch(401, {}).f }).health()).toEqual({
      ok: false,
      error: { kind: 'unauthorized' },
    });
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await new ApiClient({ baseUrl: 'http://127.0.0.1:1', token: null, fetchImpl: down }).health()).toEqual({
      ok: false,
      error: { kind: 'network' },
    });
  });

  it('ペアリング失敗（ok:false）を本文から読む', async () => {
    const { f } = fakeFetch(400, { ok: false, error: 'expired_code' });
    const r = await new ApiClient({ baseUrl: 'http://127.0.0.1:1', token: null, fetchImpl: f }).pair({
      pairingCode: '123456',
      extensionId: 'a'.repeat(32),
      clientName: 'x',
    });
    expect(r).toEqual({ ok: true, data: { ok: false, error: 'expired_code' } });
  });
});

describe('settings', () => {
  it('サーバー URL はローカル http のみ', () => {
    expect(normalizeServerUrl('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
    expect(normalizeServerUrl('http://localhost:9000')).toBe('http://localhost:9000');
    expect(normalizeServerUrl('https://example.com')).toBeNull();
    expect(normalizeServerUrl('http://user:pw@127.0.0.1:1')).toBeNull();
  });
  it('壊れた保存値は既定へ', () => {
    const s = sanitizeSettings({ serverUrl: 'evil', frameMs: 9999, fontScale: 99, session: { token: 'short' } as never });
    expect(s.serverUrl).toBe('http://127.0.0.1:8787');
    expect(s.frameMs).toBe(250);
    expect(s.fontScale).toBe(1.6);
    expect(s.session).toBeNull();
  });
});
