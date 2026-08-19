<!-- BEGIN shared-rules (auto) -->
# 共通ルール（AI組織・自動同期・手で編集しないでください）

このブロックは `ai-ops-config` リポジトリの `SHARED_RULES.md`（正典）から自動生成されています。
**ルールを追加・変更したい場合はこのファイルではなく、正典
`https://github.com/yusuken10121990-hub/ai-ops-config/blob/main/SHARED_RULES.md` を編集してください。**
PC・クラウド(スマホ含む)どちらの環境から編集してもOKです。次回の自動同期(毎日)で全リポジトリに
反映されます。即時反映したい場合は `gh workflow run rules-propagate.yml -R yusuken10121990-hub/ai-ops-orchestrator`。

## セッション開始時にまずこれ（Session Handoff・GOVERNANCE §55 / SHARED_RULES 38章）
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

## Web関連タスクの標準動作（GOVERNANCE §56 / SHARED_RULES 39章）
**「まずブラウザを操作する」ではなく「目的を達成できる最速・最小コストの経路を選ぶ」。**

既存API > 検索API > HTTP直接 > CLI/curl > DOM > Playwright > DevTools MCP > 拡張GUI > 画像認識操作。
上位で達成できるなら下位を使わない。認証 / JSレンダリング / UI固有操作 / 実ブラウザ検証が必要なときだけ
自動的に次の手段へフォールバックする（オーナーに可否を聞かない）。

- **Googleをブラウザで開いて検索欄に入力し結果画面を読む操作は原則禁止。** 検索API/HTTP等の高速手段を使う。
  対象URLが判明したらそのURLへ直接アクセスする。**URLが既知なら検索を経由しない**。同じURLを何度も検索し直さない。
- テキスト/HTML/JSON/構造化データを取るだけならGUIを起動しない。JSレンダリングが要るときだけブラウザへ。
- ブラウザを使うのは: ログイン済みセッション / Cookie / JS実行後でないと取れない / SPA / UI操作そのものが目的 /
  表示状態・レイアウト検証 / DevTools解析 / CAPTCHA / ブラウザ上でしか動かないサービス。
- **DOM優先**（DOM > accessibility tree > selector > element metadata > URL・Network > スクショ解析）。
  操作のたびにスクショを撮らない。固定sleepでなく条件ベース待機（element出現 / network idle / URL変化）。
- 既存Chromeセッションを再利用する。独立作業は並列化。取得済みのURL/DOM/APIレスポンスは再利用する。
- 巨大なHTML/DOM/ログをそのままコンテキストへ入れない。必要部分だけ抽出する。
- **速度のために 正確性 / 最新性 / 認証 / セキュリティ / 操作確認 / 完了確認 / エラー検知 を犠牲にしない。**
  「速いが間違っている」は禁止。目標は FAST + CORRECT + SAFE。
- 競合時: 安全性 > 正確性 > オーナーの明示的要求 > 本ルール > その他。金銭ゲート・支払い方法登録の非代行・
  Evidence First(36章)・UI Resource Safety(37章)・Session Handoff(38章) は本ルールより上位のまま。
- 環境のegress制限等で上位手段が使えないときは「できません」で終わらせず、19章のブラウザ作業ハンドオフキュー
  (`memory/browser-task-queue.json`) へ積む。**遮断の事実と、試した経路と結果を必ず明示する**（推測で不可能と言わない）。

## 最上位: Global Governance
- **正典は1か所** `ai-ops-config/memory/governance/GOVERNANCE.md`（機械可読版 `governance/governance.json`・**現行 v1.2.0**）。
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

### QUALITY OPERATING SYSTEM（2026-08-17オーナー制定・全Repo/全Agent/全Session共通）
**TRUST THE DATA, VERIFY THE MODEL.** LLMの注意力・記憶・プロンプト遵守だけを信用しない。
LLM proposes → 独立した検証層（Evidence/Scope/Semantic/Temporal/Consistency/Risk/Action/Output）
→ PASSした場合のみ回答・実行。HIGH-RISKはFail-Closed。

- **中央ポリシー**: `ai-ops-config/memory/governance/quality-policy.json`（Version管理・
  25検証レイヤ・Risk Tier R0-R5・HIGH-RISK Action一覧・前提条件・停止条件・既知事故Regression 4件）。
  実装は `scripts/quality-gate.mjs`（Scope/Temporal/Completeness/DataValidity/Assumption/
  ActionGate/OutputType/PostExecution/Anomaly/Fail-Closed wrapper/自動回帰生成）。
- **SCOPE VALIDATION**: Evidence ScopeとClaim Scopeの不一致= `SCOPE_MISMATCH` でBlock。
  **Partial ScopeからGlobal Conclusionを作るの禁止**（LINE脚のnotify.sent=falseをSlack全体の
  失敗と結論した事故の一般化。1キャンペーンCV0→広告全体CV0も同罪）。
- **Presence != Validity**: データが存在しても invalid/stale/partial/test/shadow/estimated/
  untrusted なら判断に使用禁止（誤った停滞データ→Campaign PAUSE事故の一般化）。
