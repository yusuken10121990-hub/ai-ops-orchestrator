import { z } from 'zod';

/** パイプラインの状態（SPEC §4-3）。「待機」を一括りにしない。 */
export const PipelineState = z.enum([
  'idle',
  'active',
  'waiting',
  'delayed',
  'error',
  'not_configured',
  'offline',
  'paused',
]);
export type PipelineState = z.infer<typeof PipelineState>;

/**
 * 状態の理由コード。無音・権限なし・API未設定・通信断などを区別できること（SPEC §4-3）。
 */
export const StatusReason = z.enum([
  // 音声取得
  'silence', // 取得はできているが無音
  'no_permission', // マイク/タブ取得の許可がない・取り消された
  'tab_closed',
  'track_ended',
  'device_changed',
  'source_lost',
  'self_capture_off', // ユーザーが「自分の音声取得OFF」を選択
  'degraded_single_source', // 片側のみ（ユーザーが選んだ縮退モード）
  'backpressure_drop', // 上限超過で古い音声を破棄
  // 外部API
  'not_configured', // APIキー未設定
  'disconnected', // 通信断
  'reconnecting',
  'auth_failed',
  'rate_limited',
  'timeout',
  'upstream_error',
  'invalid_output', // 不正JSON・スキーマ違反
  'budget_warning',
  'budget_exceeded',
  // スケジューラー/セッション
  'cooldown',
  'generating',
  'listening', // 相手の説明を聞く（助言不要）
  'user_paused',
  'session_ended',
  'offline_mode',
]);
export type StatusReason = z.infer<typeof StatusReason>;

export const PipelineStatus = z
  .object({
    state: PipelineState,
    reason: StatusReason.nullable(),
    /** epoch ms: この状態になった時刻 */
    since: z.number().int().nonnegative(),
  })
  .strict();
export type PipelineStatus = z.infer<typeof PipelineStatus>;

export const SessionLifecycleState = z.enum(['idle', 'consented', 'capturing', 'paused', 'ended']);
export type SessionLifecycleState = z.infer<typeof SessionLifecycleState>;

export const SessionMode = z.enum(['LIVE', 'OFFLINE']);
export type SessionMode = z.infer<typeof SessionMode>;

/** 保存設定（SPEC §13: 既定はメモリのみ、終了時に本人が選んだ場合だけ出力）。 */
export const StoragePolicy = z.enum(['memory_only', 'export_on_end']);
export type StoragePolicy = z.infer<typeof StoragePolicy>;
