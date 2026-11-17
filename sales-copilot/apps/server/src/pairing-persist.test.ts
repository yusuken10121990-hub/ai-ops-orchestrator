import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthCheckResponse, LocalPairingCodeResponse } from '@sales-copilot/contracts';
import { buildApp, type AppHandle } from './app';
import { AuthManager } from './auth';
import { coachingBinding } from './coaching-binding';
import { DEFAULT_TOKEN_TTL_MS, loadConfig, userDataDirFor } from './config';
import { RollingFileStream } from './logger';
import { loadReplay } from './main';
import { Store } from './store';
import { EXT_ID, ORIGIN, testConfig, testLogger } from './test-support';
import { FileTokenStore, MemoryTokenStore, writeFileAtomicPrivate } from './token-store';
// @ts-expect-error 補助スクリプト（.mjs・型なし）。サーバーと同じ規則かを確かめる
import { userDataDirFor as scriptUserDataDirFor } from '../../../scripts/user-data-dir.mjs';

const HOST = '127.0.0.1:8787';
const DAY = 24 * 60 * 60 * 1000;
const handles: AppHandle[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.app.close();
});

const tmp = () => mkdtempSync(path.join(tmpdir(), 'sc-pair-'));

/** 「サーバー起動」1 回分。同じ tokens.json を渡せば再起動を再現できる。 */
async function boot(file: string, clock: { t: number }, over: { localAdminSecret?: string | null; ttlMs?: number } = {}) {
  const { logger, capture } = testLogger();
  const h = await buildApp({
    config: testConfig({ tokenTtlMs: over.ttlMs ?? DEFAULT_TOKEN_TTL_MS }),
    logger,
    store: new Store(':memory:'),
    coaching: coachingBinding,
    createLiveRecognizer: () => null,
    liveLlm: null,
    loadReplay,
    now: () => clock.t,
    tokenStore: new FileTokenStore(file),
    localAdminSecret: over.localAdminSecret ?? null,
  });
  handles.push(h);
  return { h, capture };
}

async function pairOnce(h: AppHandle): Promise<string> {
  const code = h.auth.issuePairingCode();
  const res = await h.app.inject({
    method: 'POST',
    url: '/pair',
    headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' },
    payload: { pairingCode: code, extensionId: EXT_ID, clientName: 'test' },
  });
  expect(res.statusCode).toBe(200);
  return res.json().session.token as string;
}

const check = (h: AppHandle, token: string, origin: string | undefined = undefined) =>
  h.app.inject({ method: 'GET', url: '/auth/check', headers: { host: HOST, authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) } });

