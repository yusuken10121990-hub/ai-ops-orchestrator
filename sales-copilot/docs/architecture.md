# 構成とデータの流れ

ローカル優先のモジュラーモノリス（SPEC §5）。外部へ出るのは STT（Deepgram）と助言生成（Claude）だけで、どちらもサーバー経由。
拡張機能は API キーを持たず、127.0.0.1 のローカルサーバーとだけ通信する。

```
[Meet タブ] ──(本人が拡張アイコンを押す)──▶ [service worker] 対象タブを記録・tabCapture の streamId を取得
                                                   │
                                                   ▼
[offscreen document]  会議タブ音声(REMOTE) ─┬─▶ スピーカー（相手の声を聞こえるように1回だけ再生）
                      自分のマイク(SELF)    ─┴─▶ AudioWorklet: モノラル化 → 16kHz 実リサンプリング → PCM16 → 200ms フレーム
                                                   │ WebSocket（hello でトークン → session.start → バイナリ音声）
                                                   ▼
[ローカルサーバー 127.0.0.1]  SessionRuntime
   音声フレーム ─▶ SpeechRecognizer（系統ごと: Deepgram / OFFLINE は再生スクリプト）
   STT 結果 ─▶ TranscriptStore（interim 統合・重複 final 排除・訂正で依存助言を無効化）
            ─▶ ConversationState（直近 60〜120 秒 + 根拠ID付き構造化メモ）
            ─▶ 自動契機（coaching.shouldTriggerAuto）/ 手動ボタン
            ─▶ AdviceScheduler（クールダウン・実行中1つ・待機は最新1つ・古い結果は捨てる）
            ─▶ AdviceEngine（プロンプト組立 → Claude → 表示前検証 → 不合格は有限再試行か安全な「確認」へ）
            ─▶ 検証済み advice.card だけ送信（原子的）。期限・話題変化・訂正で reference / invalidated
   UsageMeter（STT 秒・実 usage・上限 80% 警告 / 100% 停止）、LatencyTracker（発話終了→表示）
   SQLite: 承認済み条件と履歴・使った条件の版・最小フィードバック（会話本文は保存しない）
                                                   │
                                                   ▼
[copilot ウィンドウ（本人だけ）] 今の一手 / 次に言う一言 / 今は言わない、状態バー、操作ボタン → advice.displayed を返す
[設定画面] サーバーURL・ペアリング・マイク許可・承認済み条件の編集
```

## 責任の分け方

| 責任（SPEC §5） | 場所 |
|---|---|
| AudioCapture | `apps/extension`（service worker: 対象タブ・streamId / offscreen: MediaStream・AudioWorklet・送信・バックプレッシャー） |
| SpeechRecognition | `packages/providers`（Deepgram アダプター・偽認識器）、`apps/server/src/replay.ts`（OFFLINE 再生） |
| ConversationState | `packages/domain`（TranscriptStore / ConversationState）、`packages/coaching`（メモ候補抽出） |
| AdviceGeneration | `packages/coaching`（プロンプト・エンジン・表示前検証・ルールベース OFFLINE）、`packages/providers`（Claude アダプター） |
| AdviceScheduling | `packages/domain`（AdviceScheduler / PinController） |
| CommercialPolicy | `apps/server/src/store.ts`（承認済み条件の版管理）、`packages/coaching`（条件と矛盾・未確認約束の検証） |
| SessionLifecycle | `packages/domain`（SessionLifecycle / UsageMeter）、`apps/server/src/session-runtime.ts`（停止・後始末） |
| UI | `apps/extension/src/copilot`・`src/options` |
| 境界の型 | `packages/contracts`（WS メッセージ・音声フレーム・HTTP 応答。両側で Zod 検証） |

## 終了時の流れ

拡張「終了」→ 未確定の欠落区間を `audio.gap` → `session.end { exportRequested }` → 拡張は取得を即停止 →
サーバーは STT 接続・生成・待機・タイマー・再生を止め、（選んだ場合だけ）`exports/` へ JSON + Markdown を書き、
`status(ended)` → `usage` → **`session.ended { exportPath, reviewAvailableUntil }`** → 拡張が WS を閉じる。
振り返りデータは `SESSION_RETENTION_MS`（既定 10 分）だけメモリに残り、その後消える。
