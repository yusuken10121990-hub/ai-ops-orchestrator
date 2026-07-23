#!/usr/bin/env bash
# jobqueue-runner-loop.sh
#
# Cloud port of the Windows-only execution engine
# C:\Users\user\Desktop\開発フォルダ\jobqueue\jobqueue\runner.ps1 (Run-One + its
# per-type handlers). This is the Tier-0 item from pc-off-migration-plan.md:
# jobqueue-gate (Railway) already records approvals PC-independently, but
# until this script exists, nobody actually *executes* an approved or
# self-build job when the owner's PC is off. See decisions.md 2026-07-23
# ("Tier0 runner.ps1のクラウド化") for the full writeup.
#
# One invocation = lease at most ONE job, run it to completion (or an
# explicit /runner/fail), then exit. The calling workflow's 5-minute cron
# is the poll loop (mirrors creative-studio-apply-runner.yml's pattern; see
# that file for why concurrency.group + cancel-in-progress:false matters).
# Note the backend itself also enforces running_runner_count() < 1 server-side
# (app/db.py lease_for_runner), so this cloud runner and the owner's local
# runner.ps1 (if both happen to be polling at once) can never double-process
# the same job -- no additional locking needed on our side for that case.
#
# ============================= SCOPE (read this) =============================
# Ported with full parity (safety guards included): build_plan, build_apply
# (self-modifying jobqueue-backend -- the actual "自己構築" engine),
# research_weekly, meo_backend, meo_plan, meo_apply, agent_propose,
# agent_create, marketing_propose, marketing_apply, and the generic/freeform
# agent-job path (types: freeform, research, existing_service).
#
# NOT ported yet (job leased -> immediately /runner/fail with a clear,
# actionable message, never silently dropped or left to hang -- see
# fail_unsupported() below): campaign, new_product, publish, lp_preview,
# lp_publish, new_backend_apply, new_product_apply.
# Reason: these all depend on a *persistent* per-campaign working folder
# under the owner's C:\Users\user\ai-business\campaigns\<id>\ tree that
# checkout-ai-business.sh does not currently mirror (only marketing/
# google-ads/.claude/memory are), and/or (new_backend_apply, new_product_apply)
# shell out to Windows PowerShell scaffold scripts (new-dev.ps1, new-product.ps1)
# that invoke gh/railway CLIs interactively -- porting those is a separate,
# larger piece of work tracked as Tier-2 (see decisions.md 2026-07-23).
# A job that lands here with max_attempts=1 (most of these do -- see
# app/db.py enqueue_* calls) goes straight to status=dead after one
# fail_unsupported() call; it is NOT lost -- POST /admin/retry (x-agent-key)
# resets attempts to 0 and requeues it for whenever a runner that supports
# the type (local runner.ps1, or a future cloud port) next leases it.
# ===============================================================================
#
# Translation notes vs. runner.ps1's "3 pieces of hand-applied surgery"
# (CLAUDE.md in the jobqueue-backend repo forbids removing these locally --
# they are Windows-PowerShell-specific workarounds and must NOT be
# reintroduced here verbatim):
#   (a) claude.exe full path invocation -> replaced with
#       `npx -y @anthropic-ai/claude-code@latest -p ...`, same as
#       scripts/run-loop.sh already does for every other cloud loop.
#   (b) Latin-1 re-decode of task text (PowerShell 5.1's Invoke-RestMethod
#       has a known charset-sniffing bug that can mis-decode UTF-8 JSON
#       response bodies as Windows-1252/Latin-1) -> DELETED, not translated.
#       `curl | jq` decodes UTF-8 JSON correctly by default; re-applying the
#       Latin-1 round-trip here would *introduce* mojibake into already-
#       correct text rather than fix it. Confirmed via app/api.py: bodies are
#       stored/returned as normal UTF-8 JSON, the bug is purely a Windows
#       HTTP-client-side artifact.
#   (c) [Console]::OutputEncoding = UTF8 -> not needed; GitHub Actions
#       ubuntu-latest runners default to a UTF-8 locale already.
#
# Required env: GATE_URL, RUNNER_API_KEY, GATE_AGENT_KEY, and one of
# CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY. Optional: JOBQUEUE_BACKEND_DIR,
# MEO_BACKEND_DIR (working dirs for self-modifying repos, cloned on demand
# if the corresponding deploy-key SSH alias was registered by
# setup-ssh-keys.sh). CONFIG_DIR must already be checked out (ai-ops-config,
# same convention as run-loop.sh) -- this script mirrors it into
# $HOME/.claude for role/memory-digest injection exactly like run-loop.sh does,
# and the calling workflow is responsible for copying $HOME/.claude back into
# CONFIG_DIR and pushing (same pattern as run-loop.sh's step 6).
set -uo pipefail  # NOT -e: each job-type handler must reach its own
                   # /runner/complete or /runner/fail even if an intermediate
                   # step errors, mirroring runner.ps1's try/catch-per-job
                   # structure. Every external call below checks its own exit
                   # code explicitly instead.

BACKEND="${GATE_URL:?GATE_URL not set}"
RUNNER_KEY="${RUNNER_API_KEY:?RUNNER_API_KEY not set}"
AGENT_KEY="${GATE_AGENT_KEY:?GATE_AGENT_KEY not set}"
RUNNER_ID="${RUNNER_ID:-runner-gh-actions-01}"
MAX_TURNS="${MAX_TURNS:-15}"
LEASE_SEC="${LEASE_SEC:-1200}"
CONFIG_DIR="${CONFIG_DIR:-${GITHUB_WORKSPACE:-$(pwd)}/config}"
HOME_CLAUDE="${HOME}/.claude"
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
JOBQUEUE_BACKEND_DIR="${JOBQUEUE_BACKEND_DIR:-${WORKSPACE}/jobqueue-backend}"
MEO_BACKEND_DIR="${MEO_BACKEND_DIR:-${WORKSPACE}/meo-backend}"
MEO_HEALTH_URL="https://web-production-b987dd.up.railway.app/health"

if [ ! -d "${CONFIG_DIR}" ]; then
  echo "ERROR: config dir not found: ${CONFIG_DIR}" >&2
  exit 1
fi
mkdir -p "${HOME_CLAUDE}"
cp -r "${CONFIG_DIR}/." "${HOME_CLAUDE}/"

