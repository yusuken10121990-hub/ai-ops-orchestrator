import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { AUTH_SCHEME, type AuthScope, type SessionToken } from '@sales-copilot/contracts';

export const EXTENSION_ORIGIN_PREFIX = 'chrome-extension://';
const EXTENSION_ID = /^[a-p]{32}$/;

export function extensionOrigin(id: string): string {
  return `${EXTENSION_ORIGIN_PREFIX}${id}`;
}

/** `chrome-extension://<id>` から ID を取り出す。形式違反は null。 */
export function parseExtensionOrigin(origin: string | undefined): string | null {
  if (!origin || !origin.startsWith(EXTENSION_ORIGIN_PREFIX)) return null;
  const id = origin.slice(EXTENSION_ORIGIN_PREFIX.length);
  return EXTENSION_ID.test(id) ? id : null;
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

export type PairingResult =
  | { ok: true; session: SessionToken }
  | { ok: false; error: 'invalid_code' | 'expired_code' | 'already_paired' | 'origin_mismatch' | 'rate_limited' };

interface TokenRecord {
  hash: Buffer;
  extensionId: string;
  scopes: AuthScope[];
  issuedAt: number;
  expiresAt: number;
}

export interface AuthOptions {
  now?: () => number;
  tokenTtlMs: number;
  pairingCodeTtlMs: number;
  pairingMaxAttempts: number;
  allowedExtensionId: string | null;
}

/**
 * 一度限りのペアリングコード（6桁）と期限付きセッショントークン（SPEC §14）。
 * - コードは単回使用・期限付き・試行回数上限（超えたら失効。サーバー再起動で新コード）
 * - トークンはランダム 32byte（base64url）。サーバーはハッシュのみ保持し、拡張機能IDに束縛
 * - トークンは URL クエリ・ログに出さない（呼び出し側の責務: Authorization ヘッダー / WS hello のみ）
 */
export class AuthManager {
  private readonly now: () => number;
  private code: { hash: Buffer; expiresAt: number; attempts: number; used: boolean; locked: boolean } | null = null;
  private readonly tokens = new Map<string, TokenRecord>();
  private readonly pairedExtensionIds = new Set<string>();

  constructor(private readonly o: AuthOptions) {
    this.now = o.now ?? (() => Date.now());
    if (o.allowedExtensionId) this.pairedExtensionIds.add(o.allowedExtensionId);
  }

  /** 新しいペアリングコードを発行し、平文を一度だけ返す（TTY へ表示する用途のみ）。 */
  issuePairingCode(): string {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.code = { hash: sha256(code), expiresAt: this.now() + this.o.pairingCodeTtlMs, attempts: 0, used: false, locked: false };
    return code;
  }

  pair(input: { pairingCode: string; extensionId: string; origin: string | undefined }): PairingResult {
    const originId = parseExtensionOrigin(input.origin);
    if (!originId || originId !== input.extensionId) return { ok: false, error: 'origin_mismatch' };
    if (this.o.allowedExtensionId && this.o.allowedExtensionId !== input.extensionId) {
      return { ok: false, error: 'origin_mismatch' };
    }
    const c = this.code;
    if (!c) return { ok: false, error: 'invalid_code' };
    if (c.used) return { ok: false, error: 'already_paired' };
    if (c.locked) return { ok: false, error: 'rate_limited' };
    if (this.now() >= c.expiresAt) return { ok: false, error: 'expired_code' };
    c.attempts++;
    const ok = timingSafeEqual(sha256(input.pairingCode), c.hash);
    if (!ok) {
      if (c.attempts >= this.o.pairingMaxAttempts) c.locked = true;
      return { ok: false, error: c.locked ? 'rate_limited' : 'invalid_code' };
    }
    c.used = true;
    this.pairedExtensionIds.add(input.extensionId);
    return { ok: true, session: this.issueToken(input.extensionId, ['session', 'settings']) };
  }

  private issueToken(extensionId: string, scopes: AuthScope[]): SessionToken {
    const token = randomBytes(32).toString('base64url');
    const issuedAt = this.now();
    const rec: TokenRecord = { hash: sha256(token), extensionId, scopes, issuedAt, expiresAt: issuedAt + this.o.tokenTtlMs };
    this.tokens.set(rec.hash.toString('hex'), rec);
    return { token, tokenType: AUTH_SCHEME, issuedAt, expiresAt: rec.expiresAt, scopes };
  }

  /** トークン検証。拡張機能IDの一致（Origin 束縛）と期限・スコープを確認。 */
  verifyToken(token: string | null | undefined, opts: { extensionId: string | null; scope: AuthScope }): boolean {
    if (!token || token.length < 32 || token.length > 512) return false;
    const key = sha256(token).toString('hex');
    const rec = this.tokens.get(key);
    if (!rec) return false;
    if (this.now() >= rec.expiresAt) {
      this.tokens.delete(key);
      return false;
    }
    if (!opts.extensionId || rec.extensionId !== opts.extensionId) return false;
    return rec.scopes.includes(opts.scope);
  }

  /** WS/HTTP の Origin 許可判定（ペアリング済み or 環境変数で許可された拡張機能のみ）。 */
  isAllowedOrigin(origin: string | undefined): boolean {
    const id = parseExtensionOrigin(origin);
    return id !== null && this.pairedExtensionIds.has(id);
  }

  revokeAll(): void {
    this.tokens.clear();
  }
}

/** `Authorization: Bearer <token>` からトークンを取り出す。 */
export function bearerToken(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h) return null;
  const m = /^Bearer\s+([A-Za-z0-9_\-.~+/=]+)$/.exec(h.trim());
  return m ? m[1]! : null;
}

/** Host ヘッダーが 127.0.0.1 / localhost / [::1] の待受ポートか（DNS リバインディング対策）。 */
export function isAllowedHostHeader(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  return allowed.includes(host.toLowerCase());
}

/** URL クエリにトークンらしきものが載っていないか（載っていたら拒否する）。 */
export function urlCarriesCredential(url: string): boolean {
  const q = url.indexOf('?');
  if (q < 0) return false;
  const params = new URLSearchParams(url.slice(q + 1));
  for (const k of params.keys()) {
    if (/^(token|access_token|auth|authorization|key|api_key|session)$/i.test(k)) return true;
  }
  return false;
}
