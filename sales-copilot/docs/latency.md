# 遅延計測の方法（SPEC §8-3）

目標（開発目標・保証ではない）: 「相手の発話終了推定 → 助言の送信」p50 ≤ 3 秒、p95 ≤ 5 秒。

## 時計

すべてサーバーの `Date.now()`（epoch ms）で測る。クライアントとサーバーの時計は混ぜない。
音声時刻（セッション開始からの音声 ms）は、各音声フレームがサーバーに届いた時刻との対応表で壁時計へ写像する。

## 計測点（`apps/server/src/latency.ts`）

| 点 | 定義 |
|---|---|
| speechEnd | 発話終了推定。Deepgram の `speech_final`（または `UtteranceEnd`）が示す発話終端の音声時刻を、その音声を含むフレームがサーバーに届いた時刻へ写像した値。OFFLINE は受信時刻。クライアント側の取得・送信遅延（フレーム長 100〜250ms 程度）は含まない＝実際の発話終了より少し後になる |
| sttFinal | その final をサーバーが受信した時刻 |
| requested | スケジューラーが生成を開始した時刻 |
| validated | 生成結果のスキーマ・内容検証が終わった時刻 |
| sent | 検証済み `advice.card` を WS へ書き込んだ時刻 |
| displayAck | 拡張機能が検証済みカードを画面に反映した後に送る `advice.displayed { adviceId, at }` を、**サーバーが受信した時刻**。`at`（クライアント時計）は参考値として受けるだけで計算に使わない（時計を混ぜない）。1カード1回、未知の adviceId は無視 |

集計（セッションごと、直近 2000 件、nearest-rank の p50/p95/max）:

- `speechEndToSttFinalMs`（STT の確定待ち。endpointing 300ms を含む）
- `speechEndToSentMs`（主指標）/ `sttFinalToSentMs`
- `requestedToValidatedMs`（LLM＋検証）/ `validatedToSentMs`
- `sentToDisplayedMs`（送信 → 表示報告の受信。WS の往復＋描画を含むので、片道より少し長めに出る）/
  `speechEndToDisplayedMs`（主指標の画面反映版）
- 件数: eligible（自動契機・手動ボタンで生成対象になった数）/ started / displayed（= 送信数）/ displayAcked（表示報告数）/
  noAdvice（`action:none`）/ discarded（中止・古い文脈・上書き）/ timeout / failed / fallback

型は `@sales-copilot/contracts` の `LatencyStats`（HTTP 応答と同じスキーマ）。

## 取得方法

- 実行中: `GET /sessions/active/latency`（要トークン）
- 終了後: `GET /sessions/:id/review` の `latency`（保持期間内）、エクスポートした場合は JSON / Markdown に含まれる

## 注意

- 自動助言はクールダウン（既定 6 秒）中だと待機するため、その分は speechEnd→sent に含まれる（実際の体感どおり）。
- 手動ボタンの生成は契機発話が無いので requested→validated / validated→sent だけに入る。
- 実 API での p50/p95 は未計測（キー未設定）。OFFLINE のルールベース結果は外部遅延を含まないので目標評価には使わない。
  参考: `pnpm test:e2e`（Chromium・同一PC・OFFLINE）で sentToDisplayed の p50 は数ms〜十数ms 程度だった（環境依存・保証ではない）。
