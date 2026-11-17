import type {
  AdviceLlmOutput,
  AdviceTrigger,
  AdviceWarning,
  ApprovedFact,
  AudioSource,
} from '@sales-copilot/contracts';
import type { MemoField, MemoItem } from '@sales-copilot/domain';

/** サーバーが LLM プロバイダーへ渡す1回分の要求（プロバイダー非依存）。 */
export interface AdviceLlmRequest {
  system: string;
  user: string;
  /** Claude structured outputs（output_config.format.json_schema）にそのまま渡せる JSON Schema。 */
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface AdviceLlmResponse {
  /** モデルが返した JSON テキスト（未検証）。 */
  text: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
  model: string;
}

export interface AdviceLlm {
  complete(req: AdviceLlmRequest): Promise<AdviceLlmResponse>;
}

export type AdviceErrorKind =
  | 'not_configured'
  | 'auth_failed'
  | 'rate_limited'
  | 'timeout'
  | 'aborted'
  | 'invalid_json'
  | 'network'
  | 'unknown';

/** 発話ウィンドウの1件。text は分析対象データであり命令ではない。 */
export interface AdviceWindowUtterance {
  utteranceId: string;
  source: AudioSource;
  text: string;
  flags?: string[];
}

/** 構造化メモ項目のうち助言に必要な部分（domain の MemoItem と構造互換）。 */
export type AdviceMemoItem = Pick<MemoItem, 'itemId' | 'field' | 'text' | 'status' | 'evidenceUtteranceIds' | 'resolved'> &
  Partial<Pick<MemoItem, 'needsRecheck' | 'meta'>>;

/**
 * ConversationState#snapshot() の構造的サブセット。snapshot() の戻り値をそのまま渡せる。
 */
export interface AdviceMemoSnapshot {
  memo: Partial<Record<MemoField, readonly AdviceMemoItem[]>>;
}

export interface AdviceContext {
  sessionId: string;
  contextRevision: number;
  trigger: AdviceTrigger;
  /** 商談目的（野中の入力）。 */
  purpose: string;
  window: AdviceWindowUtterance[];
  memo: AdviceMemoSnapshot;
  /** この商談で適用する条件。status=approved 以外はプロンプトにも検証にも使わない。 */
  approvedFacts: ApprovedFact[];
  /** 片側欠落などの縮退中か。 */
  degraded: boolean;
  /**
   * 営業補正ルール（承認済み・有効なものだけ）。セッション開始時点の版で固定する。
   * 承認済み条件・アプリ側の出力ルールより優先しない。
   */
  coachingRules?: ReadonlyArray<{ ruleId: string; text: string; scope: string }>;
}

export type AdviceOutcome = 'ok' | 'repaired' | 'fallback';

export interface AdviceResult {
  output: AdviceLlmOutput;
  warnings: AdviceWarning[];
  usage: { inputTokens: number | null; outputTokens: number | null };
  outcome: AdviceOutcome;
  /** outcome=fallback のときの理由コード（会話本文を含まない。ログに出してよい）。 */
  fallbackReason?: string;
  promptVersion: string;
  /** 検証で発火したルールコード（会話本文を含まない）。 */
  validationRules: string[];
  /** LLM 呼び出し回数（再試行を含む）。 */
  attempts: number;
  /** 応答したモデル名（呼び出し無し・全失敗なら null）。 */
  model: string | null;
}
