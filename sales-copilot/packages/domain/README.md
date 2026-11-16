# packages/domain

IO を持たない純粋な TypeScript のドメインロジック。文字起こしの interim/final 統合と重複排除・訂正時の助言無効化（TranscriptStore）、直近ウィンドウと根拠付き構造化メモ（ConversationState）、助言生成の実行数・クールダウン・破棄・古さ判定（AdviceScheduler）、表示固定（PinController）、セッション状態機械と停止後ガード（SessionLifecycle）、使用量・費用・上限判定（UsageMeter）を提供する。時刻は `Clock` を注入するのでテストで決定的に動く。
