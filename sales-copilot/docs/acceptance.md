# 受け入れ条件と自動テストの対応（SPEC §16-1）

2026-11-16 時点。全 18 項目に自動テストがある（`pnpm test` の Vitest、`pnpm build` の dist 検査、`pnpm test:e2e` のブラウザ自動化）。
会話品質（7〜14, 18）は単語一致ではなく「必須の判断」と「禁止する約束」で採点する（`packages/test-fixtures` の架空会話 + `fixtures-eval.test.ts`）。
**これは自動化での合格であり、実際の Meet・実 API での確認（SPEC §16-2）は別。** [manual-checklist.md](manual-checklist.md) を参照。

| # | 受け入れ条件 | テスト |
|---|---|---|
| 1 | interim 更新が重複発言にならない | `packages/domain/src/transcript-store.test.ts`（§16-1 #1）、`apps/extension/src/copilot/state.test.ts`（同じ segment の更新）、`scripts/e2e-integration.mjs`（画面の件数） |
| 2 | 「できます」→「できません」訂正で古い助言を無効化 | `packages/domain/src/transcript-store.test.ts`（#2）、`packages/domain/src/conversation-state.test.ts`（#2）、`apps/server/src/session-runtime.test.ts`（#2: advice.invalidated）、`packages/test-fixtures/src/index.test.ts`（再生台本に訂正ケース） |
| 3 | 古い LLM 応答が新しい発言への助言を上書きしない | `packages/domain/src/advice-scheduler.test.ts`（#3・revision/seq）、`apps/extension/src/copilot/state.test.ts`（返却順の逆転） |
| 4 | 片側欠落・UNKNOWN・話者重複を黙って確定しない | `packages/domain/src/transcript-store.test.ts`（#4）、`packages/domain/src/conversation-state.test.ts`（#4）、`packages/coaching/src/validate.test.ts`（縮退時は根拠を下げる） |
| 5 | 停止後に音声送信・LLM 要求が発生しない | `packages/domain/src/session-lifecycle.test.ts`（#5）、`packages/domain/src/advice-scheduler.test.ts`（#5）、`apps/server/src/session-runtime.test.ts`（#5）、`apps/server/src/offline-e2e.test.ts`（#5）、`apps/extension/src/offscreen/capture-controller.test.ts`（停止でトラック・WS・タイマー解放）、`scripts/e2e-integration.mjs`（一時停止で文字起こし停止・終了後に実行中セッションなし） |
| 6 | 表示固定・解除・期限切れが矛盾しない | `packages/domain/src/pin.test.ts`（#6）、`apps/extension/src/copilot/components/render.test.tsx`（固定中の新カード）、`apps/extension/scripts/e2e-smoke.mjs`（固定ショートカット） |
| 7 | 「便利そう」だけで契約クロージングしない | `packages/coaching/src/fixtures-eval.test.ts`（f07-benri-only）、`packages/coaching/src/triggers.test.ts`、`packages/coaching/src/validate.test.ts`（contract_discussion の格下げ） |
| 8 | 価格未確認なら金額を発明しない | `packages/coaching/src/fixtures-eval.test.ts`（f08 / f08b）、`packages/coaching/src/validate.test.ts`（数値の出所）、`apps/server/src/session-runtime.test.ts`（#8 承認済み版のみ適用） |
| 9 | 解約条件が矛盾したら確認を促す | `packages/coaching/src/fixtures-eval.test.ts`（f09）、`packages/coaching/src/validate.test.ts`（承認済み条件と矛盾 → 確認） |
| 10 | 自社更新の質問に内製か外注かを迫らない | `packages/coaching/src/fixtures-eval.test.ts`（f10）、`packages/coaching/src/validate.test.ts`（二択の禁止） |
| 11 | 連絡不要・見送りを尊重 | `packages/coaching/src/fixtures-eval.test.ts`（f11 / ctx-kentou-declined）、`packages/coaching/src/validate.test.ts`（見送り → 丁寧な締め） |
| 12 | 3D データや精度について未検証の保証をしない | `packages/coaching/src/fixtures-eval.test.ts`（f12）、`packages/coaching/src/validate.test.ts`（tech_spec 無しの可否断定を止める） |
| 13 | 待ち時間と実作業時間、1人当たりと全社を混同しない | `packages/coaching/src/fixtures-eval.test.ts`（f13）、`packages/coaching/src/triggers.test.ts` |
| 14 | 悪意ある会話が設定やシステム指示を変更しない | `packages/coaching/src/fixtures-eval.test.ts`（f14-prompt-injection）、`packages/coaching/src/engine.test.ts`（注入文はデータ扱い・指示/条件を変えない） |
| 15 | API キー・トークン・会話本文が配布物や通常ログへ混入しない | `apps/server/src/offline-e2e.test.ts`（#15 ログ検査）、`apps/server/src/units.test.ts`（redact）、`packages/providers/src/*.test.ts`（キーを URL・エラーに出さない）、`apps/extension/scripts/check-dist.mjs`（`pnpm build` 時に dist を検査）、`scripts/e2e-integration.mjs`（実サーバーのログに本文・顧客名・目的・ペアリングコードが無い） |
| 16 | API 未設定・429・認証失敗・タイムアウト・不正 JSON で安全に停止/縮退 | `apps/server/src/session-runtime.test.ts`（#16）、`packages/coaching/src/engine.test.ts`、`packages/providers/src/anthropic-advice-llm.test.ts`、`packages/providers/src/deepgram.test.ts` |
| 17 | 再接続と重複 final で課金・状態更新・助言が重複しない | `packages/domain/src/transcript-store.test.ts`（#17）、`packages/domain/src/usage-meter.test.ts`（#17）、`packages/domain/src/session-lifecycle.test.ts`（#17）、`apps/server/src/session-runtime.test.ts`（#17） |
| 18 | 安全な文脈では次回確認の一言を実際に提案する | `packages/coaching/src/fixtures-eval.test.ts`（f18 / f08b / ctx-kentou-unresolved・文脈あり/なしで判断が変わる）、`scripts/e2e-integration.mjs`（「次の約束」ボタン → 応答または「確認が先」） |

## 結合で追加した確認（2026-11-16）

| 内容 | テスト |
|---|---|
| `session.ended`（出力先・保持期限）、出力は頼んだときだけ | `apps/server/src/offline-e2e.test.ts`、`apps/extension/src/offscreen/capture-controller.test.ts`、`render.test.tsx`、`scripts/e2e-integration.mjs` |
| `advice.displayed` → 遅延統計の表示ステップ（サーバー時計） | `apps/server/src/units.test.ts`、`offline-e2e.test.ts`、`scripts/e2e-integration.mjs` |
| `audio.gap`（`source.state` の流用を廃止） | `capture-controller.test.ts`、`offline-e2e.test.ts`、`packages/contracts/src/contracts.test.ts` |
| OFFLINE 台本の選択・一覧、Anthropic は「許可」かつ「本人が選択」のときだけ | `offline-e2e.test.ts`、`units.test.ts`、`scripts/e2e-integration.mjs` |
| HTTP 応答を contracts のスキーマで検証（両側） | `contracts.test.ts`、`apps/extension/src/shared/api.test.ts`、`offline-e2e.test.ts` |
| `PAIRING_CODE_FOR_TEST` は `NODE_ENV=test` 以外で起動拒否 | `units.test.ts` |
| Origin なし GET（Chrome 拡張ページの実挙動）はトークンだけで判定、WS は Origin 必須 | `apps/server/src/app.test.ts`、`scripts/e2e-integration.mjs` |
