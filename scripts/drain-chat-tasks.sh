#!/usr/bin/env bash
# drain-chat-tasks.sh — OPEN な Persistent Task を、時間の許す限り連続で処理する。
#
# 2026-08-17 実測: このリポジトリの scheduled workflow は cron の指定に関わらず
# GitHub 側で間引かれ、実際には1時間に1回しか発火しない。
#   automation-health "8,38"  -> 07:09, 08:08   (1回/時)
#   system-health     "13,43" -> 07:13, 08:23   (1回/時)
#   chat-task-consumer"11,41" -> 09:22          (1回/時)
# 1回1件しか処理しないと、4件溜まった時点で消化に4時間かかる。
# よって1回の起動で複数件を連続処理する。
#
# 使い方: drain-chat-tasks.sh <config-dir> <orchestrator-dir> [deadline-seconds]
#
# 各サイクルの流れ（1件ぶん）:
#   consume -> 暫定outcome設置 -> Worker実行 -> apply(+競合retry付きpush) -> 次へ
#
# 終了コード:
#   0 = 1件以上前進した、または処理対象が無かった
#   1 = 拾ったが1件も前進しなかった（偽greenにしない）
set -uo pipefail

CONFIG="${1:?config-dir}"
ORCH="${2:?orchestrator-dir}"
BUDGET="${3:-2400}"          # 既定40分。workflowのtimeoutより短くする
MAX_TASKS="${MAX_TASKS:-4}"

START=$(date +%s)
DEADLINE=$((START + BUDGET))
advanced=0
picked_total=0

log() { echo "[drain] $*"; }

