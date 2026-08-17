<!-- BEGIN shared-rules (auto) -->
# 共通ルール（AI組織・自動同期・手で編集しないでください）

このブロックは `ai-ops-config` リポジトリの `SHARED_RULES.md`（正典）から自動生成されています。
**ルールを追加・変更したい場合はこのファイルではなく、正典
`https://github.com/yusuken10121990-hub/ai-ops-config/blob/main/SHARED_RULES.md` を編集してください。**
PC・クラウド(スマホ含む)どちらの環境から編集してもOKです。次回の自動同期(毎日)で全リポジトリに
反映されます。即時反映したい場合は `gh workflow run rules-propagate.yml -R yusuken10121990-hub/ai-ops-orchestrator`。

## セッション開始時にまずこれ（Session Handoff・GOVERNANCE §55 / SHARED_RULES 36章）
**このセッションで最初のTaskに着手する前に1回だけ実行する。** 人間に「クラウドの正典を読んで」
「前回の状態を引き継いで」と毎回言わせないための導線。出力は数行なので会話を埋めない。

```
node <ai-ops-configのルート>/scripts/session-handoff.mjs
# オーナーPC: node C:\Users\user\.claude\scripts\session-handoff.mjs
```

Cloud Canonical Source から12項目（Global Governance / RULES-INDEX / SHARED_RULES / Current Phase /
Business Goal / Latest Business State / Latest Cycle / Active・Ready・Blocked Tasks /
Latest Decisions / Relevant Knowledge / Human Action Required / Agent Registry）を読み込み、
`governance_version` `cloud_commit` `latest_cycle_id` `loaded_at` を記録する。

- **Cloud優先。** 正典は `git show origin/<branch>:<path>` で読み、**working treeに触らない**
  （checkout / merge / reset をしない＝未コミットのローカル変更を消さない・黙ってマージしない）。
- **Cloud未確認は `STALE` / 競合は `CONFLICT` / 読込失敗は `HANDOFF_FAILED` を必ず明示する。**
  取得に失敗した古い状態を「最新」として扱わない。CONFLICTは自動解決せず人間へEscalateする。
- 強制はコード側: `governance.mjs preflight()` の `HANDOFF_CURRENT`。
  Canonical Stateを読めていない/競合したままTaskを開始できない（`RULE_CONFLICT`で停止）。
- **既存セッション・長時間開いたままのセッションも、重要Task開始前に再確認する。**
  過去セッションのContextだけで判断を継続しない。
- Handoffは**状態同期のみ**。Production変更・外部API操作・金銭操作・Deployを行わない。
- この環境に `ai-ops-config` が無ければ clone してから実行する。それも不可能なら
  **「引き継げた」と言わずに `HANDOFF_FAILED` として報告する**（推測で状態を語らない）。

## 最上位: Global Governance
- **正典は1か所** `ai-ops-config/memory/governance/GOVERNANCE.md`（機械可読版 `governance/governance.json`・**現行 v1.1.0**）。
  版とhashは `governance.mjs --verify` が照合し、不一致なら重要判断を進めてはならない。
  新規セッション・既存セッション再開・Scheduler・Cron・GitHub Actions・Sub-Agent・Event Handler、
  **どこから処理が始まっても同じ最上位原則・Risk Policy・SSoT・Knowledge・Business Goalに従う。**
  このブロックを含む下位ルールが正典と矛盾する場合は**正典が優先**する。
- 優先順位: オーナーの発言 > Global Governance > Business OS v3 > SHARED_RULES > Domain仕様 >
  Gate O > Repository CLAUDE.md > Agent Prompt > SKILL。矛盾を黙って解釈せず、
  解決できなければ `RULE_CONFLICT` として人間へEscalateする。
- 重要ルールはPromptではなく**コードで強制**されている（`scripts/governance.mjs`）:
  金銭は承認ゲートを迂回できない／本番Deployは deploy-guard を通す／計測BROKEN時は最適化を開始しない／
  UNKNOWNを0や推測で埋めると DATA_INVALID／全AgentのGovernance束縛は registry --check が強制。

## 【最上位に次ぐ】Core確定・開発フェーズ終了 / Architecture固定（SHARED_RULES 35章）
**2026-08-16をもって AI Business OS の Core Architecture を確定し、開発フェーズを終了した。以後この構造を勝手に変更しない。**

- **Canonical Entry Point は `scripts/run-business-os.mjs`（25STEP）。新しい入口を別に作らない。**
- **Core Architecture**: Business Orchestrator/AI CEO → Domain・Capability Routing → Specialist Agent
  → Execution/Experiment → Measurement → Analyst → Knowledge → Business Orchestrator
