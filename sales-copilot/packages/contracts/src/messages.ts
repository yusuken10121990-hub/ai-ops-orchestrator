import { z } from 'zod';
import { AudioSource, CaptureSource } from './audio';
import { AdviceCard, AdviceCardStatus, AdviceInvalidationReason, AdviceWarning, ManualAdviceKind } from './advice';
import { AppliedFactRef } from './facts';
import { PipelineStatus, SessionLifecycleState, SessionMode, StatusReason, StoragePolicy } from './status';
import { UsageSnapshot } from './usage';

export const PROTOCOL_VERSION = 1 as const;

const Id = z.string().min(1).max(128);
const EpochMs = z.number().int().nonnegative();
/** OFFLINE 再生スクリプトの ID（ファイル名由来・英小文字/数字/ハイフン）。 */
export const OfflineScriptId = z.string().regex(/^[a-z0-9-]{1,64}$/);

// ---------------------------------------------------------------------------
// Client → Server（JSON テキストフレーム。音声はバイナリフレーム: audio.ts）
// ---------------------------------------------------------------------------

/** 接続直後の最初のメッセージ。トークンは URL クエリに載せない（SPEC §14）。 */
export const HelloMessage = z
  .object({
    type: z.literal('hello'),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    clientVersion: z.string().min(1).max(32),
    token: z.string().min(32).max(512),
  })
  .strict();

export const SessionStartMessage = z
  .object({
    type: z.literal('session.start'),
    purpose: z.string().min(1).max(500),
    /** 顧客名は任意（SPEC §3）。 */
    customerName: z.string().min(1).max(100).optional(),
    /** 今回適用する承認済み条件と使用バージョン。 */
    appliedFacts: z.array(AppliedFactRef).max(100),
    mode: SessionMode,
    /** 自分のマイク取得を行うか（会議側ミュートとは独立）。 */
    selfCaptureEnabled: z.boolean(),
    /** 外部送信を伴う開始の明示確認。true 以外は受け付けない。 */
    consentConfirmed: z.literal(true),
    storage: StoragePolicy.default('memory_only'),
    /**
     * OFFLINE のみ: 再生する架空会話スクリプト（`GET /offline/scripts` の id）。未指定ならサーバー既定。
     * LIVE で指定した場合は invalid_message。
     */
    offlineScriptId: OfflineScriptId.optional(),
    /**
     * OFFLINE のみ: 助言生成に Anthropic を使う希望。サーバーにキーがあり、かつ環境変数
     * OFFLINE_USE_ANTHROPIC=1 で許可されている場合だけ有効（それ以外は外部送信しないルールベース）。
     */
    offlineUseAnthropic: z.boolean().optional(),
  })
  .strict();

export const SourceStateMessage = z.discriminatedUnion('source', [
  z
    .object({
      type: z.literal('source.state'),
      source: z.literal('SELF'),
      state: z.enum(['on', 'off']),
      reason: StatusReason.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('source.state'),
      source: z.literal('REMOTE'),
      state: z.enum(['ok', 'lost']),
      reason: StatusReason.optional(),
    })
    .strict(),
]);

export const AnalysisPauseMessage = z.object({ type: z.literal('analysis.pause') }).strict();
export const AnalysisResumeMessage = z.object({ type: z.literal('analysis.resume') }).strict();

export const AdviceRequestMessage = z
  .object({
    type: z.literal('advice.request'),
    kind: ManualAdviceKind,
    requestId: Id,
  })
  .strict();

export const CardPinMessage = z.object({ type: z.literal('card.pin'), adviceId: Id }).strict();
export const CardUnpinMessage = z.object({ type: z.literal('card.unpin'), adviceId: Id }).strict();

export const FeedbackRating = z.enum(['helpful', 'off']);
export type FeedbackRating = z.infer<typeof FeedbackRating>;
export const FeedbackMessage = z
  .object({ type: z.literal('feedback'), adviceId: Id, rating: FeedbackRating })
  .strict();

export const SessionEndMessage = z
  .object({ type: z.literal('session.end'), exportRequested: z.boolean() })
  .strict();

