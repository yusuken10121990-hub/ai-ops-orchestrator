import { z } from 'zod';

/**
 * 一度限りのペアリングと期限付きセッショントークン（SPEC §14）。
 * トークンは URL クエリやログに残さない。WS では最初の hello メッセージで渡す。
 */
export const PAIRING_CODE_PATTERN = /^\d{6}$/;
export const SESSION_TOKEN_MIN_LENGTH = 32;
export const AUTH_HEADER = 'authorization';
export const AUTH_SCHEME = 'Bearer';

export const AuthScope = z.enum(['session', 'settings']);
export type AuthScope = z.infer<typeof AuthScope>;

export const PairingRequest = z
  .object({
    /** サーバー側の画面/ターミナルに表示した一度限りのコード。 */
    pairingCode: z.string().regex(PAIRING_CODE_PATTERN),
    /** chrome.runtime.id。Origin `chrome-extension://<id>` と一致すること。 */
    extensionId: z.string().regex(/^[a-p]{32}$/),
    clientName: z.string().min(1).max(64),
  })
  .strict();
export type PairingRequest = z.infer<typeof PairingRequest>;

export const SessionToken = z
  .object({
    token: z.string().min(SESSION_TOKEN_MIN_LENGTH).max(512),
    tokenType: z.literal(AUTH_SCHEME),
    /** epoch ms */
    issuedAt: z.number().int().nonnegative(),
    /** epoch ms */
    expiresAt: z.number().int().nonnegative(),
    scopes: z.array(AuthScope).min(1),
  })
  .strict()
  .refine((t) => t.expiresAt > t.issuedAt, { message: 'expiresAt must be after issuedAt', path: ['expiresAt'] });
export type SessionToken = z.infer<typeof SessionToken>;

export const PairingResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), session: SessionToken }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.enum(['invalid_code', 'expired_code', 'already_paired', 'origin_mismatch', 'rate_limited']),
    })
    .strict(),
]);
export type PairingResponse = z.infer<typeof PairingResponse>;
