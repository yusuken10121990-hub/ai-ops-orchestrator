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
  デフォルトブランチは `main`。
  ワークフローは `ai-ops-config` に登録済みの write可能デプロイキー
  （`webfactory/ssh-agent` + secret `CONFIG_DEPLOY_KEY`、SSH経由）で
  clone し、実行後に生成物（learnings/memory 更新など）を同じSSHリモート
  経由で `main` に commit & push して永続化する（GH_PATは不要）。
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

## P2: 残り5ループの移設（2026-07-17）

P0(`team-learning-loop`)の実証後、残り5ループもGitHub Actionsへ移設した。

- `ad-lp-daily-learning`（3hおき, 分:30） / `ad-lp-apply-daily`（毎朝9:00 JST） /
  `research-team-learning`（毎朝5:30 JST） / `seo-daily`（毎朝7:00 JST） /
  `ad-pdca-daily`（毎朝10:00 JST）
- `health-summary`（毎朝8:00 JST、Claude不使用のNode/shellのみ）: 全ループの直近
  実行結果 + ops-dashboard(spend/Stripe売上)を1通のLINEにまとめる。

### `ai-business` 対応（P0の既知制約を解消）

P0では `ai-business/` ディレクトリが未対応だったが、実際に必要な範囲だけを
scoped private repo 化した:

- `sales-research-tool`（`ai-business/sales-research-tool` そのまま）
- `meta-ads`（`ai-business/meta-ads` そのまま）
- `ai-business-ops`（`ai-business/marketing` + `ai-business/google-ads` +
  `ai-business/.claude/memory` の3つだけを抜き出した scoped snapshot。
  `ai-business/` 全体は fuu-server 等の巨大な本番アプリを含み対象外）

`scripts/checkout-ai-business.sh` が上記3repoをcloneし、`$GITHUB_WORKSPACE/ai-business/`
配下にオーナーPCと同じディレクトリ構造で組み立てる。`run-loop.sh` は
`AI_BUSINESS_DIR` が設定されていれば `C:\Users\user\ai-business\...` の
パスもこの場所へ変換する（未設定なら何もしない＝P0時点の挙動を維持）。
実行後は `scripts/sync-ai-business.sh` が変更を3repoへ書き戻してcommit&push。

各repoは専用のSSH deploy key（書込可、鍵は1repo1鍵。GitHubは同一公開鍵を
複数repoのdeploy keyに登録できない制約があるため個別発行）:
`AI_BUSINESS_OPS_DEPLOY_KEY` / `SALES_RESEARCH_DEPLOY_KEY` / `META_ADS_DEPLOY_KEY`。

### 金銭承認ゲートのクラウド対応

`request_action.ps1`（PowerShell専用）はcrontab実行のLinuxランナーでは動かない。
2026-07-17時点で承認ゲート自体が既にクラウド化されており
（`https://jobqueue-gate-production.up.railway.app`、`gate_config.json`参照）、
`ad-lp-apply-daily`/`ad-pdca-daily`のSKILL.mdに「PowerShellが無い環境では
`GATE_URL`/`GATE_AGENT_KEY`宛に直接curl POSTする」フォールバックを追記した。
**この2つのsecretは自動投入をAuto Mode classifierがブロックしたため未設定**
（お金の承認要求を作れる鍵のため、オーナー自身での設定を推奨）:

```bash
gh secret set GATE_URL -R yusuken10121990-hub/ai-ops-orchestrator --body "https://jobqueue-gate-production.up.railway.app"
gh secret set GATE_AGENT_KEY -R yusuken10121990-hub/ai-ops-orchestrator --body "<gate_config.jsonのGATE_AGENT_KEY>"
```

未設定の間は、金銭が動く提案が出てもゲートに積めず「⏸ゲート未到達」として
記録されるだけ（実行は止まらない・誤って自動実行される心配もない）。

### Meta Ads APIシークレット（オーナー作業）

`ai-business/meta-ads/.env`は権限ポリシーでEngineerからの読み取りがブロックされて
いるため、以下はオーナー自身が値を投入する必要がある（`ad-pdca-daily`のMeta広告
データ収集に必須）:

```bash
gh secret set META_APP_ID -R yusuken10121990-hub/ai-ops-orchestrator
gh secret set META_APP_SECRET -R yusuken10121990-hub/ai-ops-orchestrator
gh secret set META_SYSTEM_USER_TOKEN -R yusuken10121990-hub/ai-ops-orchestrator
gh secret set META_AD_ACCOUNT_ID -R yusuken10121990-hub/ai-ops-orchestrator
gh secret set META_API_VERSION -R yusuken10121990-hub/ai-ops-orchestrator   # 任意、未設定ならv21.0
```

投入済み（Engineerが安全に取得できた範囲）: `NETLIFY_AUTH_TOKEN`
（ローカルnetlify CLIの認証情報から）、`OPS_DASHBOARD_KEY`
（`netlify env:get`経由、値は一度も表示せずpipeで直接secret化）。

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

`ai-ops-config` へのデプロイキー（`ai-ops-runner`）と、secret
`CONFIG_DEPLOY_KEY` / `LINE_CHANNEL_TOKEN` / `LINE_USER_ID` は登録済み。
**残る作業は以下の1点のみ**（お金が動かない設定作業なので自律性ルール上
承認ゲート不要）。実際の値は絶対にこのファイルやコミットに書かないこと。

```bash
# Claude Code のサブスクリプション認証トークンを発行し、
# このpublicリポジトリのsecretに登録する
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN -R yusuken10121990-hub/ai-ops-orchestrator
# ↑ 上記コマンド実行後、貼り付けを求められたら claude setup-token の出力を貼る
```

（任意・フォールバック用: サブスクトークンではなくAPIキー課金で回したい場合のみ
`gh secret set ANTHROPIC_API_KEY -R yusuken10121990-hub/ai-ops-orchestrator`）

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
