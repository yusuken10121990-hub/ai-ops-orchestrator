# apps/server

ローカル Fastify サーバー（127.0.0.1 のみ bind）。ペアリングと期限付きセッショントークンで拡張機能を認証し、WebSocket で音声フレームと制御メッセージを受ける。`@sales-copilot/domain` の SessionLifecycle / TranscriptStore / ConversationState / AdviceScheduler / UsageMeter / PinController を組み立て、`@sales-copilot/providers` 経由で Deepgram（STT）と Claude（助言）を呼ぶ。APIキーは環境変数のみで扱い、会話本文・顧客名・トークンを通常ログへ出さない。承認済み条件などの設定は SQLite（node:sqlite）、会話は既定でメモリのみ。

```
pnpm start                                  # = pnpm --filter @sales-copilot/server start（tsx src/index.ts）
pnpm --filter @sales-copilot/server dev     # tsx watch
```

起動すると端末にペアリングコード（6桁・10分・1回限り）が表示される。`.env`（ワークスペース直下）があれば読む。
ペアリングの記録（トークンの SHA-256 ハッシュのみ）は本人用フォルダの `tokens.json` に保存するので、再起動しても再ペアリング不要。
端末なし（自動起動）のときは `pnpm pair` でコードを出す。詳細は [docs/security.md](../../docs/security.md)。
node:sqlite の ExperimentalWarning が 1 行出るが動作に影響はない（Node 22）。

## HTTP

| メソッド・パス | 認証 | 内容 |
|---|---|---|
| `GET /health` | なし（Host 検査のみ） | `{ ok, version }` |
| `POST /pair` | Origin = `chrome-extension://<extensionId>` | `{ pairingCode, extensionId, clientName }` → `PairingResponse` |
| `GET /config/status` | settings | プロバイダー設定の有無・モデル名・LIVE/OFFLINE 可否・OFFLINE で Anthropic を選べるか（秘密は返さない） |
| `GET /offline/scripts` | session | OFFLINE 再生スクリプトの一覧（id・タイトル・説明・長さ。本文は返さない）と既定 id |
| `GET /facts` / `POST /facts` | settings | 承認済み条件の一覧 / 追加（必ず unverified・version 1） |
| `PATCH /facts/:id` | settings | 編集。内容が変われば承認失効（unverified, version+1）。進行中セッションの該当カードは無効化 |
| `POST /facts/:id/approve` | settings | `{ version }`（表示中の版と一致必須）→ approved・approvedAt・version+1 |
| `POST /facts/:id/revoke` | settings | 承認取消（revoked, version+1） |
| `GET /facts/:id/history` | settings | 変更履歴 |
| `GET /sessions/:id/review` | session | 終了後の振り返り（保持期間内のみ）: 使用量・遅延・適用条件の版・エクスポート先・本文・音声欠落区間 |
| `GET /sessions/active/latency` | session | 実行中セッションの遅延統計 |

認証は `Authorization: Bearer <token>`。URL クエリにトークンを付けたリクエストは 400。応答の形は全て
`@sales-copilot/contracts` の `http.ts`（返す前に同じスキーマで検証）。詳細は [docs/security.md](../../docs/security.md)。

## WebSocket `/ws`

1. Origin（ペアリング済み拡張）と Host を検査してアップグレード。
2. 最初のメッセージが `hello`（token 入り）でなければ切断（4401 不正 / 4408 タイムアウト 5 秒）。成功で `hello.ack`。
3. `session.start`（`consentConfirmed: true` 必須・適用条件は承認済みかつ現行版のみ）でパイプライン開始。
   - LIVE: キー未設定なら `status` の stt / advice を `not_configured` にし `error(not_configured)` を送る（無言の待機にしない）。
   - OFFLINE: `offlineScriptId`（無ければ `OFFLINE_SCRIPT`、それも無ければ先頭）を `OFFLINE_REPLAY_SPEED` 倍速で再生。
     存在しない id は `error(invalid_message)` で開始しない。助言は「本人が `offlineUseAnthropic: true` を選んだ」かつ
     `OFFLINE_USE_ANTHROPIC=1` かつキーありの場合だけ Claude、それ以外はルールベース（「AIではありません」と明示、外部送信なし）。
     OFFLINE では実マイクの `speaking.state` を無視する（再生している会話とは無関係のため。結合テストで発見）。
   - LIVE で `offlineScriptId` / `offlineUseAnthropic` を送ると `error(invalid_message)`。
