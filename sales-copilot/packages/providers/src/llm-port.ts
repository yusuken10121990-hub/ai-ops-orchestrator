/**
 * 助言 LLM のポートは @sales-copilot/coaching が正（AdviceLlm / AdviceLlmError）。
 * providers はその実装（AnthropicAdviceLlm）を提供するだけなので、型とエラークラスは再エクスポートする
 * （AdviceEngine 側の instanceof 判定と一致させるため、独自定義しない）。
 */
export {
  AdviceLlmError,
  isAdviceLlmError,
  type AdviceLlm,
  type AdviceLlmRequest,
  type AdviceLlmResponse,
  type AdviceErrorKind as AdviceLlmErrorKind,
} from '@sales-copilot/coaching';
