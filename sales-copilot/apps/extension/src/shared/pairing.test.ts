import { describe, expect, it } from 'vitest';
import type { ApiError, ApiResult } from './api';
import { checkPairing, PAIRING_EXPIRED_LINE, pairingProblemLine, SERVER_DOWN_LINE } from './pairing';
import { describeApiError } from './api';

const session = { token: 't'.repeat(43), tokenType: 'Bearer' as const, issuedAt: 1, expiresAt: 2, scopes: ['session' as const] };
const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
const err = (e: ApiError): ApiResult<never> => ({ ok: false, error: e });
const api = (health: ApiResult<unknown>, auth: ApiResult<{ ok: true; issuedAt: number; expiresAt: number; scopes: ('session' | 'settings')[] }>) => ({
  health: async () => health,
  authCheck: async () => auth,
});

describe('checkPairing', () => {
  it('server down → server_down (before looking at the token)', async () => {
    expect(await checkPairing(api(err({ kind: 'network' }), err({ kind: 'network' })), session)).toEqual({ kind: 'server_down' });
    expect(await checkPairing(api(err({ kind: 'network' }), err({ kind: 'network' })), null)).toEqual({ kind: 'server_down' });
  });
  it('no token → not_paired', async () => {
    expect(await checkPairing(api(ok({}), err({ kind: 'unauthorized' })), null)).toEqual({ kind: 'not_paired' });
  });
  it('401 from /auth/check → pairing_expired', async () => {
    expect(await checkPairing(api(ok({}), err({ kind: 'unauthorized' })), session)).toEqual({ kind: 'pairing_expired' });
  });
  it('valid → ok with the server-side (slid) expiry', async () => {
    expect(await checkPairing(api(ok({}), ok({ ok: true, issuedAt: 1, expiresAt: 999, scopes: ['session'] })), session)).toEqual({ kind: 'ok', expiresAt: 999 });
  });
  it('other errors → unknown (not guessed as expired)', async () => {
    expect(await checkPairing(api(ok({}), err({ kind: 'http', status: 500 })), session)).toEqual({ kind: 'unknown' });
  });
});

describe('lines (what happened → how to fix)', () => {
  it('uses one clear line for each problem', () => {
    expect(PAIRING_EXPIRED_LINE).toBe('ペアリングが切れました → 設定画面で再ペアリング');
    expect(pairingProblemLine('pairing_expired')).toBe(PAIRING_EXPIRED_LINE);
    expect(pairingProblemLine('server_down')).toBe(SERVER_DOWN_LINE);
    expect(SERVER_DOWN_LINE).toMatch(/^サーバーが起動していません → /);
    expect(describeApiError({ kind: 'unauthorized' })).toBe(PAIRING_EXPIRED_LINE);
    expect(describeApiError({ kind: 'network' })).toBe(SERVER_DOWN_LINE);
  });
});
