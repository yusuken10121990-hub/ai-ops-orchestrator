import { closeSync, existsSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { Writable } from 'node:stream';
import pino, { type DestinationStream, type Logger } from 'pino';
import { ensurePrivateDir } from './token-store';
import path from 'node:path';

/**
 * 通常ログ（SPEC §14）: 会話本文・顧客名・メール・トークン・APIキーを出さない。
 * - 呼び出し側は ID・件数・理由コードだけを渡す（本文を渡さない）のが原則
 * - それでも紛れた場合に備え、既知の危険キーを redact で潰す（多層防御）
 */
export const REDACT_PATHS = [
  'token',
  'apiKey',
  'authorization',
  'text',
  'transcript',
  'customerName',
  'purpose',
  'say',
  'headline',
  'avoid',
  'briefReason',
  'pairingCode',
  'secret',
  '*.secret',
  'email',
  '*.token',
  '*.apiKey',
  '*.authorization',
  '*.Authorization',
  '*.text',
  '*.transcript',
  '*.customerName',
  '*.purpose',
  '*.say',
  '*.headline',
  '*.avoid',
  '*.briefReason',
  '*.pairingCode',
  '*.email',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
];

export function createLogger(opts: { level?: string; destination?: DestinationStream } = {}): Logger {
  return pino(
    {
      level: opts.level ?? 'info',
      base: { app: 'sales-copilot-server' },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      // エラーはスタックを含めない（メッセージに本文が混ざる経路を減らす）
      serializers: {
        err: (e: unknown) => {
          const o = e as { name?: string; code?: string; kind?: string };
          return { name: o?.name ?? 'Error', code: o?.code, kind: o?.kind };
        },
      },
    },
    opts.destination,
  );
}

/**
 * 自動起動（端末なし）用のローテーション付きログファイル。
 * maxBytes を超えたら file → file.1 → … → file.<keep> とずらし、最古を消す。本人だけが読める権限で作る。
 * 中身は通常ログと同じ（会話本文・トークン・キーは redact 済み）。
 */
export class RollingFileStream extends Writable {
  private fd: number | null = null;
  private size = 0;
  constructor(
    readonly file: string,
    private readonly maxBytes = 5 * 1024 * 1024,
    private readonly keep = 3,
  ) {
    super();
    ensurePrivateDir(path.dirname(file));
    this.open();
  }

  private open(): void {
    this.fd = openSync(this.file, 'a', 0o600);
    this.size = existsSync(this.file) ? statSync(this.file).size : 0;
  }

  private rotate(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    rmSync(`${this.file}.${this.keep}`, { force: true });
    for (let i = this.keep - 1; i >= 1; i--) {
      if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    }
    if (existsSync(this.file)) renameSync(this.file, `${this.file}.1`);
    this.open();
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    try {
      if (this.size > 0 && this.size + chunk.length > this.maxBytes) this.rotate();
      writeSync(this.fd!, chunk);
      this.size += chunk.length;
      cb();
    } catch (e) {
      cb(e as Error);
    }
  }

  override _final(cb: (e?: Error | null) => void): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    cb();
  }
}
