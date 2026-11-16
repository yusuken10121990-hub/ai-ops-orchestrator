# packages/providers

外部 API の差し替え可能なアダプター層。

- `AnthropicAdviceLlm`（`@sales-copilot/coaching` の `AdviceLlm` 実装）: Claude Messages API の構造化出力
  （`output_config.format: json_schema`）。非ストリーミング・SDK 内部リトライなし。401/403→`auth_failed`、429/529→`rate_limited`、
  タイムアウト→`timeout`、abort→`aborted`、max_tokens 切れ→`invalid_json`。実 usage を返す（無ければ null）。
- `SpeechRecognizer` インターフェースと `DeepgramStreamingRecognizer`（`wss://api.deepgram.com/v1/listen`、
  `Authorization: Token` ヘッダー、linear16/16kHz/mono、interim・endpointing・utterance_end_ms）。系統ごと 1 接続・遅延接続・
  KeepAlive・世代つき再接続（有界バックオフ）・有界キュー（古い音声を再送しない）・失敗分類。
- `FakeSpeechRecognizer`: テスト・OFFLINE 用（外部送信なし）。
- 純関数 `buildDeepgramUrl` / `parseDeepgramMessage` / `normalizeDeepgramResult` / `StreamTimeMap` / `mapAnthropicError`
  はフィクスチャで契約テストしている（実 API は呼ばない）。

API キーをログ・エラー文・URL へ含めない。確認日・採用パラメーターは [docs/providers.md](../../docs/providers.md)。
