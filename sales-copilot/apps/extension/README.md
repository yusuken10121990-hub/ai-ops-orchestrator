# apps/extension

Chrome MV3 拡張機能（TypeScript / React / Vite）。ユーザー操作起点で対象の会議タブを記録し、tabCapture の stream ID を offscreen document で受けて会議側（REMOTE）音声を取得、見える設定画面で許可を得たマイク（SELF）を別系統で取得する。AudioWorklet で 16kHz / PCM16 / モノラルへ実際にリサンプリングし、`@sales-copilot/contracts` の `encodeAudioFrame` でローカルサーバーへ WebSocket 送信する。会議音声の再生経路を維持し、自分のマイクはスピーカーへ戻さない。本人専用の独立ウィンドウにカンペ・状態表示・操作ボタンを描画する（会議タブへは注入しない、会話を HTML として描画しない）。
