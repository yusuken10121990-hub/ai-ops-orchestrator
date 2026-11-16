# apps/server

ローカル Fastify サーバー（127.0.0.1 のみ bind）。ペアリングと期限付きセッショントークンで拡張機能を認証し、WebSocket で音声フレームと制御メッセージを受ける。`@sales-copilot/domain` の SessionLifecycle / TranscriptStore / ConversationState / AdviceScheduler / UsageMeter を組み立て、`@sales-copilot/providers` 経由で Deepgram（STT）と Claude（助言）を呼ぶ。APIキーは環境変数のみで扱い、会話本文・顧客名・トークンを通常ログへ出さない。承認済み条件などの設定は SQLite、会話は既定でメモリのみ。起動: `pnpm start`（tsx で TS ソースを直接実行）。