AUTH_MODE=""
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then AUTH_MODE="oauth"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then AUTH_MODE="api_key"
else echo "ERROR: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set." >&2; exit 1
fi
echo "[jobqueue-runner] auth mode: ${AUTH_MODE}"

# ---------------------------------------------------------------- HTTP helpers
post_runner() { # path json-body
  curl -sS -X POST "${BACKEND}$1" -H "x-runner-key: ${RUNNER_KEY}" \
    -H "Content-Type: application/json; charset=utf-8" -d "$2"
}
post_agent() { # path json-body
  curl -sS -X POST "${BACKEND}$1" -H "x-agent-key: ${AGENT_KEY}" \
    -H "Content-Type: application/json; charset=utf-8" -d "$2"
}
get_runner() { # path
  curl -sS "${BACKEND}$1" -H "x-runner-key: ${RUNNER_KEY}"
}
complete_job() { # job_id result-json [cost_usd]
  local jid="$1" result="$2" cost="${3:-null}"
  post_runner "/runner/complete" "$(jq -nc --arg j "$jid" --argjson r "$result" --argjson c "$cost" \
    '{job_id:$j, result:$r, cost_usd:$c}')" >/dev/null
}
fail_job() { # job_id error-string
  local jid="$1" err="$2"
  post_runner "/runner/fail" "$(jq -nc --arg j "$jid" --arg rid "$RUNNER_ID" --arg e "$err" \
    '{job_id:$j, runner_id:$rid, error:$e}')" >/dev/null
}
fail_unsupported() {
  local msg="cloud runner (jobqueue-runner.yml) does not implement job type '${JOB_TYPE}' yet (Tier-2 backlog, see decisions.md 2026-07-23). Run local runner.ps1, or once support lands, POST /admin/retry?job_id=${JOB_ID} (x-agent-key) to requeue without losing the approval."
  echo "[jobqueue-runner] unsupported type=${JOB_TYPE} job=${JOB_ID} -> /runner/fail"
  fail_job "${JOB_ID}" "${msg}"
}

