# ai-ops-orchestrator

「PCを消しても回る」24時間無人運用の PoC (P0)。GitHub Actions の cron + ヘッドレス
Claude Code で `team-learning-loop` を1本だけ動かし、オーナーのPCが落ちていても
学習ループが回り続けることを実証する。

## アーキテクチャ

- **このリポジトリ（public, `ai-ops-orchestrator`）**: ワークフローYAMLと
  実行スクリプトのみ。業務データは一切置かない。public なので Actions の
  実行時間は無制限・無料。
- **private repo `ai-ops-config`**: 業務データ本体
  （`agents/` `memory/` `scheduled-tasks/` `CLAUDE.md`）。オーナーPCの
  `C:\Users\user\.claude` を allowlist方式の `.gitignore` で git 管理化したもの。
  ワークフローが `GH_PAT` で checkout し、実行後に生成物（learnings/
  memory 更新など）を commit & push して永続化する。
- **Claude 実行**: `npx @anthropic-ai/claude-code -p "<SKILL本文>"
  --permission-mode acceptEdits`（非対話）。認証はサブスク流用の
  `CLAUDE_CODE_OAUTH_TOKEN` を優先、無ければ `ANTHROPIC_API_KEY` にフォールバック。
- **失敗通知**: `if: failure()` で LINE Messaging API に push 通知。

### `scripts/run-loop.sh` がやっていること

1. private config repo の checkout (`config/`) を `$HOME/.claude` にミラーする
   （オーナーPCのグローバル設定と同じ構造を再現し、Claude Code の
   `~/.claude/agents` サブエージェント読み込み・`~/.claude/CLAUDE.md` 適用を
   そのまま機能させるため。プロンプト内のパス文字列置換だけでは
   サブエージェント定義自体は読み込まれないので、ミラー方式にした）。
2. 対象 `scheduled-tasks/<loop>/SKILL.md` の YAML frontmatter を除去。
3. 本文中の Windows 絶対パス `C:\Users\user\.claude\...`
   （バックスラッシュ/フォワードスラッシュ両対応）を
   `$HOME/.claude/...` に置換し、残りのバックスラッシュもスラッシュ化。
4. JST（日本時間）の現在時刻を明示的にプロンプト先頭に注入する
   （ランナーの内部時計はUTCなので、SKILL.md の「現在の時刻」判定ロジックが
   時間帯を誤判定しないようにするため）。
5. `npx @anthropic-ai/claude-code -p "<prompt>" --permission-mode acceptEdits`
   を実行。
6. 実行後、`$HOME/.claude` の `memory/` `agents/` `scheduled-tasks/`
   `CLAUDE.md` **だけ**を `config/` に書き戻す（それ以外に書かれたもの
   ＝キャッシュ等は破棄され、絶対にコミットされない）。

その後ワークフロー側で `config/` を commit & push する。

## 既知の制約（P0スコープ）

- **`ai-business/` ディレクトリは未対応**: `team-learning-loop`
  のステップ5「★★★★★の発見時のみ `C:\Users\user\ai-business\...` に追記」
  は、`ai-business` が config repo に含まれていないため、ランナー上では
  該当パスが存在せず書き込みは失われる（無害だが記録が残らない）。
  この分岐は「★★★★★の発見があった場合のみ」の稀なケースであり、
  P0では許容。P1以降で `ai-business` も config repo に含めるか、
  別リポジトリを追加する必要がある。
- **他5ループは未移設**: `team-learning-loop` 1本のみが対象。他ループ
  （ad-lp系・SEO系・ad-pdca等）はPowerShell依存や外部API呼び出しが
  絡むため、個別に移設要否を判断する（P2）。
- **書き戻しは `cp` (追加/上書きのみ)**: `rsync --delete` ではないため、
  Claude が `memory/` 等の中でファイルを削除した場合、config repo 側の
  古いファイルは残る可能性がある。PoCとしては許容。

## セットアップ（オーナー作業・値はプレースホルダ）

以下は **お金が動かない設定作業**（自律性ルール上、承認ゲート不要）。
実際の値は絶対にこのファイルやコミットに書かないこと。

```bash
# 1. Claude Code のサブスクリプション認証トークンを発行し、
#    このpublicリポジトリのsecretに登録する
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R <owner>/ai-ops-orchestrator
# ↑ 上記コマンド実行後、貼り付けを求められたら claude setup-token の出力を貼る

# 2. private repo (ai-ops-config) を checkout/push できる
#    fine-grained PAT を発行して登録する
#    (対象: <owner>/ai-ops-config のみ、Contents: Read and write)
gh secret set GH_PAT -R <owner>/ai-ops-orchestrator
# ↑ 発行したPATの値を貼り付け

# 3. LINE失敗通知用（C:\Users\user\.claude\line_config.json と同じ値）
gh secret set LINE_CHANNEL_TOKEN -R <owner>/ai-ops-orchestrator
gh secret set LINE_USER_ID -R <owner>/ai-ops-orchestrator

# （任意・フォールバック用）サブスクトークンではなくAPIキー課金で回したい場合のみ
gh secret set ANTHROPIC_API_KEY -R <owner>/ai-ops-orchestrator
```

`<owner>` は実際のGitHubアカウント名に置き換える。

## 「PCを消しても回る」を実証する手順

1. 上記シークレットを全て登録する。
2. GitHub上で Actions タブ → `team-learning-loop` ワークフロー →
   `Run workflow`（`workflow_dispatch`）で手動実行し、成功することを確認する
   （`ai-ops-config` リポジトリに新しいコミットが push されていることを確認）。
3. オーナーのPCをシャットダウンする。
4. 次の cron 実行時刻（JSTの1/4/7/10/13/16/19/22時のいずれか）を待つ
   （PCが落ちていてもGitHub Actionsのクラウド側で実行されるため無関係）。
5. PCを再起動後、`ai-ops-config` リポジトリの commit log に、PCが落ちていた
   時間帯のタイムスタンプで新しいコミットが追加されていることを確認できれば、
   PoC成功。
