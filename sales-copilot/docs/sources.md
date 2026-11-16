# 一次資料と採用バージョン（SPEC §18）

確認日: **2026-11-16**。下の URL はこの日に到達（HTTP 200）を確認し、設計に使った記述を確認した。
詳しい読み取り内容と設計判断は [docs/extension.md](extension.md)（Chrome）と [docs/providers.md](providers.md)（Deepgram / Claude）にある。
実 API（Deepgram / Anthropic）はキー未設定のため、この確認では呼び出していない。

## 一次資料

| 分野 | 資料 | URL | 設計に使った内容（要約） |
|---|---|---|---|
| Chrome | chrome.tabCapture | https://developer.chrome.com/docs/extensions/reference/api/tabCapture | `getMediaStreamId({ targetTabId })` の ID は1回限り・数秒で失効。Chrome 116+ は offscreen document で消費可。取得するとタブの音が止まるので再生し直す |
| Chrome | chrome.offscreen | https://developer.chrome.com/docs/extensions/reference/api/offscreen | 拡張ごとに1つ。`AUDIO_PLAYBACK` は 30 秒無音で閉じられる（→ `USER_MEDIA` のみ使用）。offscreen で使える拡張 API は `runtime` のみ |
| Chrome | Screen capture how-to（Record audio and video in the background） | https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture | action クリック → offscreen 作成 → streamId → `getUserMedia({ chromeMediaSource: 'tab' })` → AudioContext で再生継続 |
| Web | MDN MediaDevices.getUserMedia() | https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia | マイク取得（`deviceId: { exact }`、echoCancellation 等の制約）、権限エラー（`NotAllowedError`） |
| Web | MDN AudioWorklet | https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet | `audioWorklet.addModule` で単一ファイルのプロセッサーを読み込む（→ worklet を import なしの単一ファイルでビルド） |
| STT | Deepgram Models & Languages Overview | https://developers.deepgram.com/docs/models-languages-overview | nova-3 の日本語は `ja` |
| STT | Deepgram Endpointing & Interim Results | https://developers.deepgram.com/docs/understand-endpointing-interim-results | `is_final`（区間確定）と `speech_final`（発話終了）は別。interim は同じ区間の更新 |
| STT | Deepgram Listen（Streaming）API Reference | https://developers.deepgram.com/reference/speech-to-text/listen-streaming | `wss://api.deepgram.com/v1/listen`、`Authorization: Token`、`encoding=linear16` / `sample_rate` / `channels`、KeepAlive / CloseStream |
| LLM | Claude Structured outputs | https://platform.claude.com/docs/en/build-with-claude/structured-outputs | `output_config.format = { type: "json_schema", schema }` |
| LLM | Claude Streaming | https://platform.claude.com/docs/en/build-with-claude/streaming | 確認のうえ**不採用**: 未検証の途中文を画面に出さない方針（SPEC §12）のため非ストリーミングで1回生成し、検証後に原子的に表示 |

`docs.claude.com/en/docs/build-with-claude/...` は 2026-11-16 時点で `platform.claude.com/docs/en/build-with-claude/...` へ転送される。

## 採用バージョン（2026-11-16 時点、`pnpm-lock.yaml` で固定）

| 種類 | 名前 | バージョン |
|---|---|---|
| 実行環境 | Node.js | 22 LTS の 22.13 以上（`engines.node >=22.13`。node:sqlite をフラグなしで使うため。開発・検証は 22.23.4） |
| パッケージ管理 | pnpm | 10.28.0（`packageManager`。corepack で有効化） |
| 言語 | TypeScript | 5.9.3 |
| サーバー | fastify / @fastify/websocket / ws / pino / tsx | 5.12.8 / 11.3.7 / 8.23.0 / 10.4.0 / 4.23.15 |
| 永続化 | node:sqlite（Node 22 内蔵・実験的機能） | Node に同梱 |
| 検証 | zod | 4.6.7 |
| 拡張機能 | React / react-dom / Vite / @vitejs/plugin-react | 19.3.1 / 19.3.1 / 7.3.8 / 5.2.0 |
| 拡張機能 | Chrome（manifest の `minimum_chrome_version`） | 116 以上 |
| STT | Deepgram モデル / 言語 | `nova-3` / `ja`（環境変数で変更可） |
| LLM | @anthropic-ai/sdk / 既定モデル | 1.8.0 / `claude-haiku-5-5`（`ANTHROPIC_MODEL` で変更可） |
| テスト | vitest / @testing-library/react / jsdom | 3.2.7 / 16.3.3 / 31.0.1 |
| ブラウザ自動化 | Playwright / Chromium（Chrome for Testing） | 1.63.0 / 153.0.8010.12（開発環境にプリインストール。リポジトリの依存には含めない） |