for n in $(seq 1 "$MAX_TASKS"); do
  now=$(date +%s)
  remaining=$((DEADLINE - now))
  # Worker 1回に最低5分は要る。残りが足りなければ次の起動に回す。
  if [ "$remaining" -lt 300 ]; then
    log "残り時間 ${remaining}s。ここで打ち切り、残りは次のscheduled runへ回す"
    break
  fi

  cd "$CONFIG"
  set +e
  OUT=$(node scripts/chat-task.mjs consume --agent cloud-consumer)
  CODE=$?
  set -e
  if [ "$CODE" = "3" ]; then
    log "サイクル${n}: 実行対象なし"
    break
  fi
  if [ "$CODE" != "0" ]; then
    log "サイクル${n}: consume が失敗した (exit=$CODE)"
    echo "$OUT"
    break
  fi

  TID=$(printf '%s' "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).task_id)}catch(e){console.log('')}})")
  NEXT=$(printf '%s' "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).next_action)}catch(e){console.log('')}})")
  if [ -z "$TID" ]; then
    log "サイクル${n}: task_id を読めなかった"
    break
  fi
  picked_total=$((picked_total + 1))
  log "サイクル${n}: $TID を取得（残り ${remaining}s）"

  # Worker が打ち切られても next_action が失われないよう、先に暫定outcomeを置く。
  CURRENT_NEXT_ACTION="$NEXT" node -e "
  const fs=require('fs');
  fs.writeFileSync('.chat-task-outcome.json', JSON.stringify({
    status:'advanced',
    evidence:'Workerが実行を開始したが、結果を報告せずに終了した（turn上限/timeout/クラッシュのいずれか）。成果の内容は未確認。',
    next_action: process.env.CURRENT_NEXT_ACTION,
    resume_point:'worker-unreported',
  },null,2));"

  # Worker の持ち時間は残り時間から決める（最後の1件が枠を食い潰さないように）。
  turns=40
  [ "$remaining" -lt 900 ] && turns=20

  set +e
  npx -y @anthropic-ai/claude-code@latest -p "あなたは自律継続Workerです。ユーザーは不在で、質問は一切できません。 Task: ${TID} / next_action: ${NEXT} 。安全な範囲(読み取り・分析・可逆なファイル変更)のみ実行すること。 blocked にしてよいのは次の7つだけです: 有料契約 / Credential / 法的判断 / 重大な不可逆操作 / 重大な金銭判断 / オーナーにしか決められない経営判断 / AIで安全に解消できないHigh-Risk Conflict。 Context不足・別Repo・別Agent・Test・調査・修正・次Stepは blocker ではありません。自分で解消するか、次のnext_actionに落として advanced にしてください。 **最初にやることは分割です。** 与えられた next_action が1回の実行(${turns}ターン以内)で終わらない大きさなら、着手する前に .chat-task-outcome.json を status=advanced で書き、next_action には「最初の小さな1Step」だけを入れて保存すること。分割して保存した時点でそれがこの実行の成果です。残りは次の実行が続けます。小さな1Stepとは「対象ファイルを読んで現状を1つ記録する」「1箇所だけ直す」「1つだけ実測する」程度の粒度です。分割を保存したら、そのまま最初の1Stepを実行してよい。 報告は カレントディレクトリの .chat-task-outcome.json に書く。既に暫定版が置いてあるので、作業を始める前に一度自分の内容で上書きし、進捗があるたびに上書きし直すこと。最後にまとめて書こうとすると turn 上限で報告が失われる。スキーマ: {\"status\":\"advanced\"|\"completed\"|\"blocked\", \"evidence\":\"何を実測したかを具体的に(必須)\", \"next_action\":\"次にやる具体的Action(statusがadvancedなら必須)\", \"resume_point\":\"任意\", \"blocker\":\"statusがblockedなら理由\"} 。Root Goalがまだ達成できていないなら status は advanced にし、next_action に次の一手を必ず入れること。完全に達成できた場合のみ completed にすること。" \
    --permission-mode bypassPermissions \
    --max-turns "$turns" \
    --output-format stream-json --verbose >> "worker-${TID}.log" 2>&1
  WCODE=$?
  set -e
  log "サイクル${n}: worker exit=$WCODE"

  cp .chat-task-outcome.json "/tmp/outcome-${TID}.json" 2>/dev/null || true

  # 台帳へ反映。他ワークフローが main を進めていたら取り直して再適用する。
  applied=0
  for attempt in 1 2 3 4 5; do
    git fetch -q origin main
    git reset -q --hard origin/main
    if ! node "$ORCH/scripts/chat-task-apply.mjs" \
         --config-dir . --task "$TID" --outcome "/tmp/outcome-${TID}.json" \
         > "$ORCH/apply-${TID}.log" 2>&1; then
      cat "$ORCH/apply-${TID}.log"
      log "サイクル${n}: outcome を反映できなかった"
      break
    fi
    cat "$ORCH/apply-${TID}.log"
    git add memory/business-os/chat-tasks.json
    if git diff --cached --quiet; then log "台帳に変更なし"; applied=1; break; fi
    git commit -q -m "chat-task: $TID を前進させた"
    if git push -q origin HEAD:main; then applied=1; break; fi
    log "push rejected (${attempt}回目) — 台帳を取り直して再適用する"
    sleep $((attempt * 3))
  done

  if [ "$applied" = "1" ]; then
    advanced=$((advanced + 1))
  else
    # 前進しなかった記録を残す（起動したが未報告）。
    node "$ORCH/scripts/chat-task-reclaim.mjs" \
      memory/business-os/chat-tasks.json "$TID" \
      --max-attempts 3 --force --reason "worker exit=$WCODE / 台帳反映に失敗" || true
    git add memory/business-os/chat-tasks.json || true
    git diff --cached --quiet || {
      git commit -q -m "chat-task: $TID の失敗を記録"
      for attempt in 1 2 3; do
        git push -q origin HEAD:main && break
        git pull --rebase -q origin main || git rebase --abort || true
        sleep $((attempt * 3))
      done
    }
  fi
done

log "取得 ${picked_total}件 / 前進 ${advanced}件 / 経過 $(( $(date +%s) - START ))s"

if [ "$picked_total" -gt 0 ] && [ "$advanced" = "0" ]; then
  echo "::error::${picked_total}件拾ったが1件も前進しなかった"
  exit 1
fi
exit 0
