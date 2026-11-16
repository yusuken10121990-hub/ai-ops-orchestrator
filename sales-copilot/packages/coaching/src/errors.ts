import type { AdviceErrorKind } from './types';

/**
 * プロバイダーアダプターが投げる分類済みエラー。
 * message には API キー・会話本文を含めないこと（通常ログへ出る可能性がある）。
 */
export class AdviceLlmError extends Error {
  constructor(
    public kind: AdviceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AdviceLlmError';
  }
}

export function isAdviceLlmError(e: unknown): e is AdviceLlmError {
  return e instanceof AdviceLlmError;
}

/** 外部 signal による中止で engine.generate が投げるエラーか。 */
export function isAbortError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'name' in e &&
    ((e as { name: unknown }).name === 'AbortError' || (e instanceof AdviceLlmError && e.kind === 'aborted'))
  );
}

export function makeAbortError(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  if (r instanceof Error && r.name === 'AbortError') return r;
  const e = new Error('advice generation aborted');
  e.name = 'AbortError';
  return e;
}
