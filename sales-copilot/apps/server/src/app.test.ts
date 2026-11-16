import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ApprovedFact } from '@sales-copilot/contracts';
import { buildApp, type AppHandle } from './app';
import { coachingBinding } from './coaching-binding';
import { assertBindAllowed } from './config';
import { loadReplay } from './main';
import { Store } from './store';
import { EXT_ID, ORIGIN, OTHER_EXT_ID, testConfig, testLogger, waitFor } from './test-support';

const HOST = '127.0.0.1:8787';
const handles: AppHandle[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.app.close();
});

async function makeApp(now?: () => number) {
  const { logger, capture } = testLogger();
  const store = new Store(':memory:');
  const h = await buildApp({
    config: testConfig({ tokenTtlMs: 1000 * 60, pairingMaxAttempts: 3 }),
    logger,
    store,
    coaching: coachingBinding,
    createLiveRecognizer: () => null,
    liveLlm: null,
    loadReplay,
    now,
    helloTimeoutMs: 300,
  });
  handles.push(h);
  return { h, capture, store };
}

async function pair(h: AppHandle, code: string, origin = ORIGIN, extensionId = EXT_ID) {
  return h.app.inject({
    method: 'POST',
    url: '/pair',
    headers: { host: HOST, origin, 'content-type': 'application/json' },
    payload: { pairingCode: code, extensionId, clientName: 'test' },
  });
}

async function paired() {
  const ctx = await makeApp();
  const code = ctx.h.auth.issuePairingCode();
  const res = await pair(ctx.h, code);
  expect(res.statusCode).toBe(200);
  const token = res.json().session.token as string;
  return { ...ctx, token, code };
}

function authed(token: string, extra: Record<string, string> = {}) {
  return { host: HOST, origin: ORIGIN, authorization: `Bearer ${token}`, ...extra };
}

describe('bind address', () => {
  it('refuses 0.0.0.0 unless ALLOW_NON_LOOPBACK=1', () => {
    expect(() => assertBindAllowed({ host: '0.0.0.0', allowNonLoopback: false })).toThrow(/non-loopback/);
    expect(() => assertBindAllowed({ host: '192.168.1.10', allowNonLoopback: false })).toThrow();
    expect(() => assertBindAllowed({ host: '0.0.0.0', allowNonLoopback: true })).not.toThrow();
    expect(() => assertBindAllowed({ host: '127.0.0.1', allowNonLoopback: false })).not.toThrow();
    expect(() => assertBindAllowed({ host: 'localhost', allowNonLoopback: false })).not.toThrow();
  });
});

describe('pairing / auth / origin / host', () => {
  it('health is minimal and still checks Host', async () => {
    const { h } = await makeApp();
    const ok = await h.app.inject({ method: 'GET', url: '/health', headers: { host: HOST } });
    expect(ok.statusCode).toBe(200);
    expect(Object.keys(ok.json()).sort()).toEqual(['ok', 'version']);
    const bad = await h.app.inject({ method: 'GET', url: '/health', headers: { host: 'evil.example:8787' } });
    expect(bad.statusCode).toBe(421);
  });

  it('pairing code is single-use and bound to the extension origin', async () => {
    const { h } = await makeApp();
    const code = h.auth.issuePairingCode();
    expect((await pair(h, code, 'https://evil.example')).statusCode).toBe(403);
    expect((await pair(h, code, `chrome-extension://${OTHER_EXT_ID}`)).statusCode).toBe(403); // body の ID と Origin が不一致
    const ok = await pair(h, code);
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.session.token.length).toBeGreaterThanOrEqual(32);
    expect(body.session.expiresAt).toBeGreaterThan(body.session.issuedAt);
    const again = await pair(h, code);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ ok: false, error: 'already_paired' });
  });

  it('wrong codes are limited; the code is burned after the attempt limit', async () => {
    const { h } = await makeApp();
    const code = h.auth.issuePairingCode();
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await pair(h, wrong)).statusCode).toBe(401);
    expect((await pair(h, wrong)).statusCode).toBe(401);
    expect((await pair(h, wrong)).statusCode).toBe(429);
    expect((await pair(h, code)).statusCode).toBe(429);
  });

  it('expired pairing code is rejected', async () => {
    let t = 1_000_000;
    const { h } = await makeApp(() => t);
    const code = h.auth.issuePairingCode();
    t += 11 * 60 * 1000;
    const r = await pair(h, code);
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('expired_code');
  });

  it('/config/status requires token + paired origin + valid host, and contains no secrets', async () => {
    const { h, token } = await paired();
    expect((await h.app.inject({ method: 'GET', url: '/config/status', headers: { host: HOST, origin: ORIGIN } })).statusCode).toBe(401);
    expect(
      (await h.app.inject({ method: 'GET', url: '/config/status', headers: authed(token, { origin: `chrome-extension://${OTHER_EXT_ID}` }) }))
        .statusCode,
    ).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/config/status', headers: authed(token, { origin: 'https://meet.google.com' }) })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'GET', url: '/config/status', headers: authed(token, { host: 'attacker.test:8787' }) })).statusCode).toBe(421);
    const ok = await h.app.inject({ method: 'GET', url: '/config/status', headers: authed(token) });
    expect(ok.statusCode).toBe(200);
    const s = ok.json();
    expect(s.modes).toEqual({ LIVE: false, OFFLINE: true });
    expect(s.stt.configured).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/apiKey|sk-ant|"token"/i);
  });

  it('a token in the URL query is never accepted', async () => {
    const { h, token } = await paired();
    const r = await h.app.inject({ method: 'GET', url: `/config/status?token=${token}`, headers: { host: HOST, origin: ORIGIN } });
    expect(r.statusCode).toBe(400);
    const r2 = await h.app.inject({ method: 'GET', url: `/config/status?access_token=${token}`, headers: authed(token) });
    expect(r2.statusCode).toBe(400);
  });

  it('expired tokens are rejected', async () => {
    let t = 5_000_000;
    const { h } = await makeApp(() => t);
    const code = h.auth.issuePairingCode();
    const token = (await pair(h, code)).json().session.token;
    expect((await h.app.inject({ method: 'GET', url: '/facts', headers: authed(token) })).statusCode).toBe(200);
    t += 61 * 1000;
    expect((await h.app.inject({ method: 'GET', url: '/facts', headers: authed(token) })).statusCode).toBe(401);
  });
});

