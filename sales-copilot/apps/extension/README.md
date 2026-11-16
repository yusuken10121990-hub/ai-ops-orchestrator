# apps/extension

Chrome MV3 拡張機能（TypeScript / React / Vite）。ユーザー操作起点で対象の会議タブを記録し、tabCapture の stream ID を offscreen document で受けて会議側（REMOTE）音声を取得、見える設定画面で許可を得たマイク（SELF）を別系統で取得する。AudioWorklet で 16kHz / PCM16 / モノラルへ実際にリサンプリングし、`@sales-copilot/contracts` の `encodeAudioFrame` でローカルサーバーへ WebSocket 送信する。会議音声の再生経路を維持し、自分のマイクはスピーカーへ戻さない。本人専用の独立ウィンドウにカンペ・状態表示・操作ボタンを描画する（会議タブへは注入しない、会話を HTML として描画しない）。

設計・権限・一次資料の確認結果: [docs/extension.md](../../docs/extension.md) / 実機チェック: [docs/manual-checklist.md](../../docs/manual-checklist.md)

| パス | 役割 |
|---|---|
| `public/manifest.json` | MV3 manifest（tabCapture / offscreen / storage / activeTab、host はローカルのみ） |
| `src/background/service-worker.ts` | アクションのクリック→対象タブ記録→stream ID→offscreen→ウィンドウ。終了・タブ終了の監視 |
| `src/offscreen/` | MediaStream・AudioContext・WebSocket を持つ唯一の文脈（`capture-controller.ts` はテスト可能な本体） |
| `src/audio/dsp/` | リサンプラー・PCM 変換・チャンカー・VAD（純粋 TS） |
| `src/audio/worklet/capture-processor.ts` | AudioWorklet（単一ファイルで別ビルド） |
| `src/copilot/` | カンペウィンドウ（開始前 / 商談中 / 終了） |
| `src/options/` | 設定画面（サーバー URL・ペアリング・マイク許可・承認済み条件） |

```
pnpm --filter @sales-copilot/extension build      # dist/ を chrome://extensions で読み込む
pnpm --filter @sales-copilot/extension typecheck
pnpm --filter @sales-copilot/extension test:e2e   # build 後。Playwright スモーク（モックサーバー）
pnpm test                                          # ルートで Vitest（拡張の単体テストを含む）
```
