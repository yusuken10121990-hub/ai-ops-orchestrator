import { z } from 'zod';
import { AudioSource, CaptureSource } from './audio';
import { AdviceCard, AdviceCardStatus, AdviceInvalidationReason, AdviceWarning, ManualAdviceKind } from './advice';
import { AppliedFactRef } from './facts';
import { PipelineStatus, SessionLifecycleState, SessionMode, StatusReason, StoragePolicy } from './status';
import { UsageSnapshot } from './usage';

export const PROTOCOL_VERSION = 1 as const;

const Id = z.string().min(1).max(128);
const EpochMs = z.number().int().nonnegative();

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
