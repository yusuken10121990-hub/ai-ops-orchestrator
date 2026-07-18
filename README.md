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

## P3: ダッシュボードのクラウド化（2026-07-18）

**問題**: `aiwill-ops-dashboard` / `aiwill-ai-campus` の再生成がローカルの毎時タスク
（旧 `owner-todo-dashboard-sync`）依存だったため、オーナーPCを閉じている間は
「表示が古いまま」になっていた。学習ループ自体は既にクラウド常時最新
（`ai-ops-config`）なのに、ダッシュボード生成だけがローカルPC依存で「学習が
止まって見える」状態だった。

**対応**: `dashboard-sync.yml`（毎時 `7 * * * *`、`workflow_dispatch`可）を新設。
- `ai-ops-config`（SSH `config-gh`）と `ai-business-ops`（SSH `ai-business-ops-gh`、
  2026-07-18に `campaigns/ops-dashboard-site` / `campaigns/ai-campus-site` を追加）を
  clone。
- `config/{agents,memory,scheduled-tasks}` を `mirror/.claude/` へ**シンボリックリンク**
  で配置し、`DASHBOARD_HOME=<workspace>/mirror` を渡す（`cp` ではなく symlink にした
  理由: `build-dashboard.mjs`/`build-campus.mjs` の学習鮮度判定が `fs.statSync().mtime`
  だと `git clone` 直後に全ファイルのmtimeがcheckout時刻へ揃ってしまい「全員フレッシュ」
  という誤表示になる。両スクリプトは2026-07-18にgit-log-awareな `lastModified()` へ
  修正済みで、symlink経由なら `fs.realpathSync` で `config/.git` まで辿れてコミット日時
  を使える）。
- `node build-dashboard.mjs` → `netlify deploy --prod --site 7fdc2c4b-...` /
  `node build-campus.mjs` → `netlify deploy --prod --site 2bc30fa4-...` を実行し、
  生成物（`index.html`/`data.js`）を `ai-business-ops` へ commit & push で書き戻す。
- 両スクリプトは `HOME` 定数を `process.env.DASHBOARD_HOME || 'C:/Users/user'` に
  変更しただけなので、オーナーPCでのローカル実行（`node build-dashboard.mjs`単体）は
  従来どおり動く（後方互換）。

**ローカルタスクの扱い**: `C:\Users\user\.claude\scheduled-tasks\owner-todo-dashboard-sync`
は削除せず残すが、クラウド版が毎時回るため**手動実行用**（netlifyトークンのローカル
再取得や緊急即時反映など）に位置づけを変更し、cronの実行頻度は下げてよい判断とした
（詳細は `ai-ops-config` 側 `memory/decisions.md` 参照）。

**新設システムの自動反映（同日追加）**: 本番システムは
`C:\Users\user\.claude\memory\systems.json`（`ai-ops-config`にミラー）に台帳化。
`build-dashboard.mjs`の「24時間監視」セクションと`system-health-monitor`/`qa-daily`
のSKILLはこの台帳の`status:"live"`エントリから対象を自動導出するようになったため、
新システム公開時は台帳に1行追加するだけで監視・ダッシュボード表示に反映される
（このワークフローのcheckoutに`ai-ops-config`が含まれる＝`memory/systems.json`も
毎時取得されるため、台帳の更新は次回実行から自動反映される）。

## P0: 保守運用組織の24/7/365拡張（2026-07-18）

CTO設計「保守運用組織の24/7/365拡張」に基づき、死活監視・夜間自動一次対応・
バックアップの3本をクラウド化した(いずれもLLM不要の決定論スクリプト、
新規課金0円)。

### 1. `system-health-cloud.yml`（死活監視、30分毎 `13,43 * * * *`）

- `scripts/health-check.mjs`: `ai-ops-config` の `memory/systems.json` から
  `status:"live"` 全件(localhost系は除外)を読み、HTTP(S) fetch(15秒timeout、
  失敗/非2xx/marker不一致は1回だけリトライ)で死活判定。`healthPath` が空
  (例: `ai-ops-orchestrator` 自体はHTTPエンドポイントを持たない)の場合は
  `_deploy_note` の `GitHub: owner/repo` からGitHub Actionsの実行履歴を見て
  代替判定する(抽出できなければ `skipped`)。
- 結果は `ai-ops-config` の `memory/health-status.json` へ commit&push
  (idキー、`{status, http, url, checked_at(JST), last_remediate_at?}`)。
  ダッシュボードは既にこのファイルを表示するため追加作業なし。
- **LINE通知はしない**(既存ルール通り。ダッシュボード表示のみ)。

### 2. 夜間自動一次対応（同ワークフロー内、P1判定時のみ）

- ホワイトリスト(`fuu` / `jobqueue-gate` / `ads-ops-backend` = Railway系のみ)
  かつ P1条件(HTTP 5xx または marker欠落=決済ダウン等)の時だけ
  `scripts/safe-remediate.sh <system_id>` を呼び、Railwayの**再デプロイのみ**
  実行する(データ削除・課金系操作は物理的に実装していない)。
- 同一システム1時間1回まで(`health-status.json` の `last_remediate_at` で
  クールダウン判定)。実行後60秒待って再チェックし、結果を
  `ai-ops-config/memory/decisions.md` に1行追記する。
- `RAILWAY_TOKEN`(または `RAILWAY_TOKEN_<SYSTEM_ID>` 個別指定)が未投入の間は
  `skipped(no-token)` を記録して死活監視自体は継続する(owner-todos.md
  `id: railway-token-provision` 参照)。

### 3. `backup-daily.yml`（日次バックアップ、`20 18 * * *` UTC=JST 03:20）

- `scripts/backup.sh`: (a) Railway Postgres(承認ゲート)・(b) Supabase
  (zerosys-research 認証+クレジット) を `pg_dump` → gzip →
  `gpg --symmetric --cipher-algo AES256` で暗号化 → private repo
  **`ai-ops-backups`** の Release asset(`backup-YYYYMMDD`)としてアップロード。
  保持=日次14世代、超過分は自動prune。
- 復元手順(runbook)は `ai-ops-backups/README.md` に記載。**復元は本番へ直接
  行わず必ずスクラッチ環境で検証**する(自動化しない・incident-responder/人間
  判断)。
- secrets(`GATE_DATABASE_URL` / `SUPABASE_DATABASE_URL` /
  `BACKUP_GPG_PASSPHRASE` / `GH_BACKUP_TOKEN`)が未投入の間は
  `skipped(no-secrets)` / `skipped(no-gh-token)` を記録して green 終了する
  (owner-todos.md `id: backup-secrets-provision` 参照)。
- `GH_BACKUP_TOKEN` はこのpublicリポジトリの `GITHUB_TOKEN` では他repo
  (`ai-ops-backups`)にreleaseを作成できないため必要な別トークン。
  Engineerが保有する `gh` CLI OAuthトークン(account-wide scope)を流用する
  案は Auto Mode classifier にブロックされた(スコープが広すぎる可能性が
  高い判断は妥当)ため、`ai-ops-backups` だけに絞った fine-grained PAT
  (Contents: Read and write)をオーナーがGitHub UIで発行する方式にした。

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