- **Core Loop**: BUSINESS GOAL → OBSERVE → DIAGNOSE → BOTTLENECK/OPPORTUNITY → ROOT CAUSE →
  RESEARCH IF NEEDED → KNOWLEDGE RETRIEVAL → HYPOTHESIS → PRIORITIZE → TASK GENERATION →
  AGENT ROUTING → EXECUTION/EXPERIMENT → QA → RISK/APPROVAL → DEPLOY/APPLY → MEASURE →
  ANALYZE → BUSINESS OUTCOME → KNOWLEDGE → NEXT DECISION
- **Core完成の再検証は `node memory/business-os/domain-e2e.mjs`**（GROW/BUILD/REVENUE/DATAの4Domainを
  通常Entry Pointの実起動で一周・72項目・冪等）。専用関数の直呼びテストは完成根拠にしない。
- **禁止**: 新しい大規模Architecture変更の無断開始 / 完成度%を上げること自体の目的化 /
  Agent数を成果にすること /「不足を1個見つけて直して再監査」の反復。
  必要と判断したらオーナーへ1行で提示して選ばせる。**新Agentは既存でCapabilityを満たせない場合のみ。**
- **残作業は必ず4分類**（CORE BLOCKER / PRODUCTION VALIDATION / EXTERNAL BLOCKER / OPTIONAL ENHANCEMENT）。
  OPTIONAL ENHANCEMENT は実装しない。実Lead・実受注が無いことを理由にCore未完成としない
  （それは `PRODUCTION_VALIDATION_PENDING`）。
- **IMPLEMENTED / SHADOW VERIFIED / CANARY VERIFIED / PRODUCTION VERIFIED を混ぜない。**
  Mock PASSを本番完成と呼ばない。**Shadowでも Research/Agent実行/Strategy/Experiment設計/QA/Knowledge は
  実際に動かす**（止めるのは外部への不可逆な変更だけ。「Shadowだから何もしない」は違反）。
- **以後の問いは「次に何を作れるか」ではなく「今あるAI Business OSでBusiness Goalへどう近づくか」。**
  運用 → 実データ蓄積 → Production Validation → Prediction Calibration → Business Outcome改善。
- **定期実行はGitHub Actionsが正**（daily 09:12 / weekly 月 09:33 / monthly 1日 10:00 JST）。
  ローカルの定期登録は禁止（二重書き込み）。cycle_id/task_idは件数+1でなく**既存の最大連番+1**。

## EVIDENCE FIRST（未確認断定の禁止・SHARED_RULES 36章・全Repo共通）
**確認可能な事実は、Evidenceを取得し検証してからでなければ断定しない。
分からないときは答えを作らず「確認できません」と止まる。**

- **識別子は必ずフィールドから読む。** 媒体・アカウント・環境・所有者などを、表示名・
  ファイル名・並び順・文脈から推測して判定してはならない。読めなければ `UNKNOWN`。
  2026-08-17 QI-20260817-01: 台帳に `platform:"meta"` とあったのにキャンペーン名から
  「Google検索」と推測し、媒体別の表からMetaが消えた。Evidenceは手元にあった＝
  取得の失敗ではなく読み方の事故（CLASSIFICATION_ERROR）。
- **一次情報の所在は** `ai-ops-config/memory/governance/canonical-sources.json`。
  AIの過去回答・会話要約・memory・ダッシュボード表示を一次Evidenceにしない。
  台帳は一次APIの写しなので `data_as_of` を必ず添える。
- **検証状態**: VERIFIED / DERIVED / INFERRED / PARTIALLY_VERIFIED / UNVERIFIED / STALE /
  CONTRADICTED / SOURCE_UNAVAILABLE / INVALID。VERIFIED 以外を確認済みの事実として提示しない。
  **INFERRED を VERIFIED として扱わない。** STALEは時点を限定すれば述べてよい
  （「現在配信中」ではなく「○時点では配信を確認」）。
- **FAIL-CLOSED**: 取得不能・欠損・古い・矛盾・timeout・parse失敗で推測Fallbackは禁止。
  「おそらく」「たぶん」で事実確認を代替しない。矛盾は片方を採らずEscalateする。
- **広告はHIGH SEVERITY**: 配信状態/広告費/Platform/Campaign/imp/click/CTR/CPC/CV/CVR/
  CPA/Lead/商談/受注/売上/粗利/ROAS のEvidenceなし断定を禁止。
- **オーナーの訂正は品質事故**: `memory/quality-incidents.json` へ root_cause(22分類)・
  一般化ルール・regression_test つきで記録する。謝って終わりにしない。

### FACT SAFETY（2026-08-17オーナー制定・広告に限らず全Domain）
**DO NOT INFER WHAT YOU ALREADY KNOW.** 信頼できる明示Factが既にあるなら、同じFactを推論し直さない。