# ------------------------------------------------------------- prompt helpers
# Read-RoleBody equivalent: .claude/agents/<agent>.md minus YAML frontmatter, capped 4000 chars.
role_body() {
  local agent_lc f
  agent_lc="$(echo "$1" | tr '[:upper:]' '[:lower:]')"
  f="${HOME_CLAUDE}/agents/${agent_lc}.md"
  [ -f "${f}" ] || return 0
  awk 'BEGIN{c=0} /^---[ \t]*$/{c++; if(c==2){next}} c<2 && /^---/{next} c>=2{print} c==0{next}' "${f}" \
    | head -c 4000
}
# Read-MemoryDigest equivalent: concatenate a fixed list of memory files, each capped.
memory_digest() {
  local mdir="${HOME_CLAUDE}/memory" n cap fp
  for n in decisions.md playbook.md knowledge.md kpi.md business_context.md worklog.md rubrics.md preferences.md; do
    fp="${mdir}/${n}"
    [ -f "${fp}" ] || continue
    cap=2000
    case "$n" in rubrics.md|preferences.md) cap=4000 ;; esac
    echo "### ${n}"
    # deny-filter: strip lines referencing archived-business context (same list as runner.ps1)
    grep -vE '安否確認|SafeTrace|missing-person|マッチングAI|徘徊' "${fp}" | head -c "${cap}"
    echo ""
    echo ""
  done
}
# Build-Prompt equivalent. $1=agent $2=task-text $3=inject_learning(0/1)
build_prompt() {
  local agent="$1" task="$2" inject="${3:-0}" head="" tail=""
  if [ "${inject}" = "1" ]; then
    local role mem
    role="$(role_body "${agent}")"
    if [ -n "${role}" ]; then head+=$'# あなたの役割定義（'"${agent}"$')\n'"${role}"$'\n\n'; fi
    mem="$(memory_digest)"
    if [ -n "${mem}" ]; then head+=$'# 過去の学び（必ず踏まえる）\n'"${mem}"$'\n'; fi
    tail=$'\n# 学びの記録（重要）\n上のRESULT_JSONに"learning"フィールドも足し、今回得た学び（決定と理由/効いた・外した/信頼度/出典）を1〜3行で入れること。無ければ空文字。'
  fi
  printf '%s' "${head}あなたは「${agent}」として行動してください。
タスク:
${task}

# 厳守ルール
- お金・契約・公開・デプロイ・広告出稿・ドメイン取得など「現実世界の行為」は絶対に自分で実行しないこと。
  必要な場合は実行せず、最後のRESULT_JSONで \"requires_action\": true にして、何を承認してほしいかをsummaryに書く。
- .envや鍵・シークレットにはアクセスしないこと。
- 作業（調査・草案・制作物の作成など、現実に影響しない範囲）は進めてよい。

# 出力規約（最重要）
作業の一番最後に、必ず次の1行だけを単独で出力すること（前後に余計な記号を付けない）:
RESULT_JSON: {\"summary\":\"成果の要約を3〜5行で\",\"artifacts\":[\"生成物のパスやリンク（無ければ空配列）\"],\"requires_action\":false}${tail}"
}
# Extract-Result equivalent. Reads claude's raw text result from stdin, echoes a
# {summary,artifacts,requires_action,learning} JSON object on stdout.
extract_result() {
  local text tail_json
  text="$(cat)"
  tail_json="$(printf '%s' "${text}" | sed -n 's/.*RESULT_JSON:[[:space:]]*//p' | tail -1)"
  if [ -n "${tail_json}" ] && echo "${tail_json}" | jq -e . >/dev/null 2>&1; then
    jq -c '{summary: (.summary // ""), artifacts: (.artifacts // []), requires_action: (.requires_action // false), learning: (.learning // "")}' <<<"${tail_json}"
    return 0
  fi
  # fallback: no parseable RESULT_JSON -- use a truncated raw excerpt, same as runner.ps1.
  jq -nc --arg s "$(printf '%s' "${text}" | head -c 600)" \
    '{summary: $s, artifacts: [], requires_action: false, learning: ""}'
}
# run_claude: $1=prompt $2=extra claude args (string, word-split) $3=max_turns override(optional)
# Writes claude's parsed {result_text, cost_usd} as a JSON object on stdout, or "" on hard failure.
run_claude() {
  local prompt="$1" extra_args="$2" turns="${3:-$MAX_TURNS}" raw parsed
  raw="$(npx -y @anthropic-ai/claude-code@latest -p "${prompt}" --output-format json --max-turns "${turns}" ${extra_args} 2>/tmp/claude_stderr_$$.log)"
  if [ -z "${raw}" ]; then
    echo "[jobqueue-runner] claude produced no output; stderr:" >&2
    cat "/tmp/claude_stderr_$$.log" >&2 2>/dev/null || true
    rm -f "/tmp/claude_stderr_$$.log"
    echo ""
    return 1
  fi
  rm -f "/tmp/claude_stderr_$$.log"
  if ! echo "${raw}" | jq -e . >/dev/null 2>&1; then
    echo "[jobqueue-runner] claude output not valid JSON" >&2
    echo ""
    return 1
  fi
  jq -c '{result_text: (.result // ""), cost_usd: (.total_cost_usd // null)}' <<<"${raw}"
}

# ---------------------------------------------------------------- git helpers
sha256_file() { sha256sum "$1" 2>/dev/null | awk '{print $1}'; }

# ------------------------------------------------------------------ handlers

run_generic() {
  # freeform / research / existing_service: same WorkDir convention as
  # runner.ps1's default Run-One path (WorkDir=~/ai-business). Requires the
  # calling workflow to have run checkout-ai-business.sh first and exported
  # AI_BUSINESS_DIR (same as creative-studio-apply-runner.yml / ad-lp-apply-daily.yml).
  local task_text prompt out result_text cost res requires_action summary artifacts
  task_text="$(echo "${PAYLOAD}" | jq -r '.text // (. | tostring)')"
  if [ -z "${AI_BUSINESS_DIR:-}" ] || [ ! -d "${AI_BUSINESS_DIR}" ]; then
    fail_job "${JOB_ID}" "generic job type '${JOB_TYPE}' needs AI_BUSINESS_DIR checked out (checkout-ai-business.sh) but it is missing/empty"
    return
  fi
  prompt="$(build_prompt "${AGENT}" "${task_text}" 1)"
  out="$(cd "${AI_BUSINESS_DIR}" && run_claude "${prompt}" "")"
  if [ -z "${out}" ]; then fail_job "${JOB_ID}" "claude出力が空 or JSON解析失敗"; return; fi
  result_text="$(echo "${out}" | jq -r '.result_text')"
  cost="$(echo "${out}" | jq '.cost_usd')"
  res="$(printf '%s' "${result_text}" | extract_result)"
  requires_action="$(echo "${res}" | jq '.requires_action')"
  if [ "${requires_action}" = "true" ]; then
    post_agent "/actions" "$(jq -nc --arg t "[${AGENT}] 要承認: ${JOB_ID}" --arg jid "${JOB_ID}" --arg s "$(echo "${res}" | jq -r '.summary')" \
      '{type:"execute_action", requires_approval:true, title:$t, payload:{job_id:$jid, summary:$s}}')" >/dev/null || true
  fi
  complete_job "${JOB_ID}" "$(echo "${res}" | jq '{summary, artifacts, requires_action}')" "${cost}"
  append_worklog "${AGENT}" "${task_text}" "${res}"
  echo "[jobqueue-runner] generic job complete job=${JOB_ID}"
}

append_worklog() {
  local agent="$1" task="$2" res="$3" wl="${HOME_CLAUDE}/memory/worklog.md" today entry learning req
  mkdir -p "$(dirname "${wl}")"
  [ -f "${wl}" ] || printf '# Worklog（実務ジョブの自動記録。/review が playbook へ整理する）\n\n' > "${wl}"
  today="$(date -u +%Y-%m-%d)"
  entry="- [${today}][${agent}] 依頼: $(printf '%s' "${task}" | tr '\n' ' ' | head -c 120) / 結果: $(echo "${res}" | jq -r '.summary' | tr '\n' ' ' | head -c 200)"
  learning="$(echo "${res}" | jq -r '.learning // ""')"
  [ -n "${learning}" ] && entry+=" / 学び: ${learning}"
  req="$(echo "${res}" | jq -r '.requires_action')"
  [ "${req}" = "true" ] && entry+=" / ※承認待ち(記録のみ)"
  printf '%s\n' "${entry}" >> "${wl}"
}

run_build() {
  # Port of Run-Build (build_plan + build_apply) targeting the jobqueue-backend
  # repo itself. build_apply carries the FULL safety-guard set from runner.ps1:
  # backup(git state)->snapshot protected files->edit->protected-file-touch
  # guard->no-change guard->push->wait-for-deploy(git_sha match)->rollback on
  # push-failure/timeout. This is the single most safety-critical port in this
  # script (it self-modifies the backend that runs the approval gate), so
  # nothing here is abbreviated relative to runner.ps1.
  local instr task
  instr="$(echo "${PAYLOAD}" | jq -r '.instr // ""')"
  task="$(echo "${PAYLOAD}" | jq -r '.text // .instr // ""')"

  if [ ! -d "${JOBQUEUE_BACKEND_DIR}/.git" ]; then
    if ! grep -q "jobqueue-backend-gh" "${HOME}/.ssh/config" 2>/dev/null; then
      fail_job "${JOB_ID}" "JOBQUEUE_BACKEND_DEPLOY_KEY not provisioned (setup-ssh-keys.sh skipped this alias) -- cannot check out jobqueue-backend for build_${JOB_TYPE#build_}"
      return
    fi
    git clone --depth 20 --branch master git@jobqueue-backend-gh:yusuken10121990-hub/jobqueue-backend.git "${JOBQUEUE_BACKEND_DIR}" \
      || { fail_job "${JOB_ID}" "git clone of jobqueue-backend failed"; return; }
  fi

  if [ "${JOB_TYPE}" = "build_plan" ]; then
    local prompt out result_text cost res
    prompt="$(build_prompt "Engineer" "${task}" 0)"
    out="$(cd "${JOBQUEUE_BACKEND_DIR}" && run_claude "${prompt}" "")"
    if [ -z "${out}" ]; then fail_job "${JOB_ID}" "計画: claude出力解析失敗"; return; fi
    result_text="$(echo "${out}" | jq -r '.result_text')"; cost="$(echo "${out}" | jq '.cost_usd')"
    res="$(printf '%s' "${result_text}" | extract_result)"
    complete_job "${JOB_ID}" "$(jq -nc --arg s "$(echo "${res}" | jq -r '.summary')" '{summary:$s, artifacts:[], requires_action:false}')" "${cost}"
    echo "[jobqueue-runner] build_plan complete job=${JOB_ID}"
    return
  fi

  # --- build_apply (承認済み・実行フェーズ) ---
  local protected=(".env" "docker-compose.yml" "runner.ps1" "runner.ps1.bak" "patch-runner-publish.ps1" "runner-service.ps1" "backup-backend.ps1" "restore-backend.ps1")
  local snap="${WORKSPACE}/prebuild_$$"
  mkdir -p "${snap}/protected"
  cp -r "${JOBQUEUE_BACKEND_DIR}/app" "${snap}/app"
  [ -f "${JOBQUEUE_BACKEND_DIR}/schema.sql" ] && cp "${JOBQUEUE_BACKEND_DIR}/schema.sql" "${snap}/"
  local -A existed
  for f in "${protected[@]}"; do
    if [ -e "${JOBQUEUE_BACKEND_DIR}/${f}" ]; then cp -r "${JOBQUEUE_BACKEND_DIR}/${f}" "${snap}/protected/${f}"; existed[$f]=1; else existed[$f]=0; fi
  done
  local fp_before fp_after
  fp_before="$(find "${JOBQUEUE_BACKEND_DIR}/app" -type f -exec sha256sum {} \; | sort)"

  local prompt out result_text cost res
  prompt="$(build_prompt "Engineer" "${task}" 0)"
  out="$(cd "${JOBQUEUE_BACKEND_DIR}" && run_claude "${prompt}" "--permission-mode acceptEdits")"
  if [ -z "${out}" ]; then
    restore_snapshot "${snap}" "${protected[@]}"
    fail_job "${JOB_ID}" "改修: claude出力解析失敗（変更は破棄）"
    rm -rf "${snap}"; return
  fi
  result_text="$(echo "${out}" | jq -r '.result_text')"; cost="$(echo "${out}" | jq '.cost_usd')"
  res="$(printf '%s' "${result_text}" | extract_result)"

  # protected-file-touch guard
  local touched=()
  for f in "${protected[@]}"; do
    local now_exists=0; [ -e "${JOBQUEUE_BACKEND_DIR}/${f}" ] && now_exists=1
    if [ "${existed[$f]}" = "0" ] && [ "${now_exists}" = "0" ]; then continue; fi
    if [ "${existed[$f]}" != "${now_exists}" ]; then touched+=("${f}"); continue; fi
    if [ -f "${snap}/protected/${f}" ] && [ -f "${JOBQUEUE_BACKEND_DIR}/${f}" ]; then
      [ "$(sha256_file "${snap}/protected/${f}")" != "$(sha256_file "${JOBQUEUE_BACKEND_DIR}/${f}")" ] && touched+=("${f}")
    fi
  done
  if [ "${#touched[@]}" -gt 0 ]; then
    restore_snapshot "${snap}" "${protected[@]}"
    complete_job "${JOB_ID}" "$(jq -nc --arg m "🛑 安全の中枢に触れる変更を検出したため、すべて破棄して元に戻しました（反映していません）。対象: ${touched[*]}" '{summary:$m, artifacts:[], requires_action:true}')" "${cost}"
    echo "[jobqueue-runner] guard triggered -> reverted: ${touched[*]}"
    rm -rf "${snap}"; return
  fi

  fp_after="$(find "${JOBQUEUE_BACKEND_DIR}/app" -type f -exec sha256sum {} \; | sort)"
  if [ "${fp_before}" = "${fp_after}" ]; then
    complete_job "${JOB_ID}" "$(jq -nc --arg m "ℹ️ claudeはファイルを変更しませんでした。反映していません。" '{summary:$m, artifacts:[], requires_action:true}')" "${cost}"
    rm -rf "${snap}"; echo "[jobqueue-runner] no-change, not deployed job=${JOB_ID}"; return
  fi

  # push -> wait for Railway git_sha match -> rollback on failure/timeout
  local pushed_sha
  pushed_sha="$(git_push_and_get_sha "${JOBQUEUE_BACKEND_DIR}" "build_apply: $(echo "${res}" | jq -r '.summary' | tr '\n' ' ' | head -c 200)" "master")"
  if [ -z "${pushed_sha}" ]; then
    (cd "${JOBQUEUE_BACKEND_DIR}" && git reset --hard HEAD~1 >/dev/null 2>&1)
    complete_job "${JOB_ID}" "$(jq -nc --arg m "❌ git pushに失敗したため反映を中止し、ローカルも元に戻しました（本番は無変更）。" '{summary:$m, artifacts:[], requires_action:true}')" "${cost}"
    rm -rf "${snap}"; echo "[jobqueue-runner] push failed -> local revert job=${JOB_ID}"; return
  fi
  local st; st="$(wait_deployed "${BACKEND}" "${pushed_sha}" 600)"
  if [ "${st}" = "matched" ]; then
    complete_job "${JOB_ID}" "$(jq -nc --arg m "✅ 本番(Railway)へ反映しました。sha=${pushed_sha}" --argjson a "$(echo "${res}" | jq '.artifacts')" '{summary:$m, artifacts:$a, requires_action:false}')" "${cost}"
    echo "[jobqueue-runner] build_apply deployed job=${JOB_ID} sha=${pushed_sha}"
  elif [ "${st}" = "no_sha" ]; then
    complete_job "${JOB_ID}" "$(jq -nc --arg m "🟡 pushは成功しましたが本番のgit_shaを確認できませんでした。sha=${pushed_sha}" '{summary:$m, artifacts:[], requires_action:true}')" "${cost}"
  else
    restore_snapshot "${snap}" "${protected[@]}"
    local revert_sha; revert_sha="$(git_push_and_get_sha "${JOBQUEUE_BACKEND_DIR}" "rollback (deploy timeout)" "master")"
    local rec="復旧push未確認・要確認"
    if [ -n "${revert_sha}" ] && [ "$(wait_deployed "${BACKEND}" "${revert_sha}" 600)" = "matched" ]; then rec="復旧OK(本番も戻し済み)"; fi
    complete_job "${JOB_ID}" "$(jq -nc --arg m "❌ 反映が確認できなかったため、元の状態に戻してpushしました（${rec}）。" '{summary:$m, artifacts:[], requires_action:true}')" "${cost}"
    echo "[jobqueue-runner] deploy timeout -> rolled back job=${JOB_ID}"
  fi
  rm -rf "${snap}"
}

restore_snapshot() {
  local snap="$1"; shift; local protected=("$@")
  rm -rf "${JOBQUEUE_BACKEND_DIR}/app"
  cp -r "${snap}/app" "${JOBQUEUE_BACKEND_DIR}/app"
  [ -f "${snap}/schema.sql" ] && cp "${snap}/schema.sql" "${JOBQUEUE_BACKEND_DIR}/"
  for f in "${protected[@]}"; do
    if [ -e "${snap}/protected/${f}" ]; then cp -r "${snap}/protected/${f}" "${JOBQUEUE_BACKEND_DIR}/${f}"; fi
  done
}

git_push_and_get_sha() { # dir commit-msg branch
  local dir="$1" msg="$2" branch="$3"
  ( cd "${dir}" && git add app schema.sql >/dev/null 2>&1
    git commit -m "${msg}" >/dev/null 2>&1
    if git push origin "${branch}" >/dev/null 2>&1; then
      git rev-parse HEAD
    else
      echo ""
    fi
  )
}

wait_deployed() { # backend_url sha timeout_sec
  local url="$1" sha="$2" timeout="$3" deadline saw_sha=0 now
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    local resp git_sha status_ok
    resp="$(curl -sS -m 5 "${url}/health" 2>/dev/null)"
    git_sha="$(echo "${resp}" | jq -r '.git_sha // empty' 2>/dev/null)"
    if [ -n "${git_sha}" ]; then
      saw_sha=1
      [ "${git_sha}" = "${sha}" ] && { echo "matched"; return; }
    fi
    sleep 10
  done
  [ "${saw_sha}" = "1" ] && echo "timeout" || echo "no_sha"
}

run_meo_backend() {
  # Safe mode: read-only investigation, no edits, no push. Ported 1:1.
  if [ ! -d "${MEO_BACKEND_DIR}/.git" ]; then
    if ! grep -q "meo-backend-gh" "${HOME}/.ssh/config" 2>/dev/null; then
      fail_job "${JOB_ID}" "MEO_BACKEND_DEPLOY_KEY not provisioned -- cannot check out meo-backend"
      return
    fi
    git clone --depth 5 --branch main git@meo-backend-gh:yusuken10121990-hub/meo-backend.git "${MEO_BACKEND_DIR}" \
      || { fail_job "${JOB_ID}" "git clone of meo-backend failed"; return; }
  fi
  local task health prompt out result_text cost res
  task="$(echo "${PAYLOAD}" | jq -r '.text // ""')"
  health="$(curl -sS -m 10 "${MEO_HEALTH_URL}" 2>/dev/null || echo 'health取得失敗')"
  local safe_task="対象は別プロジェクト meo-backend（作業フォルダ: ${MEO_BACKEND_DIR}）です。
# 安全モード（厳守）
- ファイルを編集・作成・削除しないこと。git add/commit/pushやデプロイは絶対にしないこと。
- 調査・読み取り・テスト実行・『変更案（提案）』の提示までに留めること。
- 参考: 本番URLの現在の/health = ${health}
依頼:
${task}"
  prompt="$(build_prompt "Engineer" "${safe_task}" 0)"
  out="$(cd "${MEO_BACKEND_DIR}" && run_claude "${prompt}" "")"
  if [ -z "${out}" ]; then fail_job "${JOB_ID}" "meo: claude出力解析失敗"; return; fi
  result_text="$(echo "${out}" | jq -r '.result_text')"; cost="$(echo "${out}" | jq '.cost_usd')"
  res="$(printf '%s' "${result_text}" | extract_result)"
  complete_job "${JOB_ID}" "$(jq -nc --arg m "【meo 安全モード／無変更】
$(echo "${res}" | jq -r '.summary')" --argjson a "$(echo "${res}" | jq '.artifacts')" '{summary:$m, artifacts:$a, requires_action:false}')" "${cost}"
  echo "[jobqueue-runner] meo_backend complete(no-change) job=${JOB_ID}"
}

run_meo_plan() {
  if [ ! -d "${MEO_BACKEND_DIR}/.git" ]; then
    if ! grep -q "meo-backend-gh" "${HOME}/.ssh/config" 2>/dev/null; then
      fail_job "${JOB_ID}" "MEO_BACKEND_DEPLOY_KEY not provisioned -- cannot check out meo-backend"
      return
    fi
    git clone --depth 5 --branch main git@meo-backend-gh:yusuken10121990-hub/meo-backend.git "${MEO_BACKEND_DIR}" \
      || { fail_job "${JOB_ID}" "git clone of meo-backend failed"; return; }
  fi
  local instr task prompt out result_text cost res
  instr="$(echo "${PAYLOAD}" | jq -r '.instr // .text // ""')"
  task="これは meo-backend への『改修の計画』フェーズです。コードや設定を一切変更しないこと。
作業フォルダ: ${MEO_BACKEND_DIR} 。必要なファイルを読み、次の依頼を実現する具体的な変更案を作る。
依頼: ${instr}
必ず次を日本語で含めること:
1) 変更するファイルと、具体的な変更内容
2) 保護ファイル(.env/Procfile/.python-version/.git)に触れる必要があるか
3) 想定リスクと、問題時に元へ戻せるか
最後のRESULT_JSONではsummaryにこの変更案の全文を入れ、artifactsは空配列、requires_actionはfalseにすること。"
  prompt="$(build_prompt "Engineer" "${task}" 0)"
  out="$(cd "${MEO_BACKEND_DIR}" && run_claude "${prompt}" "")"
  if [ -z "${out}" ]; then fail_job "${JOB_ID}" "meo計画: claude出力解析失敗"; return; fi
  result_text="$(echo "${out}" | jq -r '.result_text')"; cost="$(echo "${out}" | jq '.cost_usd')"
  res="$(printf '%s' "${result_text}" | extract_result)"
  complete_job "${JOB_ID}" "$(echo "${res}" | jq '{summary, artifacts: [], requires_action: false}')" "${cost}"
  echo "[jobqueue-runner] meo_plan complete job=${JOB_ID}"
}

