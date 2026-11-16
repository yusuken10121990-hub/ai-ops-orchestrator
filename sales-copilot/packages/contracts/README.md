# packages/contracts

拡張機能・サーバー・各パッケージが共有する Zod スキーマと型。音声フレームのヘッダーとバイナリ形式（`encodeAudioFrame` / `decodeAudioFrame`）、クライアント⇄サーバーの WebSocket メッセージ、パイプライン状態と理由コード、助言の LLM 出力スキーマ（SPEC §12）とアプリ側で付与する AdviceCard、承認済み条件（ApprovedFact）、使用量・価格表、ペアリングと認証トークンを定義する。境界で受け取るデータは必ずここのスキーマで検証する。