describe('approved facts', () => {
  it('start unverified; approve bumps version; editing revokes approval; history is kept', async () => {
    const { h, token } = await paired();
    const H = authed(token, { 'content-type': 'application/json' });
    const created = await h.app.inject({
      method: 'POST',
      url: '/facts',
      headers: H,
      payload: { category: 'price_monthly', value: '月額 50,000円（税別・架空）', scope: '標準プラン', sourceNote: '社内承認メモ（架空）' },
    });
    expect(created.statusCode).toBe(201);
    const f0 = ApprovedFact.parse(created.json().fact);
    expect(f0).toMatchObject({ status: 'unverified', version: 1, approvedAt: null });

    const stale = await h.app.inject({ method: 'POST', url: `/facts/${f0.factId}/approve`, headers: H, payload: { version: 99 } });
    expect(stale.statusCode).toBe(409);

    const ap = await h.app.inject({ method: 'POST', url: `/facts/${f0.factId}/approve`, headers: H, payload: { version: 1 } });
    expect(ap.statusCode).toBe(200);
    const f1 = ApprovedFact.parse(ap.json().fact);
    expect(f1.status).toBe('approved');
    expect(f1.version).toBe(2);
    expect(f1.approvedAt).not.toBeNull();

    const ed = await h.app.inject({ method: 'PATCH', url: `/facts/${f0.factId}`, headers: H, payload: { value: '月額 55,000円（税別・架空）' } });
    expect(ed.statusCode).toBe(200);
    expect(ed.json().approvalRevoked).toBe(true);
    const f2 = ApprovedFact.parse(ed.json().fact);
    expect(f2).toMatchObject({ status: 'unverified', version: 3, approvedAt: null });

    const hist = await h.app.inject({ method: 'GET', url: `/facts/${f0.factId}/history`, headers: H });
    expect(hist.json().history.map((x: { action: string; version: number }) => `${x.action}@${x.version}`)).toEqual([
      'created@1',
      'approved@2',
      'edited@3',
    ]);

    const ap2 = await h.app.inject({ method: 'POST', url: `/facts/${f0.factId}/approve`, headers: H, payload: { version: 3 } });
    expect(ap2.json().fact).toMatchObject({ status: 'approved', version: 4 });
    const rv = await h.app.inject({ method: 'POST', url: `/facts/${f0.factId}/revoke`, headers: H, payload: {} });
    expect(rv.json().fact).toMatchObject({ status: 'revoked', version: 5, approvedAt: null });
  });

  it('rejects invalid bodies', async () => {
    const { h, token } = await paired();
    const r = await h.app.inject({
      method: 'POST',
      url: '/facts',
      headers: authed(token, { 'content-type': 'application/json' }),
      payload: { category: 'nope', value: 'x' },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('WebSocket upgrade / hello', () => {
  async function listen() {
    const ctx = await paired();
    await ctx.h.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = ctx.h.app.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    ctx.h.setPort(port);
    return { ...ctx, port };
  }

  function connect(port: number, opts: { origin?: string; query?: string } = {}) {
    return new WebSocket(`ws://127.0.0.1:${port}/ws${opts.query ?? ''}`, { origin: opts.origin ?? ORIGIN });
  }

  function closed(ws: WebSocket): Promise<{ code: number; status?: number }> {
    return new Promise((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve({ code: -1, status: res.statusCode }));
      ws.on('close', (code) => resolve({ code }));
      ws.on('error', () => {});
    });
  }

  it('rejects upgrade from a foreign origin (not just CORS)', async () => {
    const { port } = await listen();
    const r = await closed(connect(port, { origin: 'https://meet.google.com' }));
    expect(r.status).toBe(403);
  });

  it('rejects a token in the WS URL query', async () => {
    const { port, token } = await listen();
    const r = await closed(connect(port, { query: `?token=${token}` }));
    expect(r.status).toBe(400);
  });

  it('closes on bad hello, on binary-before-hello and on hello timeout; accepts valid hello', async () => {
    const { port, token } = await listen();
    const bad = connect(port);
    bad.on('open', () => bad.send(JSON.stringify({ type: 'hello', protocolVersion: 1, clientVersion: 't', token: 'x'.repeat(43) })));
    expect((await closed(bad)).code).toBe(4401);

    const bin = connect(port);
    bin.on('open', () => bin.send(new Uint8Array([1, 2, 3])));
    expect((await closed(bin)).code).toBe(4401);

    const silent = connect(port);
    expect((await closed(silent)).code).toBe(4408);

    const ok = connect(port);
    const msgs: any[] = [];
    ok.on('message', (d) => msgs.push(JSON.parse(String(d))));
    ok.on('open', () => ok.send(JSON.stringify({ type: 'hello', protocolVersion: 1, clientVersion: 't', token })));
    await waitFor(() => msgs.length > 0);
    expect(msgs[0]).toMatchObject({ type: 'hello.ack', protocolVersion: 1 });
    ok.close();
  });
});