run_meo_apply() {
  if [ ! -d "${MEO_BACKEND_DIR}/.git" ]; then
    if ! grep -q "meo-backend-gh" "${HOME}/.ssh/config" 2>/dev/null; then
      fail_job "${JOB_ID}" "MEO_BACKEND_DEPLOY_KEY not provisioned -- cannot check out meo-backend"
      return
    fi
    git clone --branch main git@meo-backend-gh:yusuken10121990-hub/meo-backend.git "${MEO_BACKEND_DIR}" \
      || { fail_job "${JOB_ID}" "git clone of meo-backend failed"; return; }
  fi
  local instr base_sha dirty
  instr="$(echo "${PAYLOAD}" | jq -r '.instr // ""')"
  ( cd "${MEO_BACKEND_DIR}" && git fetch origin main >/dev/null 2>&1 )
  base_sha="$(cd "${MEO_BACKEND_DIR}" && git rev-parse HEAD)"
  dirty="$(cd "${MEO_BACKEND_DIR}" && git status --porcelain)"
  if [ -n "${dirty}" ]; then
    complete_job "${JOB_ID}" "$(jq -nc --arg m "❌ meo-backend に未コミットの変更があるため安全に実行できません。" '{summary:$m, artifacts:[], requires_action:true}')"
    return
  fi
  local task prompt out result_text cost res
  task="これは meo-backend への『改修の実行』フェーズです（人間が承認済み）。
作業フォルダ: ${MEO_BACKEND_DIR} 。次の依頼どおりにコードを修正し、同じファイルに上書き保存すること。
依頼: ${instr}
保護ファイル(.env/Procfile/.python-version/.git)には触れないこと。触れないと実現できない場合は、何も変更せず理由をsummaryに書いて止まること。
gitやpush、デプロイは自分で実行しないこと（反映はシステムが行う）。"
  prompt="$(build_prompt "Engineer" "${task}" 0)"
  out="$(cd "${MEO_BACKEND_DIR}" && run_claude "${prompt}" "--permission-mode acceptEdits")"
  if [ -z "${out}" ]; then
    (cd "${MEO_BACKEND_DIR}" && git reset --hard "${base_sha}" >/dev/null 2>&1 && git clean -fd >/dev/null 2>&1)
    fail_job "${JOB_ID}" "meo改修: claude出力解析失敗（変更は破棄）"; return
  fi
  result_text="$(echo "${out}" | jq -r '.result_text')"; cost="$(echo "${out}" | jq '.cost_usd')"
  res="$(printf '%s' "${result_text}" | extract_result)"

  local changed protected=(".env" "Procfile" ".python-version" ".git") touched=()
  changed="$(cd "${MEO_BACKEND_DIR}" && git status --porcelain)"
  while IFS= read -r line; do
    [ -z "${line}" ] && continue
    local f; f="$(echo "${line}" | cut -c4-)"
    for pp in "${protected[@]}"; do
      case "${f}" in "${pp}"|"${pp}"/*) touched+=("${f}") ;; esac
    done
  done <<< "${changed}"
  if [ "${#touched[@]}" -gt 0 ]; then
    (cd "${MEO_BACKEND_DIR}" && git reset --hard "${base_sha}" >/dev/null 2>&1 && git clean -fd >/dev/null 2>&1)
    complete_job "${JOB_ID}" "$(jq -nc --arg m "🛑 保護ファイルに触れる変更を検出したため破棄して元に戻しました。対象: ${touched[*]}" '{summary:$m, artifacts:[], requires_action:true}')" "${cost}"
    return
  fi
  if [ -z "$(echo "${changed}" | tr -d '[:space:]')" ]; then
    complete_job "${JOB_ID}" "$(jq -nc --arg m "ℹ️ claudeはファイルを変更しませんでした。反映していません。" '{summary:$m, artifacts:[], requires_action:true}')" "${cost}"
    return
  fi
  ( cd "${MEO_BACKEND_DIR}" && git add -A && git commit -m "meo_apply: $(echo "${res}" | jq -r '.summary' | tr '\n' ' ' | head -c 200)" >/dev/null 2>&1 )
  if ! ( cd "${MEO_BACKEND_DIR}" && git push origin main >/dev/null 2>&1 ); then
    ( cd "${MEO_BACKEND_DIR}" && git reset --hard "${base_sha}" >/dev/null 2>&1 )
    complete_job "${JOB_ID}" "$(jq -nc --arg m "❌ git pushに失敗したため反映を中止し、ローカルも元に戻しました。" '{summary:$m, artifacts:[], requires_action:true}')" "${cost}"
    return
  fi
  local new_sha short_sha ok=0 deadline
  new_sha="$(cd "${MEO_BACKEND_DIR}" && git rev-parse HEAD)"
  short_sha="${new_sha:0:7}"
  sleep 15
  deadline=$(( $(date +%s) + 300 ))
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    local resp status git_sha
    resp="$(curl -sS -m 8 "${MEO_HEALTH_URL}" 2>/dev/null)"
    status="$(echo "${resp}" | jq -r '.status // empty' 2>/dev/null)"
    git_sha="$(echo "${resp}" | jq -r '.git_sha // empty' 2>/dev/null)"
    if [ "${status}" = "ok" ] && [ "${git_sha}" = "${short_sha}" ]; then ok=1; break; fi
    sleep 10
  done
  if [ "${ok}" = "1" ]; then
    complete_job "${JOB_ID}" "$(jq -nc --arg m "✅ meo-backendを改修して本番(Railway/main)へ反映しました。sha=${new_sha}" '{summary:$m, artifacts:[], requires_action:false}')" "${cost}"
    echo "[jobqueue-runner] meo_apply deployed job=${JOB_ID} sha=${new_sha}"
  else
    ( cd "${MEO_BACKEND_DIR}" && git revert --no-edit "${new_sha}" >/dev/null 2>&1 && git push origin main >/dev/null 2>&1 )
    complete_job "${JOB_ID}" "$(jq -nc --arg m "❌ 反映後の/healthが確認できなかったため自動ロールバックしました（base=${base_sha}）。" '{summary:$m, artifacts:[], requires_action:true}')" "${cost}"
    echo "[jobqueue-runner] meo_apply rolled back job=${JOB_ID}"
  fi
}

run_research() {
  # research_weekly: updates ~/.claude/memory/systems.md-driven knowledge base.
  # bypassPermissions is required here for the same reason run-loop.sh uses it:
  # .claude/memory is a Claude-Code "sensitive path" that even acceptEdits
  # still prompts for, and headless has no human to answer the prompt.
  local task turns=40 prompt out result_text cost res fp_before fp_after changed note
  task="$(echo "${PAYLOAD}" | jq -r '.text // ""')"
  if [ ! -f "${HOME_CLAUDE}/memory/systems.md" ]; then
    fail_job "${JOB_ID}" "システム登録簿が無い: ${HOME_CLAUDE}/memory/systems.md"
    return
  fi
  fp_before="$(find "${HOME_CLAUDE}/memory" -maxdepth 1 -name '*.md' -type f -exec sha256sum {} \; | sort)"
  prompt="$(build_prompt "researcher" "${task}" 0)"
  out="$(cd "${HOME_CLAUDE}" && run_claude "${prompt}" "--permission-mode bypassPermissions" "${turns}")"
  if [ -z "${out}" ]; then fail_job "${JOB_ID}" "リサーチ: claude出力解析失敗"; return; fi
  result_text="$(echo "${out}" | jq -r '.result_text')"; cost="$(echo "${out}" | jq '.cost_usd')"
  res="$(printf '%s' "${result_text}" | extract_result)"
  fp_after="$(find "${HOME_CLAUDE}/memory" -maxdepth 1 -name '*.md' -type f -exec sha256sum {} \; | sort)"
  changed="true"; [ "${fp_before}" = "${fp_after}" ] && changed="false"
  note=""; [ "${changed}" = "false" ] && note=$'\n⚠️ memoryファイルが更新されていません（要確認）。'
  complete_job "${JOB_ID}" "$(jq -nc --arg m "【週次リサーチ】
$(echo "${res}" | jq -r '.summary')${note}" --argjson a "$(echo "${res}" | jq '.artifacts')" --argjson req "$([ "${changed}" = "false" ] && echo true || echo false)" \
    '{summary:$m, artifacts:$a, requires_action:$req}')" "${cost}"
  echo "[jobqueue-runner] research_weekly complete job=${JOB_ID} changed=${changed}"
}

run_agent_propose() {
  local existing task prompt out result_text cost resultText name role md summary
  existing="$(ls "${HOME_CLAUDE}/agents"/*.md 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.md$//' | paste -sd, -)"
  task="あなたはCEOです。この自律AI会社の役割構成を点検し、不足している役割を1つだけ提案してください。
既存エージェント: ${existing}
参照: .claude/agents/配下の各.md、.claude/memory/systems.md、.claude/memory/decisions.md、.claude/memory/worklog.mdを読み、重複しない・実益の高い不足役割を1つ選ぶこと。
新エージェントの.md本文（先頭に'---'で囲うYAMLフロントマターname/description、本文に役割・出力フォーマット・厳守事項）を作ること。既存と重複する役割は提案しないこと。
出力は最後に必ず次の1行のみ(agent_mdの改行は\\nでエスケープ):
RESULT_JSON: {\"summary\":\"なぜこの役割が必要か3行\",\"agent_name\":\"kebab小文字の英名\",\"agent_role\":\"役割の一言\",\"agent_md\":\".mdの全文\",\"requires_action\":false}"
  prompt="$(build_prompt "CEO" "${task}" 0)"
  out="$(cd "${HOME_CLAUDE}" && run_claude "${prompt}" "" 25)"
  if [ -z "${out}" ]; then fail_job "${JOB_ID}" "役割提案: claude出力解析失敗"; return; fi
  result_text="$(echo "${out}" | jq -r '.result_text')"; cost="$(echo "${out}" | jq '.cost_usd')"
  local tail_json; tail_json="$(printf '%s' "${result_text}" | sed -n 's/.*RESULT_JSON:[[:space:]]*//p' | tail -1)"
  name=""; role=""; md=""; summary=""
  if [ -n "${tail_json}" ] && echo "${tail_json}" | jq -e . >/dev/null 2>&1; then
    name="$(echo "${tail_json}" | jq -r '.agent_name // ""' | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
    role="$(echo "${tail_json}" | jq -r '.agent_role // ""')"
    md="$(echo "${tail_json}" | jq -r '.agent_md // ""')"
    summary="$(echo "${tail_json}" | jq -r '.summary // ""')"
  fi
  if [ -z "${name}" ] || [ -z "${md}" ]; then
    complete_job "${JOB_ID}" "$(jq -nc '{summary:"役割提案を生成できませんでした（出力不備）。", artifacts:[], requires_action:false}')" "${cost}"
    return
  fi
  if [ -f "${HOME_CLAUDE}/agents/${name}.md" ]; then
    complete_job "${JOB_ID}" "$(jq -nc --arg m "既に存在する役割のため提案を見送りました: ${name}" '{summary:$m, artifacts:[], requires_action:false}')" "${cost}"
    return
  fi
  mkdir -p "${HOME_CLAUDE}/agents/_pending"
  printf '%s' "${md}" > "${HOME_CLAUDE}/agents/_pending/${name}.md"
  post_agent "/actions" "$(jq -nc --arg t "🧩新エージェント提案: ${name}（${role}）" --arg n "${name}" --arg r "${role}" --arg s "_pending/${name}.md" \
    '{type:"agent_create", requires_approval:true, title:$t, payload:{agent_name:$n, agent_role:$r, staged:$s}}')" >/dev/null || true
  complete_job "${JOB_ID}" "$(jq -nc --arg m "🧩 新エージェント提案を作成しました（YESで作成）: ${name}
${summary}" '{summary:$m, artifacts:[], requires_action:false}')" "${cost}"
  echo "[jobqueue-runner] agent_propose complete job=${JOB_ID} name=${name}"
}

