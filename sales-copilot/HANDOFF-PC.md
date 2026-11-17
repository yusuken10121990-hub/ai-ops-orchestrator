# PC作業の引き継ぎ：ZEROSYS Sales Copilot（商談中カンペAI）

作成: 2026-11-17（クラウドの会話から）。PC側のClaudeはこのファイルを読んで、下の作業を進めてください。

## これは何か
Google Meetの商談中に、会議タブの音声と自分のマイク音声を別々に文字起こしし、野中さん専用の窓に「次に言う一言」を出すシステム。
- Chrome拡張（`apps/extension`）＋PC内だけで動く中継サーバー（`apps/server`、127.0.0.1:8787）
- 文字起こし: Deepgram／助言: Claude API（鍵は `.env` にだけ置く）
- 仕様の正典: `sales-copilot/docs/SPEC.md`。手順の詳細: `sales-copilot/README.md`

## 置き場所
- リポジトリ: `yusuken10121990-hub/ai-ops-orchestrator`
- 枝: `claude/friendly-planck-gjq74m`（master へは未取り込み・取り込み依頼も未）
- フォルダ: `sales-copilot/`

## 現在の状態（2026-11-17時点）
- 確認済み（Linux上の自動試験）: 自動テスト369件合格、型検査7/7、ビルド成功、実サーバー×実拡張の通し試験29/29、拡張の簡易試験21/21。
  鍵なしの試験モード（架空会話の再生）で、文字起こし→カンペ表示→手動ボタン→一時停止→終了が一連で動く。
- 未確認: Windows版Chromeでの動作／本物のMeetでの2系統取得／相手の声が聞こえたままか・ハウリング／
  Meetのミュートとアプリの「自分の音声取得OFF」の違い／本物のDeepgram・Claudeでの精度と速さ／
  タブ共有に映り込まないか／60分連続稼働。確認項目: `sales-copilot/docs/manual-checklist.md`

## PC側でやること（AIが代わりにやる。オーナーの手が要るのは★だけ）
1. `node -v` を確認。v22系でなければ Node.js 22 LTS を入れる（winget があれば `winget install OpenJS.NodeJS.LTS`）。
2. 取得と準備（PowerShell）:
   ```
   git clone -b claude/friendly-planck-gjq74m https://github.com/yusuken10121990-hub/ai-ops-orchestrator.git
   cd ai-ops-orchestrator\sales-copilot
   corepack enable
   pnpm install
   pnpm setup:first
   pnpm test
   ```
   既にクローン済みなら `git fetch origin claude/friendly-planck-gjq74m` してからその枝を使う。
   `pnpm test` が通らなければ、Windows固有の失敗として内容を記録し直す（ここで止めずに原因を調べる）。
3. `pnpm start` でサーバー起動。端末に出る6桁のペアリング番号を控える（10分有効・1回限り）。
4. Chromeで `chrome://extensions` → デベロッパーモードON → 「パッケージ化されていない拡張機能を読み込む」→ `sales-copilot\apps\extension\dist`。
   AIが画面を開いて操作する。オーナーにURLを渡さない。
5. 拡張の設定画面（アイコン右クリック→オプション）でペアリング番号を入れて「ペアリング」。続けてマイク許可（★「許可」ボタンだけオーナー）。
6. 鍵なしの試験モードで1回通す（README の OFFLINE 手順）。カンペが出ることを画面で確認する。
7. ★鍵: Deepgram と Anthropic のAPIキーをオーナーに `.env` へ入れてもらう（AIは値を見ない・チャットに貼らせない）。
   `DEEPGRAM_API_KEY=` と `ANTHROPIC_API_KEY=` の2行。入れたらサーバー再起動→再ペアリング。
   鍵が無い場合はここで止め、owner-todos.md に「Deepgram/AnthropicのAPIキー用意」を追記。
8. ★実会議: オーナーの本物の商談（または試しのMeet）で `docs/manual-checklist.md` の8項目を確認。
   自動試験で通ったことと実会議で動いたことを分けて記録する。

## 注意（仕様上の約束）
- 有料APIは鍵を入れただけでは動かない（開始ボタン＋確認が必要）。長時間テストを勝手に回さない。
- サーバーは127.0.0.1のみ。0.0.0.0で公開しない。
- 料金・契約条件は設定画面で承認したものだけをAIが使う。初期はすべて「未確認」。過去商談の条件を勝手に登録しない。
- 会話・音声は既定で保存しない。終了時に希望した時だけ `exports/` に出力。

## 台帳へ記録してほしいこと（クラウドからは書けないため）
- decisions.md: 2026-11-16 ZEROSYS Sales Copilot を ai-ops-orchestrator の `sales-copilot/` に新規作成（枝 claude/friendly-planck-gjq74m）。鍵なし試験モードで一連動作を自動試験で確認。実Meet・実APIは未確認。
- systems.json: 新システム「ZEROSYS Sales Copilot（商談中カンペAI）」をローカル動作（Chrome拡張＋127.0.0.1サーバー）として登録。本番公開なし。
- owner-todos.md: Deepgram/AnthropicのAPIキー用意／実商談での確認（manual-checklist 8項目）。
- 引き継ぎ時の状態: このクラウド会話の開始時は ai-ops-config に届かず HANDOFF_FAILED だった。
