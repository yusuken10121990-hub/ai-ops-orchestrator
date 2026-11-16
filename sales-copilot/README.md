# ZEROSYS Sales Copilot

商談中カンペAI。正典仕様は [docs/SPEC.md](docs/SPEC.md)。

| ディレクトリ | 責務 |
|---|---|
| apps/extension | Chrome MV3 拡張（音声2系統取得・カンペ表示ウィンドウ） |
| apps/server | ローカル Fastify + WebSocket サーバー（127.0.0.1） |
| packages/contracts | 共有 Zod スキーマ・型・音声フレーム形式 |
| packages/domain | 純粋ドメインロジック（文字起こし統合・会話状態・スケジューラー・ライフサイクル・使用量） |
| packages/coaching | プロンプト・助言の入力組立と表示前検証 |
| packages/providers | Deepgram / Claude アダプターとモック |
| packages/test-fixtures | 架空会話・回帰フィクスチャ |

## コマンド

```
pnpm install
pnpm test        # 全ワークスペースの Vitest（実APIは呼ばない）
pnpm typecheck   # 各パッケージで tsc --noEmit
pnpm build       # ビルド対象のあるパッケージのみ
pnpm dev         # 開発起動
pnpm start       # サーバー起動
```

パッケージは TypeScript ソースのまま `exports` で公開し（`./src/index.ts`）、サーバーは tsx、拡張は Vite がそのまま解決する（`moduleResolution: Bundler`）。