describe('pairing survives a server restart (tokens.json)', () => {
  it('a token paired before a restart still works after it, over HTTP and from the extension origin', async () => {
    const file = path.join(tmp(), 'user', 'tokens.json');
    const clock = { t: 1_800_000_000_000 };
    const a = await boot(file, clock);
    const token = await pairOnce(a.h);
    await a.h.app.close();
    handles.length = 0;

    clock.t += 3 * DAY; // PC 再起動・3 日後
    const b = await boot(file, clock);
    const r = await check(b.h, token);
    expect(r.statusCode).toBe(200);
    const body = AuthCheckResponse.parse(r.json());
    expect(body.expiresAt).toBe(clock.t + DEFAULT_TOKEN_TTL_MS); // 使ったので延長されている
    // Origin 付き（拡張ページの POST 等）も、再起動後にペアリング済みとして許可される
    const facts = await b.h.app.inject({ method: 'GET', url: '/facts', headers: { host: HOST, origin: ORIGIN, authorization: `Bearer ${token}` } });
    expect(facts.statusCode).toBe(200);
  });

  it('stores only sha256 hashes — never the raw token — with user-only permissions', async () => {
    const dir = tmp();
    const file = path.join(dir, 'user', 'tokens.json');
    const { h } = await boot(file, { t: 1_800_000_000_000 });
    const token = await pairOnce(h);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(token);
    const json = JSON.parse(raw);
    expect(json.version).toBe(1);
    expect(json.tokens).toHaveLength(1);
    expect(json.tokens[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(json.tokens[0].extensionId).toBe(EXT_ID);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    // 一時ファイルを残さない（原子的書き込み）
    expect(readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('expired tokens are rejected after a restart and removed from the file', async () => {
    const file = path.join(tmp(), 'tokens.json');
    const clock = { t: 1_800_000_000_000 };
    const a = await boot(file, clock, { ttlMs: 10 * DAY });
    const token = await pairOnce(a.h);
    await a.h.app.close();
    handles.length = 0;
    clock.t += 11 * DAY; // 使わずに期限を過ぎた
    const b = await boot(file, clock, { ttlMs: 10 * DAY });
    expect((await check(b.h, token)).statusCode).toBe(401);
    expect(JSON.parse(readFileSync(file, 'utf8')).tokens).toEqual([]);
  });

  it('revoke (設定画面の「解除」) removes the token from memory and from the file; it stays revoked after a restart', async () => {
    const file = path.join(tmp(), 'tokens.json');
    const clock = { t: 1_800_000_000_000 };
    const a = await boot(file, clock);
    const token = await pairOnce(a.h);
    const res = await a.h.app.inject({ method: 'POST', url: '/auth/revoke', headers: { host: HOST, origin: ORIGIN, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect((await check(a.h, token)).statusCode).toBe(401);
    expect(JSON.parse(readFileSync(file, 'utf8')).tokens).toEqual([]);
    await a.h.app.close();
    handles.length = 0;
    const b = await boot(file, clock);
    expect((await check(b.h, token)).statusCode).toBe(401);
  });

  it('a corrupted tokens.json does not crash the server (re-pairing needed, file is replaced on next pairing)', async () => {
    const dir = tmp();
    const file = path.join(dir, 'tokens.json');
    writeFileSync(file, '{ not json');
    const { h } = await boot(file, { t: 1_800_000_000_000 });
    expect(h.auth.tokenCount).toBe(0);
    await pairOnce(h);
    expect(JSON.parse(readFileSync(file, 'utf8')).tokens).toHaveLength(1);
  });
});

describe('expiry and sliding', () => {
  const opts = (store: MemoryTokenStore, clock: { t: number }) => ({
    now: () => clock.t,
    tokenTtlMs: 10 * DAY,
    pairingCodeTtlMs: 600_000,
    pairingMaxAttempts: 5,
    allowedExtensionId: null,
    store,
    slideMinIntervalMs: 60 * 60 * 1000,
  });
  const pair = (a: AuthManager) => {
    const r = a.pair({ pairingCode: a.issuePairingCode(), extensionId: EXT_ID, origin: ORIGIN });
    if (!r.ok) throw new Error('pair failed');
    return r.session.token;
  };

  it('each use extends the expiry to now + TTL, so a token used regularly never expires', () => {
    const store = new MemoryTokenStore();
    const clock = { t: 1_000_000 };
    const a = new AuthManager(opts(store, clock));
    const token = pair(a);
    for (let day = 1; day <= 40; day++) {
      clock.t += 5 * DAY; // 5 日おきに使う（TTL 10 日を合計 200 日 超えても切れない）
      expect(a.verifyToken(token, { extensionId: EXT_ID, scope: 'session' })).toBe(true);
    }
    expect(a.tokenInfo(token)?.expiresAt).toBe(clock.t + 10 * DAY);
  });

  it('an unused token expires at TTL', () => {
    const store = new MemoryTokenStore();
    const clock = { t: 1_000_000 };
    const a = new AuthManager(opts(store, clock));
    const token = pair(a);
    clock.t += 10 * DAY;
    expect(a.verifyTokenWithoutOrigin(token, 'session')).toBe(false);
    expect(store.records).toEqual([]);
  });

  it('does not write to disk on every request (at most once per slideMinInterval)', () => {
    const store = new MemoryTokenStore();
    const clock = { t: 1_000_000 };
    const a = new AuthManager(opts(store, clock));
    const token = pair(a);
    const saves = store.saves;
    for (let i = 0; i < 50; i++) {
      clock.t += 1000;
      a.verifyTokenWithoutOrigin(token, 'session');
    }
    expect(store.saves).toBe(saves);
    clock.t += 60 * 60 * 1000;
    a.verifyTokenWithoutOrigin(token, 'session');
    expect(store.saves).toBe(saves + 1);
  });

  it('wrong extension / scope does not extend the expiry', () => {
    const store = new MemoryTokenStore();
    const clock = { t: 1_000_000 };
    const a = new AuthManager(opts(store, clock));
    const token = pair(a);
    const before = a.tokenInfo(token)!.expiresAt;
    clock.t += 2 * DAY;
    expect(a.verifyToken(token, { extensionId: 'ponmlkjihgfedcbaponmlkjihgfedcba', scope: 'session' })).toBe(false);
    expect(a.tokenInfo(token)!.expiresAt).toBe(before);
  });

  it('keeps at most maxTokens records (re-pairing does not grow the file forever)', () => {
    const store = new MemoryTokenStore();
    const clock = { t: 1_000_000 };
    const a = new AuthManager({ ...opts(store, clock), maxTokens: 3 });
    const tokens = [];
    for (let i = 0; i < 5; i++) {
      clock.t += 1000;
      tokens.push(pair(a));
    }
    expect(store.records).toHaveLength(3);
    expect(a.verifyTokenWithoutOrigin(tokens[0], 'session')).toBe(false);
    expect(a.verifyTokenWithoutOrigin(tokens[4], 'session')).toBe(true);
  });

  it('a save failure keeps the server working in memory and is reported without token contents', () => {
    const errors: string[] = [];
    const clock = { t: 1_000_000 };
    const a = new AuthManager({
      ...opts(new MemoryTokenStore(), clock),
      store: { load: () => [], save: () => { throw new Error('EACCES'); } },
      onPersistError: (op) => errors.push(op),
    });
    const token = pair(a);
    expect(a.verifyTokenWithoutOrigin(token, 'session')).toBe(true);
    expect(errors).toEqual(['save']);
  });
});

describe('pnpm pair: POST /local/pairing-code', () => {
  const SECRET = 'local-secret-for-test-0123456789abcdef';
  it('issues a fresh one-time code only with the local secret and without an Origin', async () => {
    const { h, capture } = await boot(path.join(tmp(), 't.json'), { t: 1_800_000_000_000 }, { localAdminSecret: SECRET });
    const ok = await h.app.inject({ method: 'POST', url: '/local/pairing-code', headers: { host: HOST, 'x-zerosys-local-secret': SECRET } });
    expect(ok.statusCode).toBe(200);
    const { pairingCode } = LocalPairingCodeResponse.parse(ok.json());
    // そのコードでペアリングできる（1 回限り）
    const p = await h.app.inject({ method: 'POST', url: '/pair', headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' }, payload: { pairingCode, extensionId: EXT_ID, clientName: 't' } });
    expect(p.statusCode).toBe(200);
    // コードも秘密もログに出ない
    expect(capture.text).not.toContain(pairingCode);
    expect(capture.text).not.toContain(SECRET);

    expect((await h.app.inject({ method: 'POST', url: '/local/pairing-code', headers: { host: HOST } })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: '/local/pairing-code', headers: { host: HOST, 'x-zerosys-local-secret': 'wrong' } })).statusCode).toBe(401);
    // ブラウザ（Origin 付き）からは秘密があっても使えない
    const fromPage = await h.app.inject({ method: 'POST', url: '/local/pairing-code', headers: { host: HOST, origin: 'https://evil.example', 'x-zerosys-local-secret': SECRET } });
    expect(fromPage.statusCode).toBe(403);
    const fromExt = await h.app.inject({ method: 'POST', url: '/local/pairing-code', headers: { host: HOST, origin: ORIGIN, 'x-zerosys-local-secret': SECRET } });
    expect(fromExt.statusCode).toBe(403);
    // Host 偽装（DNS リバインディング）も拒否
    expect((await h.app.inject({ method: 'POST', url: '/local/pairing-code', headers: { host: 'evil.example:8787', 'x-zerosys-local-secret': SECRET } })).statusCode).toBe(421);
  });

  it('is disabled (404) when the server has no local secret', async () => {
    const { h } = await boot(path.join(tmp(), 't.json'), { t: 1 });
    expect((await h.app.inject({ method: 'POST', url: '/local/pairing-code', headers: { host: HOST, 'x-zerosys-local-secret': 'x' } })).statusCode).toBe(404);
  });
});

describe('config', () => {
  it('default TTL is 180 days; the legacy 12h SESSION_TOKEN_TTL_MS in old .env files is ignored', () => {
    expect(loadConfig({}).tokenTtlMs).toBe(180 * DAY);
    const legacy = loadConfig({ SESSION_TOKEN_TTL_MS: '43200000' });
    expect(legacy.tokenTtlMs).toBe(180 * DAY);
    expect(legacy.legacyTokenTtlIgnored).toBe(true);
    expect(loadConfig({ SESSION_TOKEN_TTL_DAYS: '30' }).tokenTtlMs).toBe(30 * DAY);
    expect(() => loadConfig({ SESSION_TOKEN_TTL_DAYS: '0' })).toThrow();
  });

  it('user data dir: %LOCALAPPDATA%\\ZEROSYS-SalesCopilot on Windows, overridable; same rule as scripts/user-data-dir.mjs', () => {
    const cases: Array<[Record<string, string>, NodeJS.Platform]> = [
      [{ LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, 'win32'],
      [{}, 'win32'],
      [{}, 'darwin'],
      [{}, 'linux'],
      [{ XDG_STATE_HOME: '/x/state' }, 'linux'],
      [{ USER_DATA_DIR: '/custom' }, 'win32'],
    ];
    for (const [env, pf] of cases) expect(userDataDirFor(env, pf, '/home/u')).toBe(scriptUserDataDirFor(env, pf, '/home/u'));
    expect(userDataDirFor({ LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, 'win32', '/h')).toBe(path.join('C:/Users/u/AppData/Local', 'ZEROSYS-SalesCopilot'));
    expect(userDataDirFor({ USER_DATA_DIR: '/custom' }, 'win32', '/h')).toBe('/custom');
    const c = loadConfig({ USER_DATA_DIR: '/tmp/zz' });
    expect(c.tokenStoreFile).toBe(path.resolve('/tmp/zz/tokens.json'));
    expect(c.logFile).toBeNull();
  });
});

describe('files', () => {
  it('atomic write replaces the whole file and leaves no temp files', () => {
    const dir = tmp();
    const f = path.join(dir, 'a.json');
    writeFileAtomicPrivate(f, '{"v":1}');
    writeFileAtomicPrivate(f, '{"v":2}');
    expect(readFileSync(f, 'utf8')).toBe('{"v":2}');
    expect(readdirSync(dir)).toEqual(['a.json']);
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('rolling log file rotates at maxBytes and keeps N generations', async () => {
    const dir = tmp();
    const f = path.join(dir, 'logs', 'server.log');
    const s = new RollingFileStream(f, 100, 2);
    const line = Buffer.from('x'.repeat(60) + '\n');
    for (let i = 0; i < 6; i++) await new Promise<void>((r) => s.write(line, () => r()));
    await new Promise<void>((r) => s.end(r));
    expect(readdirSync(path.join(dir, 'logs')).sort()).toEqual(['server.log', 'server.log.1', 'server.log.2']);
    expect(statSync(f).size).toBeLessThanOrEqual(100);
  });
});
