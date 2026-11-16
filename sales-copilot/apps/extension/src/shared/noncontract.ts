/**
 * contracts に無い形のやり取りをここに隔離する（サーバー実装と合わせて contracts へ移す要望を
 * docs/extension.md に記載）。形が合わない場合は「確認できない」として扱い、推測で埋めない。
 */
import { z } from 'zod';

/** 終了時の出力結果（サーバー → 拡張）。 */
export const SessionExportedMessage = z.object({
  type: z.literal('session.exported'),
  saved: z.boolean(),
  path: z.string().max(1000).optional(),
  reason: z.string().max(300).optional(),
});
export type SessionExportedMessage = z.infer<typeof SessionExportedMessage>;

/** GET /config/status（サーバー実装 apps/server の providerStatus に合わせる。欠けても表示できるよう全て任意）。 */
const ProviderInfo = z.object({ configured: z.boolean(), provider: z.string().optional(), model: z.string().optional(), language: z.string().optional() }).passthrough();
export const ConfigStatusResponse = z
  .object({
    version: z.string().optional(),
    stt: ProviderInfo.optional(),
    llm: ProviderInfo.optional(),
    modes: z.object({ LIVE: z.boolean(), OFFLINE: z.boolean() }).passthrough().optional(),
    offlineAdvice: z.string().optional(),
    priceTable: z.object({ configured: z.boolean(), currency: z.string().nullable().optional(), checkedDate: z.string().nullable().optional() }).passthrough().optional(),
  })
  .passthrough();
export type ConfigStatusResponse = z.infer<typeof ConfigStatusResponse>;

/** GET /sessions/:id/review（終了後の確認用。出力先パスだけを使う）。 */
export const SessionReviewResponse = z.object({ sessionId: z.string(), exportPath: z.string().nullable() }).passthrough();
export type SessionReviewResponse = z.infer<typeof SessionReviewResponse>;
