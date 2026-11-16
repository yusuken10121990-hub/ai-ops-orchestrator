# 外部プロバイダー（STT / 助言 LLM）

確認日: **2026-11-16**（SPEC §18 の一次資料確認）。実 API の呼び出しはこの確認では行っていない（キー未設定）。
実 API での動作確認は「未検証」として扱う（下の「未検証事項」）。

## 1. Deepgram（音声認識・ストリーミング）

| 項目 | 採用値 | 出典（2026-11-16 確認） |
|---|---|---|
| エンドポイント | `wss://api.deepgram.com/v1/listen` | API Reference: Listen (streaming) |
| 認証 | `Authorization: Token <DEEPGRAM_API_KEY>` ヘッダー（URL に載せない） | 同上（Authorization ヘッダー） |
| モデル | `DEEPGRAM_MODEL`（既定 `nova-3`） | Models & Languages Overview: nova-3 は `ja` を monolingual / multilingual の両方で掲載 |
| 言語 | `DEEPGRAM_LANGUAGE`（既定 `ja`。日本語の地域コードは掲載なし） | 同上 |
| 音声形式 | `encoding=linear16`, `sample_rate=16000`, `channels=1` | Listen リファレンス（linear16 / channels 既定 1） |
| interim | `interim_results=true` | Endpointing & Interim Results |
| endpointing | `DEEPGRAM_ENDPOINTING_MS`（既定 300。`false` で無効。API 既定は 10ms） | 同上（「300ms の無音で speech_final」例、既定 10） |
| UtteranceEnd | `DEEPGRAM_UTTERANCE_END_MS`（既定 1000 = 公式最小。`off` で無効）。`interim_results=true` 必須 | Utterance End ドキュメント |
| smart_format | `DEEPGRAM_SMART_FORMAT`（既定 true。punctuation を含む） | Smart Format（「All available languages」。日本語での挙動は明記なし） |
| punctuate | `DEEPGRAM_PUNCTUATE`（既定 false。smart_format が有効なら不要と公式記載） | 同上 |
| KeepAlive | 送信が 4 秒ない間 `{"type":"KeepAlive"}`（公式: 3〜5秒ごと、10秒で NET-0001 切断） | KeepAlive ドキュメント |
| 終了 | `{"type":"CloseStream"}` 送信後に close | 同上 |

結果メッセージの扱い（`packages/providers/src/deepgram.ts`）:

- `Results`: `start`/`duration`（接続開始からの秒）・`is_final`・`speech_final`・`from_finalize`・`channel.alternatives[0].transcript`
  を読む。`speech_final` は `is_final=true` のときだけ有効とする（区間 final と発話終了は別）。
- `UtteranceEnd`: `last_word_end`（秒）。`-1` は既に final 済みのため無視（公式記載）。
- 時刻はサーバー側で「その接続で送った音声の累積時間」→「セッション音声時刻」に区分線形で写像する
  （欠落区間があってもずれない。`StreamTimeMap`）。
- 区間キー: `source|streamGeneration|startMs`。interim→final は同じキーの区間を更新する（重複排除は domain の TranscriptStore）。

接続管理:

- 系統（SELF / REMOTE）ごとに 1 接続。最初の音声フレームで接続（起動時・セッション開始時には接続しない）。
- 切断時は `streamGeneration` を +1 して指数バックオフ（250ms 起点・上限 5 秒・最大 6 回、429 は 4 倍の起点）。
  401/403（アップグレード時）・その他 4xx・close 1008 は致命的として再接続しない。
- 未送信キューは系統ごとに `AUDIO_MAX_QUEUE_MS`（既定 2000ms）まで。超過分は古い順に破棄し、
  欠落区間（`audio_dropped`）として記録・警告する。復旧後に古い音声を大量再送しない。
- ソケット送信バッファが 2 秒分を超えたら送らずに待つ（バックプレッシャー）。
- 使用量（STT 秒）は「実際に送ったフレーム」を `(source, frameGeneration, sequence)` で一度だけ計上。

失敗分類: `not_configured` / `auth_failed` / `rate_limited` / `network` / `protocol`（UI の理由コードへ変換）。
API キーはログ・エラー文・URL に出さない（テストで確認）。

ws パッケージ: `ws@8.23.0`。

## 2. Claude API（助言生成）

| 項目 | 採用値 |
|---|---|
| SDK | `@anthropic-ai/sdk@1.8.0`（API version ヘッダー `2026-10-21` を SDK が送る） |
| モデル | `ANTHROPIC_MODEL`（既定 `claude-haiku-5-5`。.env.example の既定値。低遅延モデル） |
| 呼び出し | `messages.create`（非ストリーミング。未検証の途中文を UI に出さないため） |
| 構造化出力 | `output_config.format = { type: "json_schema", schema }`（schema は coaching の `adviceOutputJsonSchema()`） |
| effort | `ANTHROPIC_EFFORT`（既定 `low`。`none` で送らない）。`thinking` は送らない（モデル既定。Haiku 5.5 / Opus 5.5 では disabled 指定が 400 になる場合があるため） |
| temperature 等 | 送らない（API version 2026-10-21 では 400） |
| タイムアウト | `ADVICE_TIMEOUT_MS`（既定 6000）。SDK 内部リトライは 0、再試行は AdviceEngine が有限回（`ADVICE_MAX_RETRIES`、既定 1） |

エラー変換（`mapAnthropicError`）:

| SDK 例外 | kind |
|---|---|
| `APIUserAbortError` / 呼び出し側 abort | `aborted` |
| `APIConnectionTimeoutError` / 408 / 504 | `timeout` |
| `APIConnectionError` | `network` |
| 401 `AuthenticationError` / 403 `PermissionDeniedError` | `auth_failed` |
| 429 `RateLimitError` / 529 `OverloadedError` | `rate_limited` |
| `stop_reason: max_tokens` / 空応答 | `invalid_json`（途中の JSON を表示しない） |
| `stop_reason: refusal` / その他 API エラー | `unknown` |

usage は応答の `usage.input_tokens` / `output_tokens` のみ（無ければ null。推測しない）。

## 3. テストでの扱い（実 API は呼ばない）

- Deepgram: 公式リファレンスの形に沿った架空 JSON フィクスチャでパース・正規化を検証。WebSocket は差し替え可能な
  `wsFactory` で偽ソケットを使い、遅延接続・認証ヘッダー・KeepAlive・再接続（世代+1）・キュー上限・401/429・stop を検証。
- Claude: SDK の `fetch` を差し替え、送信ボディ（model / output_config / max_tokens）と 401/403/429/529/500/400・
  ネットワーク断・タイムアウト・abort・max_tokens 切れ・refusal・usage 欠落の変換を検証。

## 4. 未検証事項（実機・実 API が必要）

- 実際の Deepgram nova-3 + `ja` での認識精度・interim の更新粒度・`smart_format` の日本語での効果。
- 実接続での close コード・エラーメッセージの実際の形（リファレンスは close コード番号を列挙していない）。
- `claude-haiku-5-5` + 構造化出力での実遅延（p50/p95）と、`effort=low` で出力品質が足りるか。
- 価格表（`PRICE_*`）は未設定。設定する場合は出典と確認日を必ず記入する（未設定なら金額は表示しない）。
