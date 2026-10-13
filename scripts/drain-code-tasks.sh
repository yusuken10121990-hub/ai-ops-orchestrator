#!/usr/bin/env bash
# drain-code-tasks.sh — code-task-queue.json の queued を、時間の許す限り連続で処理する。
#
# drain-chat-tasks.sh の雛形。台帳操作は config/scripts/code-task-queue-cloud.mjs
# (gate / claim / finish)。claim は gate を通る(auto- / reversible:true /
# money_involved:false / secret注入なし)ものだけを拾う。
#
# 使い方: drain-code-tasks.sh <config-dir> [deadline-seconds]
# 終了コード: 0 = 前進した/対象なし/クォータ枯渇, 1 = 拾ったが1件も完了しなかった
set -uo pipefail

CONFIG="${1:?config-dir}"
BUDGET="${2:-2400}"
MAX_TASKS="${MAX_TASKS:-4}"
QUEUE_REL="memory/code-task-queue.json"

START=$(date +%s)
DEADLINE=$((START + BUDGET))
advanced=0
picked_total=0

log() { echo "[drain-code] $*"; }

cd "$CONFIG" || exit 1

push_queue() {
  # $1 = commit message。競合時は取り直して再push。
  git add "$QUEUE_REL"
  git diff --cached --quiet && return 0
  git commit -q -m "$1"
  local a
  for a in 1 2 3 4 5; do
    git push -q origin HEAD:main && return 0
    git pull --rebase -q origin main || git rebase --abort >/dev/null 2>&1 || true
    sleep $((a * 3))
  done
  return 1
}

for n in $(seq 1 "$MAX_TASKS"); do
  remaining=$((DEADLINE - $(date +%s)))
  if [ "$remaining" -lt 300 ]; then
    log "残り時間 ${remaining}s。次のrunへ回す"
    break
  fi

  set +e
  OUT=$(node scripts/code-task-queue-cloud.mjs claim --agent cloud-code-consumer)
  CODE=$?
  set -e
  if [ "$CODE" = "3" ]; then log "サイクル${n}: 実行対象なし"; break; fi
  if [ "$CODE" != "0" ]; then log "サイクル${n}: claim 失敗 (exit=$CODE)"; echo "$OUT"; break; fi

  TID=$(printf '%s' "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).id)}catch(e){console.log('')}})")
  INSTR=$(printf '%s' "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).instructions)}catch(e){console.log('')}})")
  if [ -z "$TID" ]; then log "サイクル${n}: id を読めなかった"; break; fi
  picked_total=$((picked_total + 1))
  log "サイクル${n}: $TID を claim（残り ${remaining}s）"

  # in_progress を先にpushして二重取得を防ぐ。
  push_queue "code-task: $TID claimed" || log "claim の push に失敗（続行する）"

  turns=40
  [ "$remaining" -lt 900 ] && turns=20

  set +e
  npx -y @anthropic-ai/claude-code@latest -p "あなたは自律継続Workerです。ユーザーは不在で、質問は一切できません。 Task: ${TID}。安全な範囲(読み取り・分析・可逆なファイル変更)のみ実行すること。金銭・Credential・不可逆操作は行わない。 次の instructions を ${turns}ターン以内で実行し、終わったら最後に1行で結果を要約して終了すること: ${INSTR}" \
    --permission-mode bypassPermissions \
    --max-turns "$turns" \
    --output-format stream-json --verbose >> "worker-${TID}.log" 2>&1
  WCODE=$?
  set -e
  log "サイクル${n}: worker exit=$WCODE"

  if tail -c 8000 "worker-${TID}.log" | grep -q '"api_error_status":429'; then
    log "QUOTA_EXHAUSTED: 中断。attemptを消費せず queued に戻す"
    node scripts/code-task-queue-cloud.mjs finish "$TID" needs_owner "quota" >/dev/null 2>&1 || true
    # needs_owner にはせず queued へ戻す
    node -e "
    const fs=require('fs');const p='$QUEUE_REL';const q=JSON.parse(fs.readFileSync(p,'utf8'));
    const t=q.tasks.find(x=>x.id==='$TID');if(t){t.status='queued';delete t.finished_at;delete t.result;}
    fs.writeFileSync(p,JSON.stringify(q,null,2)+'\n');"
    push_queue "code-task: $TID quota待ちでqueuedへ戻す" || true
    touch /tmp/quota-exhausted
    break
  fi

  # Worker のファイル変更を保全してから台帳を更新する。
  git add -A
  git diff --cached --quiet || git commit -q -m "code-task: $TID worker成果物"

  if [ "$WCODE" = "0" ]; then OUTCOME=done; RES="cloud worker 完了"; else OUTCOME=failed; RES="worker exit=$WCODE"; fi

  applied=0
  for attempt in 1 2 3 4 5; do
    git fetch -q origin main
    if ! git rebase -q origin/main; then
      git rebase --abort >/dev/null 2>&1 || true
      git reset -q --hard origin/main
    fi
    if ! node scripts/code-task-queue-cloud.mjs finish "$TID" "$OUTCOME" "$RES"; then
      log "サイクル${n}: finish に失敗"
      break
    fi
    git add "$QUEUE_REL"
    git commit -q -m "code-task: $TID $OUTCOME"
    if git push -q origin HEAD:main; then applied=1; break; fi
    log "push rejected (${attempt}回目) — 取り直して再適用"
    sleep $((attempt * 3))
  done

  if [ "$applied" = "1" ] && [ "$OUTCOME" = "done" ]; then
    advanced=$((advanced + 1))
  fi
done

log "取得 ${picked_total}件 / 完了 ${advanced}件 / 経過 $(( $(date +%s) - START ))s"

if [ -f /tmp/quota-exhausted ]; then log "クォータ枯渇のため待機終了"; exit 0; fi
if [ "$picked_total" -gt 0 ] && [ "$advanced" = "0" ]; then
  echo "::error::${picked_total}件拾ったが1件も完了しなかった"
  exit 1
fi
exit 0