4. バイナリフレーム = contracts の音声フレーム。系統ごとに遅延接続の STT へ送る（未送信 2 秒超は古い順に破棄・欠落記録・`warning(audio_dropped)`）。
5. STT 結果 → `transcript.segment`（interim は同じ segment を更新）→ 会話状態・構造化メモ → 自動契機 → スケジューラー →
   助言エンジン（AbortSignal 付き）→ 検証済みカードだけ `advice.card`。訂正・条件変更で `advice.invalidated`、期限切れ・話題変化は
   status を更新したカードを再送。表示固定は `card.pin.state`。`speaking.state`(SELF) で大きな更新を保留。
6. `analysis.pause` / `analysis.resume` / `session.end`（`exportRequested`）/ WS 切断で STT 接続・生成・待機・タイマーを停止。
   終了後は何も外部へ送らない。終了処理（任意の出力）の最後に `session.ended { sessionId, exportPath, reviewAvailableUntil }` を1回送る。
   `usage` は `USAGE_INTERVAL_MS` ごと。
7. `advice.displayed { adviceId, at }` → 遅延統計の表示ステップ（サーバー受信時刻で計測）。`audio.gap { source, fromMs, toMs, reason }` →
   欠落区間として記録（振り返り・出力に含む）し、その系統を「遅延」表示にする。

## 環境変数（全て `.env.example` にコメント付きで記載。以下は主に .env.example の既定値の補足）

| 変数 | 既定 | 用途 |
|---|---|---|
| `ALLOW_NON_LOOPBACK` | 未設定 | `1` で非ループバック bind を許可（通常は使わない） |
| `ALLOWED_EXTENSION_ID` | 未設定 | 許可する拡張機能 ID を固定 |
| `DEEPGRAM_ENDPOINTING_MS` | 300 | `false` で無効 |
| `DEEPGRAM_UTTERANCE_END_MS` | 1000 | `off` で無効 |
| `DEEPGRAM_SMART_FORMAT` / `DEEPGRAM_PUNCTUATE` | true / false | |
| `ANTHROPIC_MODEL` | claude-haiku-5-5 | 自動カード（発言ごと・低遅延）用のモデル |
| `ANTHROPIC_MANUAL_MODEL` | claude-sonnet-5-5 | 手動ボタン（切り返し・次に聞く・次の約束・クロージング）用のモデル。押したときだけ呼ぶ |
| `ANTHROPIC_EFFORT` | low | `low`/`medium`/`high`/`none`（両モデル共通） |
| `ADVICE_TIMEOUT_MS` / `ADVICE_MANUAL_TIMEOUT_MS` | 6000 / 15000 | 自動カード / 手動ボタン1回の生成の上限 |
| `PRICE_LLM_MANUAL_INPUT_PER_MTOK` / `PRICE_LLM_MANUAL_OUTPUT_PER_MTOK` | 未設定 | 手動用モデルの単価（出典・確認日は `PRICE_SOURCE` / `PRICE_CHECKED_DATE`）。別モデルで未設定なら、手動ボタン使用後は金額を出さない |
| `ADVICE_MAX_RETRIES` | 1 | 不正 JSON 等の再試行（最大 3） |
| `AUDIO_MAX_QUEUE_MS` | 2000 | 系統ごとの未送信音声上限 |
| `SESSION_RETENTION_MS` | 600000 | 終了後のメモリ保持上限 |
| `SESSION_TOKEN_TTL_DAYS` / `PAIRING_CODE_TTL_MS` / `PAIRING_MAX_ATTEMPTS` | 期限なし（空 または 0。1〜400 で日数・使うたびに延長） / 10min / 5 | 旧 `SESSION_TOKEN_TTL_MS` は無視（警告のみ） |
| `SESSION_RESUME_GRACE_MS` | 60000 | 拡張との接続が切れたとき同じ商談を保持する時間。0 = 切れたら即終了 |
| `USER_DATA_DIR` / `TOKEN_STORE_FILE` / `LOG_FILE` | `%LOCALAPPDATA%\ZEROSYS-SalesCopilot` / `tokens.json` / なし | ペアリング記録・`pnpm pair` 用の秘密・自動起動時のログ |
| `OFFLINE_SCRIPT` / `OFFLINE_REPLAY_SPEED` / `OFFLINE_USE_ANTHROPIC` | 先頭 / 1 / 未設定 | `OFFLINE_USE_ANTHROPIC=1` は「許可」。使うのは開始時に本人が選んだときだけ |
| `PAIRING_CODE_FOR_TEST` | 未設定 | 自動テスト専用の固定コード。`NODE_ENV=test` 以外で設定されていると起動拒否 |
| `DATA_DIR` / `EXPORT_DIR` | `data` / `exports` | ワークスペース直下からの相対 |
| `USAGE_INTERVAL_MS` / `LOG_LEVEL` | 5000 / info | |

遅延計測は [docs/latency.md](../../docs/latency.md)、プロバイダーの確認内容は [docs/providers.md](../../docs/providers.md)。
