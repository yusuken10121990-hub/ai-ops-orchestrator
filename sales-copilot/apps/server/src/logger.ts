import pino, { type DestinationStream, type Logger } from 'pino';

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