run_agent_create() {
  local name staged target src
  name="$(echo "${PAYLOAD}" | jq -r '.agent_name // ""' | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
  staged="$(echo "${PAYLOAD}" | jq -r '.staged // ""')"
  if [ -z "${name}" ]; then fail_job "${JOB_ID}" "役割作成: agent_name が無い"; return; fi
  target="${HOME_CLAUDE}/agents/${name}.md"
  if [ -f "${target}" ]; then
    complete_job "${JOB_ID}" "$(jq -nc --arg m "既に存在するため作成をスキップ: ${name}" '{summary:$m, artifacts:[], requires_action:false}')"
    return
  fi
  src="${HOME_CLAUDE}/agents/${staged}"
  if [ -z "${staged}" ] || [ ! -f "${src}" ]; then
    fail_job "${JOB_ID}" "役割作成: 下書きが見つからない: ${staged}"
    return
  fi
  cp "${src}" "${target}"
  rm -f "${src}"
  complete_job "${JOB_ID}" "$(jq -nc --arg m "✅ 新エージェントを作成しました: ${name}。次回から役割注入の対象になります。" --arg a "${name}.md" '{summary:$m, artifacts:[$a], requires_action:false}')"
  echo "[jobqueue-runner] agent_create complete job=${JOB_ID} name=${name}"
}