- **TEMPORAL**: 「昨日ACTIVEだった」を「現在ACTIVE」と断定禁止。currentの断定は鮮度要件を満たす
  data_as_of が必要。無ければ時点を限定して述べる。
- **OUTPUT TYPE**: 出力を COMMAND/CODE/DATA/QUOTE/EXAMPLE/EXPLANATION/REPORT/INSTRUCTION に
  型分けし、**QUOTE/DATA/EXAMPLEを実行可能Commandのように提示禁止**（JSON引用をPowerShellへ
  貼れるように見せた事故の一般化）。実行可能提示は検証済みCOMMANDのみ。
- **ACTION GATE**: 広告のPAUSE/ENABLE/予算/入札/ターゲティング/CV定義、本番Deploy、データ削除、
  送信、課金、公開、契約、権限変更、外部API書込はHIGH-RISK。前提条件（data_valid/scope_valid/
  freshness/tracking/sample/decision_rule/no_contradiction等）が**未確認(undefined)=不成立**として
  評価され、1つでも不成立なら `BLOCK_ACTION`。**PLAN→VALIDATE→EXECUTE→VERIFY** を分離し、
  実行後は intended vs actual を実ソースで確認（成功コード=成功ではない）。
- **STOP CONDITIONS**: UNKNOWN / UNVERIFIED / INVALID / STALE / CONTRADICTED / PARTIAL /
  SCOPE_MISMATCH / MISSING_PRECONDITION / SEMANTIC_DRIFT / ENTITY_LOSS / AGGREGATION_ERROR /
  SOURCE_UNAVAILABLE / **VALIDATION_UNAVAILABLE（検証系自体の故障もFail-Closed）** では断定・実行しない。
- **INCIDENT LEARNING**: AIのミス確認＝Quality Incident化（33分類のRoot Cause taxonomy）→
  一般化ルール→自動回帰ケース生成（`regression-cases.json`）→全Repo伝搬。同一Root Causeの再発は
  SEV3→SEV2→SEV1へエスカレーション。**ルールが存在するのに再発した場合はRUNTIME_BYPASS
  （Runtime Enforcement Failure）を疑い迂回経路を監査する。** Prompt追記だけの対策は禁止
  （schema/validator/assertion/test/runtime gateとしてコード化する）。
- 回帰: `node memory/business-os/quality-e2e.mjs`（既知事故TEST A-O＋Property/Fuzz/
  Metamorphic/Adversarial）。既知事故4件（Meta誤分類/Slack Scope/Output Type/Invalid Data Pause）は
  永久Regression。

## UI RESOURCE SAFETY（AIが開いた画面の後片付け・SHARED_RULES 37章・全Repo共通）
**IF AI OPENED IT, AI OWNS ITS CLEANUP.
ただしユーザーが元から開いていた画面を勝手に閉じることは禁止する。**
この2つを同時に満たすこと。「開いている画面を全部閉じる」は重大な違反。

- **Ownership**: `AGENT_OWNED`(Cleanup対象) / `USER_OWNED`・`SYSTEM_OWNED`・`UNKNOWN`(触らない) /
  `SHARED`(安全性を確認)。**UNKNOWN を AGENT_OWNED と推測しない**（既定は DO_NOT_CLOSE）。
  別Agent・別Session・別Taskが開いた資源も閉じない。
- **追跡**: UIを開いた瞬間に台帳へ登録する。対象はブラウザWindow/Tab・Terminal・PowerShell・
  cmd・Explorer・Editor/VS Code・Dialog・Popup・設定画面・Preview・認証画面・一時アプリ・
  DevTools・テスト窓。特定アプリだけHardcodeしない。
- **Task Complete Gate（最終強制条件）**: Agent-owned な一時UIが残っている限り Task を
  Complete にしない（`WORK_DONE_CLEANUP_PENDING`）。
  **「Closeを送った」だけでは成功にしない** — 実際に消えたことを確認して初めて `CLEANUP_VERIFIED`。
- **最小作用**: Tabで済むならWindowを閉じない。Windowで済むならApplicationをKillしない。
  Force Killから始めるのは禁止。
- **保護優先**: 未保存データは勝手にDiscardしない。Server/watcher等は `SERVICE_RESOURCE` として
  UI Cleanupで止めない。意図的保持は理由と解除条件が必須（理由なし保持・永久放置は禁止）。
- **Session終了/Handoff**: 「とりあえず全部残して次へ」は禁止。残すなら理由・解除条件・次の所有者を引き継ぐ。
- **KPI**: `task_completed_with_open_agent_ui = 0` / `user_resource_wrongly_closed = 0`。
- 実装 `scripts/ui-resource-manager.mjs` / 設定 `memory/governance/ui-resource-policy.json` /
  回帰 `node memory/business-os/ui-cleanup-e2e.mjs`（74項目）。
- 不要画面を残したら `UI_CLEANUP_INCIDENT` として記録する。**同じ原因の再発は
  Agentの注意力の問題ではなく Runtime Enforcement の欠陥として扱う。**

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