- **権威階層**: L0 CANONICAL_EXPLICIT > L1 AUTHORITATIVE_STRUCTURED > L2 DETERMINISTIC_DERIVED
  > L3 VALIDATED_INFERENCE > L4 HEURISTIC_INFERENCE > L5 LLM_GUESS。
  **L0/L1 があるFactを L3以下から上書き・再分類・再解釈してはならない。**
  L5 は確認可能な事実の確定値として原則使用禁止。
- **STRUCTURED FIELD FIRST**: 名称・ラベル・説明文・自然言語は Canonical Structured Field
  より優先してはならない。`{platform:"meta", campaign_name:"Google_Search_Test"}` の答えは
  `meta`。同じ構造の誤りは status/environment/branch/金額/日時/件数にも起きる
  （`branch:"master"` を「普通はmain」と推測する等）。
- **明示 vs 推論の衝突**: 明示値を採用し、`INFERENCE_CONFLICT` を記録する。
  重要な衝突は Quality Incident 候補。
- **欠損時のみ推論可**: その場合 `verification_status = INFERRED` を必ず付ける。
  未知値を既知Categoryへ勝手にマッピングしない（`UNKNOWN` のまま保持）。
- **変換の安全性**: 重要な変換では ENTITY_LOSS（入出力の件数と落ちた対象）・
  AGGREGATION_ERROR（合計＝内訳の和）・SEMANTIC_DRIFT（platform=meta が「Google検索」に化ける）
  を機械的に検査する。決定論的に計算できる値をLLMに暗算・推測させない。
- **CONTEXT CONTAMINATION 禁止**: 過去Session・Memory・Knowledge・会話要約は、
  現在の権威Factを上書きしない。過去情報は履歴としてのみ使う。
- 実装: `scripts/fact-safety.mjs`（resolveFact / detectEntityLoss / checkAggregation /
  detectSemanticDrift / assertCanonicalPreserved / resolveAgainstMemory）
  設定 `memory/governance/fact-schema.json`（Fact別の canonical_fields・
  forbidden_source_fields・enum・不変条件6件）。
- 実装: `scripts/evidence.mjs`（record / validateEvidence / resolvePlatform）
  `scripts/claim-gate.mjs`（gate / verifyAnswer / verifyFactLabels / verifyTransformation・既定deny）
  回帰 `node memory/business-os/evidence-e2e.mjs`（56項目）
  ＋ `node memory/business-os/fact-safety-e2e.mjs`（TEST01-15 含む64項目）。
- セッション開始時は `node scripts/session-handoff.mjs` で Evidence Policy と
  既知の品質事故（一般化ルール込み）を復元してから事実を答える。

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
- **【最上位】自律型AI Business OS（34章）。ルールの階層は `.claude/memory/RULES-INDEX.md` の1枚に固定。**
  目指すのは「AIに仕事を指示するシステム」ではなく「Business Goalを与えるとAI自身が必要な仕事を発見し、
  専門Agentを動かし、実行・検証・学習して事業成果を改善するシステム」。
  正典 `.claude/memory/business-os/requirements-v3-business-os.md`。
  最終KPIは Revenue / Gross Profit / LTV / CAC / Retention。局所KPI改善で最終利益が悪化する施策は成功としない。
  **Bottleneck First**（原因でない場所を触らない）。BUILD/GROW/REVENUE をDomain横断で診断し、
  自分の領域で勝手に他領域を変更せず上位へ報告してRoutingする。CVで終わらず受注・売上・粗利・LTVまで追う。
  SSoTを守り無い数字は UNKNOWN（推測で埋めない）。計測の正しさの確認が学習より先。
  Evidence と Confidence を必ず持つ。判定は5値以上。Knowledgeは Context 付きで失敗も保存。
  Risk別にHuman Approvalを入れ Rollback を用意する。Taskは発見順に処理しない。
  WAIT も正式な決定だが、データが十分なのに様子見を続けるのは違反。
  実装前に必ず現状調査を出す（Big Bang Rewrite禁止・既存の正常機能を作り直さない）。
- **広告依頼は上記に加えて広告AI PDCAパイプラインを必ず通す（33章）。**
  依頼を受けた側が自分で分析・修正・報告して終わらせるのは仕様未達。
  Research → Strategist → Experiment → Analyst → Knowledge を回す側に立つ。
  広告固有の正典は `.claude/memory/ad-pipeline/requirements-v2-autonomous.md`。
  CTR単体で成功判定しない／媒体を同じCTR基準で比較しない／1実験1主要変数／
  停滞したら手法を変える（14日・30日・45日で強制発動、判定はコードが出す）。
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
