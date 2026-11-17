import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { AuthScope } from '@sales-copilot/contracts';

/**
 * ペアリング済みトークンの永続化（サーバー再起動・PC 再起動をまたいでペアリングを保つ）。
 * - 保存するのは sha256 ハッシュ（hex）と拡張機能ID・スコープ・期限だけ。平文トークンは保存しない。
 * - 書き込みは「同じフォルダの一時ファイルに書いて fsync → rename」（途中で落ちても壊れた JSON を残さない）。
 * - ファイルは本人だけが読める権限（POSIX: 0600 / フォルダ 0700）。Windows は %LOCALAPPDATA% 配下
 *   （既定でそのユーザーだけがアクセスできる ACL）に置く。chmod は Windows では読み取り専用フラグ程度の効果しかない。
 */

export const TOKEN_FILE_VERSION = 1;

export const PersistedTokenRecord = z
  .object({
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    extensionId: z.string().regex(/^[a-p]{32}$/),
    scopes: z.array(AuthScope).min(1),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    lastUsedAt: z.number().int().nonnegative(),
  })
  .strict();
export type PersistedTokenRecord = z.infer<typeof PersistedTokenRecord>;

const TokenFile = z.object({ version: z.literal(TOKEN_FILE_VERSION), tokens: z.array(z.unknown()) }).passthrough();

export interface TokenPersistence {
  load(): PersistedTokenRecord[];
  save(records: PersistedTokenRecord[]): void;
}

export type TokenLoadIssue = 'missing' | 'unreadable' | 'invalid';

/** ファイルへ永続化する実装。 */
export class FileTokenStore implements TokenPersistence {
  /** 直近の load で起きたこと（ログ用。中身は出さない）。 */
  lastLoadIssue: TokenLoadIssue | null = null;
  constructor(readonly file: string) {}

  load(): PersistedTokenRecord[] {
    this.lastLoadIssue = null;
    if (!existsSync(this.file)) {
      this.lastLoadIssue = 'missing';
      return [];
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      // 壊れたファイルは使わない（推測で直さない）。次の保存で上書きされる＝再ペアリングが必要になる
      this.lastLoadIssue = 'unreadable';
      return [];
    }
    const f = TokenFile.safeParse(raw);
    if (!f.success) {
      this.lastLoadIssue = 'invalid';
      return [];
    }
    const out: PersistedTokenRecord[] = [];
    for (const t of f.data.tokens) {
      const r = PersistedTokenRecord.safeParse(t);
      if (r.success) out.push(r.data);
      else this.lastLoadIssue = 'invalid';
    }
    return out;
  }

  save(records: PersistedTokenRecord[]): void {
    writeFileAtomicPrivate(this.file, JSON.stringify({ version: TOKEN_FILE_VERSION, tokens: records }, null, 2) + '\n');
  }
}

/** メモリだけ（テスト・永続化しない構成用）。 */
export class MemoryTokenStore implements TokenPersistence {
  records: PersistedTokenRecord[] = [];
  saves = 0;
  load(): PersistedTokenRecord[] {
    return this.records.map((r) => ({ ...r, scopes: [...r.scopes] }));
  }
  save(records: PersistedTokenRecord[]): void {
    this.saves++;
    this.records = records.map((r) => ({ ...r, scopes: [...r.scopes] }));
  }
}

/** 本人だけが読めるフォルダを用意する（POSIX は 0700）。 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* 所有者でないフォルダ等。ファイル側の 0600 で守る */
    }
  }
}

/**
 * 原子的に書く: 同じフォルダの一時ファイル（0600 で作成）→ fsync → rename。
 * rename は同一ボリューム内なら置き換えが一瞬で、読み手は古い中身か新しい中身のどちらかしか見ない。
 */
export function writeFileAtomicPrivate(file: string, content: string): void {
  const dir = path.dirname(file);
  ensurePrivateDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, content, null, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    rmSync(tmp, { force: true });
    throw e;
  }
}
