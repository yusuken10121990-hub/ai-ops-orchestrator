# 進捗（2026-11-16 時点）

自動化での合格と、実際の Meet・実 API での確認は分けて書く（SPEC §16-2）。

## 実装済み

- **拡張機能（MV3）**: 対象タブの記録と tabCapture、offscreen での会議音声・マイクの別系統取得、会議音声の再生維持、
  AudioWorklet での 16kHz 実リサンプリングと 200ms フレーム化、バックプレッシャーと欠落区間（`audio.gap`）、
  開始前の確認画面（API 設定状態・台本選択・マイク許可と相手への同意を別チェック・送信先表示）、カンペウィンドウ
  （今の一手／次に言う一言／今は言わない・9 ボタンとキー操作・文字サイズ・明暗・状態バー）、表示報告（`advice.displayed`）、
  終了画面（`session.ended` で出力の有無と保持期限、受け取れなければ振り返り API で確認）、設定画面（ペアリング・マイク・承認済み条件）。
- **ローカルサーバー**: 127.0.0.1 のみ、ペアリングと期限付きトークン、Host/Origin 検査、WebSocket セッション、
  Deepgram ストリーミング（キーがあれば）、OFFLINE 再生（台本選択・Anthropic は許可＋本人選択のときだけ）、
  文字起こし統合 → 会話状態 → 自動契機・手動ボタン → スケジューラー → 助言エンジン（表示前検証）→ 検証済みカード、
  停止・一時停止・切断での後始末、使用量と上限、遅延計測（表示報告まで）、承認済み条件の版管理（SQLite）、任意の出力。
- **共有の型（contracts）**: WS メッセージ（`session.ended` / `advice.displayed` / `audio.gap` / `offlineScriptId` を今回追加）、
  HTTP 応答（`/config/status` / `/facts` / `/sessions/:id/review` / `/offline/scripts`）を両側で Zod 検証。
- **助言（coaching）**: アプリ内 AI 指示（原文）、返答例の選択、構造化出力、表示前検証（数値の出所・未承認条件・保証表現・質問数・見送り尊重など）、
  有限の再試行と安全な「確認」への切替、API キーなしの OFFLINE 用ルールベース。
- **ルートのコマンド**: `pnpm install` / `pnpm setup:first` / `pnpm dev` / `pnpm start` / `pnpm test` / `pnpm typecheck` / `pnpm build` / `pnpm test:e2e`。
- **文書**: README（Windows 手順・データの送り先と保存・テスト済み/未検証）、architecture / sources / acceptance / security / latency /
  providers / extension / manual-checklist。

## 自動化で確認済み（2026-11-16 実行）

| コマンド | 結果 |
|---|---|
| `pnpm install --frozen-lockfile` | 成功 |
| `pnpm test` | 25 ファイル・369 件 成功 |
| `pnpm typecheck` | 7 パッケージ 成功 |
| `pnpm build` | 成功（dist 検査 `check-dist`: 権限最小・秘密らしき文字列なし・innerHTML 不使用） |
| `pnpm test:e2e` | 実サーバー × 実拡張 29/29、拡張スモーク 21/21（Linux・Chromium 153 headless・偽マイク） |
| `pnpm start` / `pnpm dev` | 端末にペアリングコードが出て 127.0.0.1 で待ち受け、拡張の監視ビルドが dist（worklet 含む）を作ることを確認 |
| `pnpm setup:first` | `.env` 作成・既存 `.env` を上書きしない・ビルド・次の手順表示を確認 |

SPEC §16-1 の 1〜18 と各テストの対応は [docs/acceptance.md](docs/acceptance.md)。

### 結合で見つけて直した不具合

1. **Chrome は拡張ページからの GET に Origin を付けない** → サーバーが `/config/status`・`/facts` を 403 にし、開始前画面が「認証できません」になっていた。
   Origin なしの HTTP はトークンだけで判定（WebSocket は Origin 必須のまま）。
2. **ペアリングの失敗理由が全部「認証できません」になっていた**（401/409/429 を本文より先に判定）→ 本文の理由（コード違い・期限切れ等）を表示。
3. **終了時、`status(ended)` で WS を閉じていたため出力結果を受け取れなかった** → `session.ended` を待って閉じる。
4. **OFFLINE で実マイクの発話状態がカード表示を保留させていた**（偽マイクの音でカードが出ない）→ OFFLINE では無視。
5. **終了直後に再開始すると、前回の offscreen の遅延クローズで新しい取得が切れていた** → 新しい商談中なら閉じない。
6. **`.gitignore` の `data/` が `packages/test-fixtures/data/`（架空会話・再生台本）まで除外していた**（新しく clone するとテストと OFFLINE が動かない）→ `/data/` `/exports/` に限定。
   **これらのファイル（`packages/test-fixtures/data/conversations/` と `replay/`）はまだコミットされていない**ので、コミット時に追加が必要。
7. `pnpm dev` の拡張監視ビルドが dist を空にして AudioWorklet が消えていた → 本体と worklet を両方監視するスクリプトに変更。
   `pnpm dev` はサーバーの出力が端末を通らずペアリングコードが出なかった → 端末をそのまま渡す起動に変更。

## 未検証（実キー・実 Meet が必要）

- 会議タブの音声取得（拡張アイコン → tabCapture）、相手の声が聞こえ続けること、ハウリングしないこと。
- Meet のミュートと「自分の音声取得OFF」の違い、権限取消・タブ終了・ウィンドウを閉じたときの停止（実 Chrome）。
- Deepgram nova-3 / ja の実際の認識・interim の粒度・endpointing、Claude の実際の助言品質・遅延（p50/p95）・使用量。
- タブ共有で映り込まないこと、60 分連続稼働、Windows 版 Chrome での一連の操作（自動テストは Linux の Chromium）。
- Windows でのファイル権限（`data/` `exports/`）。

手順は [docs/manual-checklist.md](docs/manual-checklist.md)。

## 次にやること

1. Windows の Chrome で manual-checklist の 0〜3（取得・再生・ミュートの違い）を実施し、結果を記録する。
2. 小さな上限を設定して LIVE を実 API で短時間試し（明示許可のうえ）、遅延と使用量を docs/latency.md に記録する。
3. 実会話で「ずれた」が多い種類を集計し、プロンプト・検証ルールの改善案を出す（承認後に版を上げて適用）。
4. 価格表を使う場合は出典と確認日つきで `.env` に設定する（未設定なら金額は出さない）。
5. テストが作る一時ディレクトリ（`/tmp/sc-server-*`）を後始末するようにする（動作には影響しない）。
