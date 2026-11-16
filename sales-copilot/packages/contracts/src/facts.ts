import { z } from 'zod';

/** 承認済み商談条件の分類（SPEC §13）。 */
export const FactCategory = z.enum([
  'price_initial',
  'price_monthly',
  'tax',
  'usage_fee',
  'extra_fee',
  'min_term',
  'cancellation',
  'ip_rights',
  'data_migration',
  'demo_scope',
  'maintenance_scope',
  'tech_spec',
  'unverified_note',
]);
export type FactCategory = z.infer<typeof FactCategory>;

/** 全項目は初期状態 unverified。編集で旧承認は失効し再承認が必要（SPEC §13）。 */
export const FactStatus = z.enum(['unverified', 'approved', 'revoked']);
export type FactStatus = z.infer<typeof FactStatus>;

export const ApprovedFact = z
  .object({
    factId: z.string().min(1).max(128),
    category: FactCategory,
    value: z.string().max(1000),
    /** 適用範囲（対象サービス・プラン・適用顧客など）。 */
    scope: z.string().max(500),
    /** 出典メモ。 */
    sourceNote: z.string().max(500),
    /** epoch ms。unverified の間は null。 */
    approvedAt: z.number().int().nonnegative().nullable(),
    version: z.number().int().positive(),
    status: FactStatus,
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.status === 'approved' && f.approvedAt === null) {
      ctx.addIssue({ code: 'custom', path: ['approvedAt'], message: 'approved fact requires approvedAt' });
    }
  });
export type ApprovedFact = z.infer<typeof ApprovedFact>;

/** セッションで使用する条件と、そのバージョン（使用バージョンを記録する）。 */
export const AppliedFactRef = z
  .object({
    factId: z.string().min(1).max(128),
    version: z.number().int().positive(),
  })
  .strict();
export type AppliedFactRef = z.infer<typeof AppliedFactRef>;
