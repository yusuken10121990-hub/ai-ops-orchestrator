# packages/providers

外部 API の差し替え可能なアダプター層。STT プロバイダー（Deepgram 日本語ストリーミング。モデルID・言語は環境変数）と助言 LLM プロバイダー（Claude API）を共通インターフェースで実装し、CI 用のモック実装も持つ。API未設定・429・認証失敗・タイムアウト・不正JSON を contracts の理由コードへ変換し、実 usage（音声秒数・トークン）を返す。APIキーをログやエラー文へ含めない。