run_marketing_propose() {
  local task ask prompt out result_text cost resultText tail_json summary channel proposal
  task="$(echo "${PAYLOAD}" | jq -r '.text // "いま打つべき集客施策を提案してください。"')"
  ask="${task}
条件: SNS(Instagram等)を中心に、具体的な施策を1〜3件。各施策に【チャネル/狙い/具体案/根拠(過去の学び)/必要な承認(投稿・出稿・予算)】を書く。
現実の投稿・出稿・課金はしないこと(提案のみ)。
出力は最後に必ず次の1行のみ:
RESULT_JSON: {\"summary\":\"提案の要約3行\",\"channel\":\"sns または ads または mixed\",\"proposal\":\"提案の全文(箇条書き可)\",\"requires_action\":false}"
  prompt="$(build_prompt "CMO" "${ask}" 1)"
  out="$(cd "${HOME_CLAUDE}" && run_claude "${prompt}" "" 25)"
  if [ -z "${out}" ]; then fail_job "${JOB_ID}" "集客提案: claude出力解析失敗"; return; fi
  result_text="$(echo "${out}" | jq -r '.result_text')"; cost="$(echo "${out}" | jq '.cost_usd')"
  tail_json="$(printf '%s' "${result_text}" | sed -n 's/.*RESULT_JSON:[[:space:]]*//p' | tail -1)"
  summary=""; channel="sns"; proposal=""
  if [ -n "${tail_json}" ] && echo "${tail_json}" | jq -e . >/dev/null 2>&1; then
    summary="$(echo "${tail_json}" | jq -r '.summary // ""')"
    channel="$(echo "${tail_json}" | jq -r '.channel // "sns"')"
    proposal="$(echo "${tail_json}" | jq -r '.proposal // ""')"
  fi
  post_agent "/notify" "$(jq -nc --arg t "集客提案(${channel})" --arg m "${proposal}" '{title:$t, message:$m}')" >/dev/null || true
  post_agent "/actions" "$(jq -nc --arg t "📣 上記の集客案を実施しますか？(${channel})" --arg c "${channel}" --arg s "${summary}" \
    '{type:"marketing_apply", requires_approval:true, title:$t, payload:{channel:$c, summary:$s}}')" >/dev/null || true
  complete_job "${JOB_ID}" "$(jq -nc --arg m "📣 集客提案を送りました(YESで実施記録): ${summary}" '{summary:$m, artifacts:[], requires_action:false}')" "${cost}"
  echo "[jobqueue-runner] marketing_propose complete job=${JOB_ID} channel=${channel}"
}

run_marketing_apply() {
  local channel summary wl today
  channel="$(echo "${PAYLOAD}" | jq -r '.channel // ""')"
  summary="$(echo "${PAYLOAD}" | jq -r '.summary // ""')"
  wl="${HOME_CLAUDE}/memory/worklog.md"
  mkdir -p "$(dirname "${wl}")"
  [ -f "${wl}" ] || printf '# Worklog\n\n' > "${wl}"
  today="$(date -u +%Y-%m-%d)"
  printf -- '- [%s][集客/承認済] channel=%s / %s / ※実適用はAPI承認後 or 手動\n' "${today}" "${channel}" "${summary}" >> "${wl}"
  complete_job "${JOB_ID}" "$(jq -nc --arg m "✅ 集客施策の承認を記録しました(${channel})。" '{summary:$m, artifacts:[], requires_action:false}')"
  echo "[jobqueue-runner] marketing_apply recorded job=${JOB_ID}"
}

# ------------------------------------------------------------------ main

LEASE_RESP="$(post_runner "/runner/lease" "$(jq -nc --arg r "${RUNNER_ID}" --argjson l "${LEASE_SEC}" '{runner_id:$r, lease_seconds:$l}')")"
if ! echo "${LEASE_RESP}" | jq -e . >/dev/null 2>&1; then
  echo "ERROR: /runner/lease did not return JSON (auth/network issue?). Raw response:" >&2
  echo "${LEASE_RESP}" >&2
  exit 1
fi
PAUSED="$(echo "${LEASE_RESP}" | jq -r '.paused // empty')"
if [ -n "${PAUSED}" ]; then
  echo "[jobqueue-runner] paused: ${PAUSED} (today_cost=$(echo "${LEASE_RESP}" | jq -r '.today_cost_usd // "?"') cap=$(echo "${LEASE_RESP}" | jq -r '.cap // "?"'))"
  exit 0
fi
JOB="$(echo "${LEASE_RESP}" | jq -c '.job // empty')"
if [ -z "${JOB}" ] || [ "${JOB}" = "null" ]; then
  echo "[jobqueue-runner] no job leased"
  exit 0
fi

JOB_ID="$(echo "${JOB}" | jq -r '.job_id')"
JOB_TYPE="$(echo "${JOB}" | jq -r '.type')"
AGENT="$(echo "${JOB}" | jq -r '.agent // "Engineer"')"
PAYLOAD="$(echo "${JOB}" | jq -c '.payload // {}')"
echo "[jobqueue-runner] leased job_id=${JOB_ID} type=${JOB_TYPE} agent=${AGENT}"

case "${JOB_TYPE}" in
  build_plan|build_apply) run_build ;;
  meo_backend) run_meo_backend ;;
  meo_plan) run_meo_plan ;;
  meo_apply) run_meo_apply ;;
  research_weekly) run_research ;;
  agent_propose) run_agent_propose ;;
  agent_create) run_agent_create ;;
  marketing_propose) run_marketing_propose ;;
  marketing_apply) run_marketing_apply ;;
  freeform|research|existing_service) run_generic ;;
  *) fail_unsupported ;;
esac

echo "[jobqueue-runner] done"
