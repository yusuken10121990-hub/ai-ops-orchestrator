<!-- BEGIN shared-rules (auto) -->
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
- 実質的な検討・実装（戦略・設計・コード・分析）は CEO/CTO/CMO/Engineer 等の専門エージェントに委任する。
  単独で書き切らない。
- 「ダッシュボード更新して」と言われても、ソースリポジトリを探さない/手で編集しない/オーナーに場所を
  聞かない。台帳(memory配下)を更新し、
  `gh workflow run dashboard-sync.yml -R yusuken10121990-hub/ai-ops-orchestrator` を叩けば約1分で自動反映される。
  それもできない環境では「毎時自動更新なので手動更新は不要」と答える。
- LINE通知は金銭承認依頼のみ。それ以外（失敗/進捗/学習/監視）はダッシュボードに出すだけ。
- 新しい失敗は原因究明→恒久対策→仕組み化まで。同じ失敗の2回目は禁止。decisions.mdに記録する。
- 外部ストック写真は使わない。LPの意味ある画像枠だけGemini生成画像、機能アイコンはSVG。
- オーナーにしかできない作業が出たら owner-todos.md 台帳に追記し、プッシュ通知する。
- 金銭が動く新しい外部API経路は、購入を伴わないプローブが緑になってから承認ゲートへ進める。
- 秘密情報はコードに直書きしない。push前に秘密パターン検査を行う。

完全な全条文・背景は正典 `ai-ops-config/SHARED_RULES.md`（オーナーPCでは
`C:\Users\user\.claude\SHARED_RULES.md`）を参照。
<!-- END shared-rules (auto) -->
<!-- END shared-rules (auto) -->
