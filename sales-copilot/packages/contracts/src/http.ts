import { z } from 'zod';
import { AudioSource, CaptureSource } from './audio';
import { AdviceCard } from './advice';
import { AppliedFactRef, ApprovedFact, FactCategory } from './facts';
import { OfflineScriptId, PROTOCOL_VERSION } from './messages';
import { SessionMode } from './status';
import { BudgetLimits, UsageSnapshot } from './usage';

/**
 * ローカルサーバーの HTTP 応答・要求ボディ。サーバーは返す前に、拡張機能は受け取った後にこのスキーマで検証する。
 * 秘密（APIキー・トークン）はどの応答にも含めない。
 */

const EpochMs = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// GET /config/status（settings スコープ）
// ---------------------------------------------------------------------------

export const ConfigStatusResponse = z
  .object({
    version: z.string().max(32),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    stt: z
      .object({ configured: z.boolean(), provider: z.literal('deepgram'), model: z.string().max(100), language: z.string().max(20) })
      .strict(),
    llm: z
      .object({
        configured: z.boolean(),
        provider: z.literal('anthropic'),
        /** 自動カード用モデル。 */
        model: z.string().max(100),
        /** 手動ボタン（切り返し等）用モデル。旧サーバーでは欠ける。 */
        manualModel: z.string().max(100).optional(),
      })
      .strict(),
    modes: z.object({ LIVE: z.boolean(), OFFLINE: z.boolean() }).strict(),
    /**
     * OFFLINE テストで Anthropic を使えるか（キーあり かつ OFFLINE_USE_ANTHROPIC=1）。
     * 使うのはセッション開始時に本人が offlineUseAnthropic=true を選んだときだけ。
     */
    offlineAnthropicAvailable: z.boolean(),
    priceTable: z
      .object({ configured: z.boolean(), currency: z.string().nullable(), checkedDate: z.string().nullable() })
      .strict(),
    retentionMs: z.number().int().nonnegative(),
    budget: BudgetLimits,
  })
  .strict();
export type ConfigStatusResponse = z.infer<typeof ConfigStatusResponse>;

// ---------------------------------------------------------------------------
// /facts（settings スコープ）
// ---------------------------------------------------------------------------

export const FactCreateRequest = z
  .object({
    category: FactCategory,
    value: z.string().min(1).max(1000),
    scope: z.string().max(500).default(''),
    sourceNote: z.string().max(500).default(''),
  })
  .strict();
export type FactCreateRequest = z.input<typeof FactCreateRequest>;

export const FactPatchRequest = z
  .object({
    category: FactCategory.optional(),
    value: z.string().min(1).max(1000).optional(),
    scope: z.string().max(500).optional(),
    sourceNote: z.string().max(500).optional(),
  })
  .strict();
export type FactPatchRequest = z.infer<typeof FactPatchRequest>;

export const FactApproveRequest = z.object({ version: z.number().int().positive() }).strict();
export type FactApproveRequest = z.infer<typeof FactApproveRequest>;

/** GET /facts */
export const FactsListResponse = z.object({ facts: z.array(ApprovedFact) }).strict();
export type FactsListResponse = z.infer<typeof FactsListResponse>;

/** POST /facts, POST /facts/:id/approve, POST /facts/:id/revoke */
export const FactResponse = z.object({ fact: ApprovedFact }).strict();
export type FactResponse = z.infer<typeof FactResponse>;

/** PATCH /facts/:id（内容が変わったら承認は失効: approvalRevoked=true） */
export const FactUpdateResponse = z.object({ fact: ApprovedFact, approvalRevoked: z.boolean() }).strict();
export type FactUpdateResponse = z.infer<typeof FactUpdateResponse>;

// ---------------------------------------------------------------------------
// 遅延統計（SPEC §8-3, docs/latency.md）
// ---------------------------------------------------------------------------

export const LatencySummary = z
  .object({ n: z.number().int().nonnegative(), p50: z.number().nullable(), p95: z.number().nullable(), max: z.number().nullable() })
  .strict();
export type LatencySummary = z.infer<typeof LatencySummary>;

export const LatencyStats = z
  .object({
    counts: z
      .object({
        eligible: z.number().int().nonnegative(),
        started: z.number().int().nonnegative(),
        /** advice.card を送信した数。 */
        displayed: z.number().int().nonnegative(),
        /** クライアントが advice.displayed で表示を報告した数。 */
        displayAcked: z.number().int().nonnegative(),
        noAdvice: z.number().int().nonnegative(),
        discarded: z.number().int().nonnegative(),
        timeout: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        fallback: z.number().int().nonnegative(),
      })
      .strict(),
    speechEndToSttFinalMs: LatencySummary,
    speechEndToSentMs: LatencySummary,
    sttFinalToSentMs: LatencySummary,
    requestedToValidatedMs: LatencySummary,
    validatedToSentMs: LatencySummary,
    /** 送信 → クライアントの表示報告をサーバーが受信（往復の片道＋描画を含む）。 */
    sentToDisplayedMs: LatencySummary,
    /** 主指標の画面反映版: 発話終了推定 → 表示報告の受信。 */
    speechEndToDisplayedMs: LatencySummary,
    target: z.object({ p50Ms: z.literal(3000), p95Ms: z.literal(5000) }).strict(),
  })
  .strict();
export type LatencyStats = z.infer<typeof LatencyStats>;

// ---------------------------------------------------------------------------
// GET /sessions/:id/review（session スコープ・保持期間内のみ）
// ---------------------------------------------------------------------------

export const AudioGapRecord = z
  .object({
    source: CaptureSource,
    fromMs: z.number().nonnegative(),
    toMs: z.number().nonnegative(),
    droppedMs: z.number().nonnegative(),
    /** server_queue = サーバーの STT 送信待ち上限超過 / client_backpressure 等 = 拡張からの audio.gap。 */
    origin: z.enum(['server', 'client']),
    reason: z.string().max(64),
  })
  .strict();
export type AudioGapRecord = z.infer<typeof AudioGapRecord>;

export const ReviewTranscriptEntry = z
  .object({
    utteranceId: z.string(),
    source: AudioSource,
    text: z.string(),
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
    flags: z.array(z.string()),
  })
  .strict();
export type ReviewTranscriptEntry = z.infer<typeof ReviewTranscriptEntry>;

export const SessionReviewResponse = z
  .object({
    sessionId: z.string().min(1),
    mode: SessionMode,
    endedAt: EpochMs,
    retainedUntil: EpochMs,
    exportPath: z.string().nullable(),
    appliedFacts: z.array(AppliedFactRef),
    latency: LatencyStats,
    usage: UsageSnapshot,
    transcript: z.array(ReviewTranscriptEntry),
    advice: z.array(AdviceCard),
    audioGaps: z.array(AudioGapRecord),
  })
  .strict();
export type SessionReviewResponse = z.infer<typeof SessionReviewResponse>;

// ---------------------------------------------------------------------------
// GET /offline/scripts（session スコープ）
// ---------------------------------------------------------------------------

export const OfflineScriptInfo = z
  .object({
    id: OfflineScriptId,
    title: z.string().max(200),
    description: z.string().max(1000),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();
export type OfflineScriptInfo = z.infer<typeof OfflineScriptInfo>;

export const OfflineScriptsResponse = z
  .object({
    scripts: z.array(OfflineScriptInfo),
    /** offlineScriptId を省略したときに使うスクリプト（OFFLINE_SCRIPT または先頭）。 */
    defaultId: OfflineScriptId.nullable(),
  })
  .strict();
export type OfflineScriptsResponse = z.infer<typeof OfflineScriptsResponse>;