/** 拡張側の音量検出による発話中状態。SELF 発話中は大きなカード更新を抑える（SPEC §8-2）。 */
export const SpeakingStateMessage = z
  .object({
    type: z.literal('speaking.state'),
    source: CaptureSource,
    speaking: z.boolean(),
    atMs: z.number().nonnegative(),
  })
  .strict();

/**
 * 検証済みカードを画面に反映した通知（遅延計測の最終点 displayAck, SPEC §8-3）。
 * `at` はクライアント時計（参考値）。遅延の計算にはサーバーの受信時刻を使い、時計を混ぜない。
 */
export const AdviceDisplayedMessage = z
  .object({ type: z.literal('advice.displayed'), adviceId: Id, at: EpochMs })
  .strict();

/** クライアント側で破棄した音声区間（バックプレッシャー等, SPEC §6-3）。音声時刻（セッション開始からの ms）。 */
export const AudioGapReason = z.enum(['client_backpressure', 'capture_error']);
export type AudioGapReason = z.infer<typeof AudioGapReason>;
export const AudioGapMessage = z
  .object({
    type: z.literal('audio.gap'),
    source: CaptureSource,
    fromMs: z.number().nonnegative(),
    toMs: z.number().nonnegative(),
    reason: AudioGapReason,
  })
  .strict()
  .refine((g) => g.toMs >= g.fromMs, { message: 'toMs must be >= fromMs', path: ['toMs'] });

