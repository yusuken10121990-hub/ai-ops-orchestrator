# packages/contracts

拡張機能・サーバー・各パッケージが共有する Zod スキーマと型。音声フレームのヘッダーとバイナリ形式（`encodeAudioFrame` / `decodeAudioFrame`）、クライアント⇄サーバーの WebSocket メッセージ、パイプライン状態と理由コード、助言の LLM 出力スキーマ（SPEC §12）とアプリ側で付与する AdviceCard、承認済み条件（ApprovedFact）、使用量・価格表、ペアリングと認証トークンを定義する。境界で受け取るデータは必ずここのスキーマで検証する。

| ファイル | 内容 |
|---|---|
| `audio.ts` | 音声フレーム（ヘッダー＋PCM16LE）の符号化・復号 |
| `messages.ts` | WebSocket メッセージ（client→server: hello / session.start / source.state / analysis.* / advice.request / card.pin・unpin / feedback / session.end / speaking.state / advice.displayed / audio.gap、server→client: hello.ack / status / transcript.segment / advice.card / advice.invalidated / card.pin.state / warning / usage / error / session.ended） |
| `http.ts` | HTTP の要求・応答（/config/status, /facts, /sessions/:id/review, /offline/scripts）と遅延統計 `LatencyStats` |
| `advice.ts` / `facts.ts` / `status.ts` / `usage.ts` / `auth.ts` | 助言・承認済み条件・状態/理由コード・使用量/価格表・ペアリング/トークン |
