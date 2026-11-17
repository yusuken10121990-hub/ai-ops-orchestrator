import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { AUTH_SCHEME, type AuthScope, type SessionToken } from '@sales-copilot/contracts';
import type { PersistedTokenRecord, TokenPersistence } from './token-store';

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
  lastUsedAt: number;
}

export interface AuthOptions {
  now?: () => number;
  /** トークンの有効期間。使うたびにここから延長する（スライド）。 */
  tokenTtlMs: number;
  pairingCodeTtlMs: number;
  pairingMaxAttempts: number;
  allowedExtensionId: string | null;
  /** トークン記録（ハッシュのみ）の永続化先。無ければメモリだけ（再起動で消える）。 */
  store?: TokenPersistence | null;
  /** 期限の延長を保存する最小間隔（毎回の要求でディスクに書かない）。既定 1 時間。 */
  slideMinIntervalMs?: number;
  /** 保持するトークン数の上限（再ペアリングのたびに増え続けない）。超えたら最後に使ったのが古い順に消す。 */
  maxTokens?: number;
  /** 永続化に失敗した（メモリ上は動き続ける）。中身・トークンは渡さない。 */
  onPersistError?: (op: 'load' | 'save', e: unknown) => void;
}

export interface TokenInfo {
  issuedAt: number;
  expiresAt: number;
  scopes: AuthScope[];
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

  private readonly slideMinIntervalMs: number;
  private readonly maxTokens: number;

  constructor(private readonly o: AuthOptions) {
    this.now = o.now ?? (() => Date.now());
    this.slideMinIntervalMs = o.slideMinIntervalMs ?? 60 * 60 * 1000;
    this.maxTokens = o.maxTokens ?? 20;
    if (o.allowedExtensionId) this.pairedExtensionIds.add(o.allowedExtensionId);
    this.loadPersisted();
  }

  // --- 永続化 ---------------------------------------------------------------

  private loadPersisted(): void {
    if (!this.o.store) return;
    let records: PersistedTokenRecord[];
    try {
      records = this.o.store.load();
    } catch (e) {
      this.o.onPersistError?.('load', e);
      return;
    }
    const t = this.now();
    let dropped = false;
    for (const r of records) {
      // 期限切れ・事前許可IDと違う拡張機能のものは読み込まない
      if (t >= r.expiresAt || (this.o.allowedExtensionId && r.extensionId !== this.o.allowedExtensionId)) {
        dropped = true;
        continue;
      }
      this.tokens.set(r.hash, {
        hash: Buffer.from(r.hash, 'hex'),
        extensionId: r.extensionId,
        scopes: [...r.scopes],
        issuedAt: r.issuedAt,
        expiresAt: r.expiresAt,
        lastUsedAt: r.lastUsedAt,
      });
      this.pairedExtensionIds.add(r.extensionId);
    }
    if (dropped) this.persist();
  }

  private persist(): void {
    if (!this.o.store) return;
    const out: PersistedTokenRecord[] = [...this.tokens.values()].map((r) => ({
      hash: r.hash.toString('hex'),
      extensionId: r.extensionId,
      scopes: [...r.scopes],
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
      lastUsedAt: r.lastUsedAt,
    }));
    try {
      this.o.store.save(out);
    } catch (e) {
      this.o.onPersistError?.('save', e);
    }
  }

  /** 有効なトークンの記録数（テスト・状態表示用）。 */
  get tokenCount(): number {
    return this.tokens.size;
  }

  /** 新しいペアリングコードを発行し、平文を一度だけ返す（TTY へ表示する用途のみ）。 */
  issuePairingCode(fixedCodeForTest: string | null = null): string {
    const code = fixedCodeForTest ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
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
    const rec: TokenRecord = { hash: sha256(token), extensionId, scopes, issuedAt, expiresAt: issuedAt + this.o.tokenTtlMs, lastUsedAt: issuedAt };
    this.tokens.set(rec.hash.toString('hex'), rec);
    this.evictOverflow();
    this.persist();
    return { token, tokenType: AUTH_SCHEME, issuedAt, expiresAt: rec.expiresAt, scopes };
  }

  private evictOverflow(): void {
    if (this.tokens.size <= this.maxTokens) return;
    const byUse = [...this.tokens.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [k] of byUse.slice(0, this.tokens.size - this.maxTokens)) this.tokens.delete(k);
  }

  /** 有効な記録を返す（期限切れは消す）。 */
  private lookup(token: string | null | undefined): { key: string; rec: TokenRecord } | null {
    if (!token || token.length < 32 || token.length > 512) return null;
    const key = sha256(token).toString('hex');
    const rec = this.tokens.get(key);
    if (!rec) return null;
    if (this.now() >= rec.expiresAt) {
      this.tokens.delete(key);
      this.persist();
      return null;
    }
    return { key, rec };
  }

  /** 使われた: 期限を now + TTL へ延長する（保存は slideMinIntervalMs 以上動いたときだけ）。 */
  private touch(rec: TokenRecord): void {
    const t = this.now();
    const next = t + this.o.tokenTtlMs;
    if (next - rec.expiresAt < this.slideMinIntervalMs) return;
    rec.expiresAt = next;
    rec.lastUsedAt = t;
    this.persist();
  }

  /** トークン検証。拡張機能IDの一致（Origin 束縛）と期限・スコープを確認。成功したら期限を延長する。 */
  verifyToken(token: string | null | undefined, opts: { extensionId: string | null; scope: AuthScope }): boolean {
    const f = this.lookup(token);
    if (!f) return false;
    if (!opts.extensionId || f.rec.extensionId !== opts.extensionId) return false;
    if (!f.rec.scopes.includes(opts.scope)) return false;
    this.touch(f.rec);
    return true;
  }

  /**
   * Origin ヘッダーが無い HTTP 要求用（Chrome は拡張ページからの GET に Origin を付けない）。
   * トークンの期限・スコープと、発行先の拡張機能がペアリング済みであることを確認する。WebSocket には使わない。
   */
  verifyTokenWithoutOrigin(token: string | null | undefined, scope: AuthScope): boolean {
    const f = this.lookup(token);
    if (!f) return false;
    if (!this.pairedExtensionIds.has(f.rec.extensionId) || !f.rec.scopes.includes(scope)) return false;
    this.touch(f.rec);
    return true;
  }

  /** 有効なトークンの期限など（検証済みの要求の中で使う。トークン自体は返さない）。 */
  tokenInfo(token: string | null | undefined): TokenInfo | null {
    const f = this.lookup(token);
    return f ? { issuedAt: f.rec.issuedAt, expiresAt: f.rec.expiresAt, scopes: [...f.rec.scopes] } : null;
  }

  /** そのトークンだけ失効させる（設定画面の「解除」）。 */
  revokeToken(token: string | null | undefined): boolean {
    if (!token || token.length < 32 || token.length > 512) return false;
    const key = sha256(token).toString('hex');
    const had = this.tokens.delete(key);
    if (had) this.persist();
    return had;
  }

  /** WS/HTTP の Origin 許可判定（ペアリング済み or 環境変数で許可された拡張機能のみ）。 */
  isAllowedOrigin(origin: string | undefined): boolean {
    const id = parseExtensionOrigin(origin);
    return id !== null && this.pairedExtensionIds.has(id);
  }

  revokeAll(): void {
    this.tokens.clear();
    this.persist();
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