export const ClientMessage = z.union([
  HelloMessage,
  SessionStartMessage,
  SourceStateMessage,
  AnalysisPauseMessage,
  AnalysisResumeMessage,
  AdviceRequestMessage,
  CardPinMessage,
  CardUnpinMessage,
  FeedbackMessage,
  SessionEndMessage,
  SpeakingStateMessage,
  AdviceDisplayedMessage,
  AudioGapMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export type ClientMessageType = ClientMessage['type'];

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export const HelloAckMessage = z
  .object({
    type: z.literal('hello.ack'),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    serverVersion: z.string().max(32),
  })
  .strict();

export const PipelinesStatus = z
  .object({
    capture: z.object({ SELF: PipelineStatus, REMOTE: PipelineStatus }).strict(),
    stt: PipelineStatus,
    advice: PipelineStatus,
  })
  .strict();
export type PipelinesStatus = z.infer<typeof PipelinesStatus>;

export const StatusMessage = z
  .object({
    type: z.literal('status'),
    sessionId: Id.nullable(),
    lifecycle: SessionLifecycleState,
    mode: SessionMode.nullable(),
    /** 外部API（STT/LLM）へ実データを送信中か。 */
    externalSending: z.boolean(),
    storage: StoragePolicy,
    pipelines: PipelinesStatus,
    at: EpochMs,
  })
  .strict();

export const TranscriptSegmentMessage = z
  .object({
    type: z.literal('transcript.segment'),
    segmentId: Id,
    utteranceId: Id,
    source: AudioSource,
    streamGeneration: z.number().int().nonnegative(),
    text: z.string().max(5000),
    isFinal: z.boolean(),
    speechFinal: z.boolean(),
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
    revision: z.number().int().nonnegative(),
  })
  .strict();

export const AdviceCardMessage = z.object({ type: z.literal('advice.card'), card: AdviceCard }).strict();

export const AdviceInvalidatedMessage = z
  .object({ type: z.literal('advice.invalidated'), adviceId: Id, reason: AdviceInvalidationReason })
  .strict();

/** 表示固定の状態。固定中でも古いカードは reference + 警告（SPEC §4-2）。 */
export const PinStateMessage = z
  .object({
    type: z.literal('card.pin.state'),
    pinnedAdviceId: Id.nullable(),
    displayStatus: AdviceCardStatus.nullable(),
    warnings: z.array(AdviceWarning),
    hasNewerCard: z.boolean(),
  })
  .strict();

export const WarningCode = z.enum([
  'unverified_promise',
  'contradicts_fact',
  'free_explanation_repeated',
  'scope_expansion_before_check',
  'answer_skipped',
  'time_confusion',
  'stale_pinned_card',
  'budget_near_limit',
  'degraded_capture',
  'self_capture_while_meet_muted',
  'audio_dropped',
]);
export type WarningCode = z.infer<typeof WarningCode>;

/** 小さな注意（重大な未確認約束など）。カードとは別枠（SPEC §8-2）。 */
export const WarningMessage = z
  .object({
    type: z.literal('warning'),
    warningId: Id,
    code: WarningCode,
    message: z.string().min(1).max(200),
    evidenceUtteranceIds: z.array(Id).max(12),
    at: EpochMs,
  })
  .strict();

export const UsageMessage = UsageSnapshot.extend({ type: z.literal('usage') }).strict();

export const ErrorCode = z.enum([
  'unauthorized',
  'protocol_error',
  'invalid_message',
  'invalid_state',
  'not_configured',
  'rate_limited',
  'upstream_error',
  'timeout',
  'budget_exceeded',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorMessage = z
  .object({
    type: z.literal('error'),
    code: ErrorCode,
    /** 会話本文・顧客名・キーを含めない。 */
    message: z.string().max(300),
    recoverable: z.boolean(),
    requestId: Id.optional(),
  })
  .strict();

/**
 * セッション終了の確定通知（サーバー → 拡張）。終了処理（任意の出力）が終わった後に必ず1回送る。
 * exportPath は本人が出力を選んだ場合だけ非 null。reviewAvailableUntil 以降は振り返りを取得できない。
 */
export const SessionEndedMessage = z
  .object({
    type: z.literal('session.ended'),
    sessionId: Id,
    exportPath: z.string().min(1).max(1000).nullable(),
    reviewAvailableUntil: EpochMs,
  })
  .strict();

export const ServerMessage = z.discriminatedUnion('type', [
  HelloAckMessage,
  StatusMessage,
  TranscriptSegmentMessage,
  AdviceCardMessage,
  AdviceInvalidatedMessage,
  PinStateMessage,
  WarningMessage,
  UsageMessage,
  ErrorMessage,
  SessionEndedMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type ServerMessageType = ServerMessage['type'];

export type HelloMessage = z.infer<typeof HelloMessage>;
export type SessionStartMessage = z.infer<typeof SessionStartMessage>;
export type SourceStateMessage = z.infer<typeof SourceStateMessage>;
export type AdviceRequestMessage = z.infer<typeof AdviceRequestMessage>;
export type FeedbackMessage = z.infer<typeof FeedbackMessage>;
export type SessionEndMessage = z.infer<typeof SessionEndMessage>;
export type SpeakingStateMessage = z.infer<typeof SpeakingStateMessage>;
export type AdviceDisplayedMessage = z.infer<typeof AdviceDisplayedMessage>;
export type AudioGapMessage = z.infer<typeof AudioGapMessage>;
export type SessionEndedMessage = z.infer<typeof SessionEndedMessage>;
export type StatusMessage = z.infer<typeof StatusMessage>;
export type TranscriptSegmentMessage = z.infer<typeof TranscriptSegmentMessage>;
export type AdviceCardMessage = z.infer<typeof AdviceCardMessage>;
export type AdviceInvalidatedMessage = z.infer<typeof AdviceInvalidatedMessage>;
export type PinStateMessage = z.infer<typeof PinStateMessage>;
export type WarningMessage = z.infer<typeof WarningMessage>;
export type UsageMessage = z.infer<typeof UsageMessage>;
export type ErrorMessage = z.infer<typeof ErrorMessage>;

/** JSON テキストを安全にパース（例外を投げない）。 */
export function parseClientMessage(text: string): { ok: true; message: ClientMessage } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not_json' };
  }
  const r = ClientMessage.safeParse(raw);
  return r.success ? { ok: true, message: r.data } : { ok: false, error: r.error.issues[0]?.message ?? 'invalid' };
}

export function parseServerMessage(text: string): { ok: true; message: ServerMessage } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not_json' };
  }
  const r = ServerMessage.safeParse(raw);
  return r.success ? { ok: true, message: r.data } : { ok: false, error: r.error.issues[0]?.message ?? 'invalid' };
}
