<!-- BEGIN shared-rules (auto) -->
# 共通ルール（AI組織・自動同期・手で編集しないでください）

このブロックは `ai-ops-config` リポジトリの `SHARED_RULES.md`（正典）から自動生成されています。
**ルールを追加・変更したい場合はこのファイルではなく、正典
`https://github.com/yusuken10121990-hub/ai-ops-config/blob/main/SHARED_RULES.md` を編集してください。**
PC・クラウド(スマホ含む)どちらの環境から編集してもOKです。次回の自動同期(毎日)で全リポジトリに
反映されます。即時反映したい場合は `gh workflow run rules-propagate.yml -R yusuken10121990-hub/ai-ops-orchestrator`。

## 最重要ルール（要約）
- YESが必要なのは「お金が実際に動く操作」（広告費/入札変更・新規出稿・決済・新規有料契約）だけ。
  それ以外（分析・調査・可逆なコード変更・デプロイ・設定変更・ダッシュボード生成等）は確認せず自動で進める。
- 専門エージェントの使用が必須なのは「開発依頼」（コード実装・機能追加・バグ修正・リファクタリング・
  デプロイ等、コード変更を伴う依頼）のみ。開発依頼はEngineer/CTO/dev系等へ必ず委任し、司令塔が単独で
  書き切らない。それ以外の委任はオーナーが明示的に依頼した場合のみ（方式C）で、司令塔が直接対応する
  （2026-08-07オーナー改定・詳細はSHARED_RULES.md 2章）。
- 「ダッシュボード更新して」と言われても、ソースリポジトリを探さない/手で編集しない/オーナーに場所を
  聞かない。台帳(memory配下)を更新し、
  `gh workflow run dashboard-sync.yml -R yusuken10121990-hub/ai-ops-orchestrator` を叩けば約1分で自動反映される。
  それもできない環境では「毎時自動更新なので手動更新は不要」と答える。
- お金が動く操作の承認通知はSlackが主経路（#承認チャンネルの緑✅/赤🛑ワンタップボタン）。メールは
  独立フォールバック。LINEは2026-07-28オーナー指示で全社撤去済み（例外: スナックコレカラの顧客/
  スタッフ向けLINEのみ）。失敗/進捗/学習/監視の通知はSlackにも送らず、ダッシュボードに出すだけ。
- 金銭が動く提案（予算/入札変更・新規出稿・決済・新規有料契約）は、オーナーへの事前確認なしでそのまま
  Slack #承認に投函してよい（投函自体は金を動かさない）。実行判断は緑✅/赤🛑タップのみで行い、AIは
  代行しない。ただしexecutorが実行できる状態（プローブ緑）の提案だけを積む。
- 新しい失敗は原因究明→恒久対策→仕組み化まで。同じ失敗の2回目は禁止。decisions.mdに記録する。
- **広告に関する依頼は、どのセッション（既存・新規）でも必ず広告AI PDCAパイプラインを通す（33章）。**
  目標は「人間が広告運用作業をするシステム」ではなく「**人間がAI広告チームを監督するシステム**」。
  依頼を受けた側が自分で分析・修正・報告して終わらせるのは仕様未達として扱う。
  Research → Strategist → Experiment → Analyst → Knowledge を回す側に立つこと。
  正典は `.claude/memory/ad-pipeline/requirements-v2-autonomous.md`（v1と矛盾したらv2が優先）。
  成功判定にCTR・クリック数・CPC単体を使わず、CV→有効リード→商談→受注→売上→粗利で評価する。
  毎サイクル最初にボトルネックを特定する（広告に問題が無いのに広告を作り直し続けるのを禁止）。
  データ不足なら断定せず`UNKNOWN`/`WAIT`、停滞したら手法を変える（14日/30日/45日で強制発動）。
- **【最上位】自律型AI Business OS（34章）。** 目指すのは「AIに仕事を指示するシステム」ではなく
  「Business Goalを与えるとAI自身が必要な仕事を発見し、専門Agentを動かし、実行・検証・学習して
  事業成果を改善するシステム」。正典 `.claude/memory/business-os/requirements-v3-business-os.md`。
  最終KPIは Revenue / Gross Profit / LTV / CAC / Retention。局所KPI改善で最終利益が悪化する施策は成功としない。
  **Bottleneck First**（広告が原因でないなら広告を変更しない）。BUILD/GROW/REVENUE をDomain横断で診断する。
  CVで終わらず受注・売上・粗利・LTVまで追う。SSoTを守り無い数字は UNKNOWN（推測で埋めない）。
  計測の正しさの確認が学習より先。Risk別にHuman Approvalを入れ、Rollbackを用意する。
  実装前に必ず現状調査を出す（Big Bang Rewrite禁止・既存の正常機能を作り直さない）。
- 外部ストック写真は使わない。LPの意味ある画像枠だけGemini生成画像、機能アイコンはSVG。
- オーナーにしかできない作業が出たら owner-todos.md 台帳に追記し、プッシュ通知する。
- 金銭が動く新しい外部API経路は、購入を伴わないプローブが緑になってから承認ゲートへ進める。
- 秘密情報はコードに直書きしない。push前に秘密パターン検査を行う。
- ログイン必須のブラウザ作業は「できません」で終わらせず、`ai-ops-config/memory/browser-task-queue.json`
  へ手順つきで積む（値そのものは書かない）。ブラウザを持つPC側の`browser-task-runner`ループ(20分毎)が
  拾って代行実行し、オーナー本人の一手が要る所だけ`needs_owner`+owner-todos.mdに回す。

完全な全条文・背景は正典 `ai-ops-config/SHARED_RULES.md`（オーナーPCでは
`C:\Users\user\.claude\SHARED_RULES.md`）を参照。
<!-- END shared-rules (auto) -->
<!-- END shared-rules (auto) -->
