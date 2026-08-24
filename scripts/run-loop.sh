#!/usr/bin/env bash
# run-loop.sh <loop-name>
#
# Runs one scheduled-tasks/<loop-name>/SKILL.md via headless Claude Code on a
# GitHub Actions runner, using the private "ai-ops-config" repo (checked out
# to $CONFIG_DIR, default "$GITHUB_WORKSPACE/config") as the source of
# business data (agents/ memory/ scheduled-tasks/ CLAUDE.md).
#
# Design note (why we mirror into $HOME/.claude instead of just doing a
# path find/replace in the prompt): Claude Code auto-loads global config
# from ~/.claude (CLAUDE.md, agents/ as subagents). Copying the checked-out
# config repo into $HOME/.claude reproduces the owner's PC setup exactly
# (subagents work, CLAUDE.md rules apply) instead of us having to hand-roll
# equivalents. We still do the path find/replace for the *prompt text*
# handed to `claude -p`, since SKILL.md bodies reference the owner's
# Windows path (C:\Users\user\.claude\...) literally.
set -euo pipefail

LOOP_NAME="${1:?usage: run-loop.sh <loop-name>}"
# このスクリプトが置かれているディレクトリを、cd する前に絶対パスで確定させる。
# 下の方で cd "${HOME_CLAUDE}" するため、BASH_SOURCE の相対パス
# (scripts/run-loop.sh) はそこから先では解決できない。run 32349297544 はこれで落ちた。
RUN_LOOP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${CONFIG_DIR:-${GITHUB_WORKSPACE:-$(pwd)}/config}"
HOME_CLAUDE="${HOME}/.claude"
# P2: some loops (ad-lp-*, seo-daily, ad-pdca-daily) reference absolute
# Windows paths under C:\Users\user\ai-business\... (a separate tree from
# C:\Users\user\.claude). If the workflow checked out those repos and
# assembled them at $AI_BUSINESS_DIR (default: $GITHUB_WORKSPACE/ai-business),
# we also translate that prefix. Loops that don't need it (team-learning-loop,
# research-team-learning) simply leave AI_BUSINESS_DIR unset/empty, in which
# case this is a no-op and behavior is unchanged from the P0 PoC.
AI_BUSINESS_DIR="${AI_BUSINESS_DIR:-}"

echo "== run-loop: ${LOOP_NAME} =="
echo "config dir: ${CONFIG_DIR}"
echo "home claude: ${HOME_CLAUDE}"

if [ ! -d "${CONFIG_DIR}" ]; then
  echo "ERROR: config dir not found: ${CONFIG_DIR} (did the private repo checkout step run?)" >&2
  exit 1
fi

# 1. Mirror the private config repo into $HOME/.claude so headless Claude
#    Code picks up CLAUDE.md / agents / memory / scheduled-tasks exactly
#    like it does on the owner's PC (global config convention).
mkdir -p "${HOME_CLAUDE}"
cp -r "${CONFIG_DIR}/." "${HOME_CLAUDE}/"

SKILL_FILE="${HOME_CLAUDE}/scheduled-tasks/${LOOP_NAME}/SKILL.md"
if [ ! -f "${SKILL_FILE}" ]; then
  echo "ERROR: SKILL not found: ${SKILL_FILE}" >&2
  exit 1
fi

# 2. Strip YAML frontmatter (--- ... ---) from the SKILL body.
BODY="$(awk 'BEGIN{c=0} /^---$/{c++; next} c>=2{print}' "${SKILL_FILE}")"
if [ -z "${BODY}" ]; then
  echo "WARN: frontmatter strip produced empty body, falling back to raw file" >&2
  BODY="$(cat "${SKILL_FILE}")"
fi

# 3. Translate owner's Windows absolute paths -> runner's $HOME/.claude path
#    (and, if set, $AI_BUSINESS_DIR for the ai-business tree), then normalize
#    any remaining backslashes to forward slashes.
ESCAPED_HOME_CLAUDE=$(printf '%s' "${HOME_CLAUDE}" | sed 's/[&/\]/\\&/g')
TRANSLATED="$(printf '%s' "${BODY}" \
  | sed -E "s#C:\\\\Users\\\\user\\\\\.claude\\\\#${ESCAPED_HOME_CLAUDE}/#g" \
  | sed -E "s#C:/Users/user/\.claude/#${ESCAPED_HOME_CLAUDE}/#g")"

if [ -n "${AI_BUSINESS_DIR}" ]; then
  echo "ai-business dir: ${AI_BUSINESS_DIR}"
  ESCAPED_AI_BUSINESS=$(printf '%s' "${AI_BUSINESS_DIR}" | sed 's/[&/\]/\\&/g')
  TRANSLATED="$(printf '%s' "${TRANSLATED}" \
    | sed -E "s#C:\\\\Users\\\\user\\\\ai-business\\\\#${ESCAPED_AI_BUSINESS}/#g" \
    | sed -E "s#C:/Users/user/ai-business/#${ESCAPED_AI_BUSINESS}/#g")"
fi

# P2 (2026-07-23, pc-off-migration-plan.md Tier1): some loops (creative-
# studio-apply-runner, geo-daily) reference the FULL ai-business-ops repo
# checkout directly (C:\Users\user\ai-business-ops\...), which is a
# different tree from the trimmed AI_BUSINESS_DIR mirror (marketing/ +
# google-ads/ only, see checkout-ai-business.sh). checkout-ai-business.sh
# already exports AI_BUSINESS_OPS_DIR to $GITHUB_ENV when it runs, so this
# is a no-op for loops that don't need it (AI_BUSINESS_OPS_DIR stays unset).
AI_BUSINESS_OPS_DIR="${AI_BUSINESS_OPS_DIR:-}"
if [ -n "${AI_BUSINESS_OPS_DIR}" ]; then
  echo "ai-business-ops dir: ${AI_BUSINESS_OPS_DIR}"
  ESCAPED_AI_BUSINESS_OPS=$(printf '%s' "${AI_BUSINESS_OPS_DIR}" | sed 's/[&/\]/\\&/g')
  TRANSLATED="$(printf '%s' "${TRANSLATED}" \
    | sed -E "s#C:\\\\Users\\\\user\\\\ai-business-ops\\\\#${ESCAPED_AI_BUSINESS_OPS}/#g" \
    | sed -E "s#C:/Users/user/ai-business-ops/#${ESCAPED_AI_BUSINESS_OPS}/#g")"
fi

TRANSLATED="$(printf '%s' "${TRANSLATED}" | sed -E 's#\\#/#g')"

# 4. Inject current JST wall-clock time explicitly. SKILL.md logic branches
#    on "現在の時刻" (JST, since this is a Japan-based business) — a Linux
#    runner's system clock is UTC, so we must not rely on the model
#    inferring time itself.
JST_NOW="$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M (%a)')"
JST_HOUR="$(TZ=Asia/Tokyo date '+%-H')"

PROMPT="現在の日時（JST・日本時間）: ${JST_NOW}, ${JST_HOUR}時台。
このタイムスタンプを「現在の時刻」として使ってください（システムのUTC時計ではなくこちらを正としてください）。

以下の指示を実行してください。

${TRANSLATED}"

echo "---- prompt (先頭500字) ----"
# P1 fix (2026-07-23, discovered via qa-daily's first cloud run failing in
# 16s with "printf: write error: Broken pipe"): `printf ... | head -c 500`
# races under `set -euo pipefail` -- when head closes its read end after
# 500 bytes, printf can still be mid-write and gets SIGPIPE, which pipefail
# then treats as a pipeline failure and aborts the whole script under -e.
# This was a *latent* bug in every loop that uses run-loop.sh (severity
# depended on prompt length / write timing, so most runs happened not to
# hit it) -- fixed generically here with bash substring expansion instead
# of a pipe, so there is nothing left to race.
printf '%s\n' "${PROMPT:0:500}"
echo "-----------------------------"

# 5. Auth: prefer subscription OAuth token, fall back to API key.
AUTH_MODE=""
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  AUTH_MODE="oauth"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  AUTH_MODE="api_key"
else
  echo "ERROR: neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set." >&2
  exit 1
fi
echo "auth mode: ${AUTH_MODE}"

cd "${HOME_CLAUDE}"

# NOTE: --dangerously-skip-permissions (bypass all permission checks) instead
# of --permission-mode acceptEdits. acceptEdits only auto-approves file
# edits; it still prompts for WebSearch/WebFetch/etc, which hangs forever in
# headless CI (no human to approve) and made the loop's actual research step
# a silent no-op. This is a disposable GitHub Actions runner touching only
# the config/ checkout (no other credentials/business systems reachable), so
# bypassing the prompt is low-risk here — see decisions.md 2026-07-16 entry.
# 5.5 (2026-08-19): Claudeの利用上限(週次/5時間/Opus上限・429)で落ちた場合は
#   「失敗」ではなく「待機(SKIPPED)」として exit 0 する。
#   実測 run 32216322754 (creative-studio-apply-runner, 2026-08-19 04:36 UTC):
#     "You've hit your weekly limit · resets 5am (UTC)" → claude が exit 1
#     → job failure → GitHubから "Run failed:" メールが飛ぶ。
#   run-loop.sh は25本のworkflowが共有しており、5分cronのループもあるため、
#   上限に当たっている間じゅう全ループが失敗メールを撒き続けていた。
#   上限枯渇はループの欠陥ではなく、リセット後のcronが自動で再開する事象なので
#   失敗にしない。同じ判断は既に drain-chat-tasks.sh:168 で確立済み
#   （「クォータ枯渇は失敗ではなく待機（exit 1にすると毎時failureのノイズになる）」）。
#   本物の失敗（設定ミス・SKILL不整合・API 4xx/5xx等）は従来どおり exit != 0 の
#   まま通し、メール通知を殺さない。
USAGE_LIMIT_PATTERN='hit your (weekly|[0-9]+-hour|usage|opus|sonnet) limit|hit your limit|usage limit reached|out of (weekly|usage) limit|"api_error_status" *: *429|rate_limit_error|Too Many Requests'

# 5.6 (2026-08-20): CLIが実際に起動できることを確認してから本番実行する。
#   npxのキャッシュ状態次第で "claude native binary not installed" が出る
#   間欠障害への対策。詳細と実測runは scripts/ensure-claude-cli.sh を参照。
#   learning-enforcer.yml も同じスクリプトを source しており、
#   「run-loop.sh を通らないworkflow」も同じ保護を受ける。
# shellcheck source=scripts/ensure-claude-cli.sh
. "${RUN_LOOP_DIR}/ensure-claude-cli.sh"

# 5.7 (2026-08-24): claude 実行そのものに、ジョブ全体のtimeout-minutesより手前で切れる
#   独自タイムアウト・実行量の上限・逐次出力を持たせる。
#   ── なぜ必要か（実測。推測ではない）────────────────────────────────────
#   zerosys-ad-pdca が 2026-08-24 に3回連続で "timeout-minutes: 30" のジョブ強制終了に
#   巻き込まれた(run 32682137730 / 32687261496 / 32690323464、いずれも実行時間 30m18〜20s)。
#   ログは "claude CLI: npx ..." の直後から30分間 一切出力が無いまま Terminate orphan
#   process (claude) で終わっていた。原因はデフォルトの `--output-format text` が
#   完了時まで何も出力しないこと、claude自身にタイムアウト/実行量上限が無くジョブの
#   30分に丸ごと巻き込まれること、および強制終了により後続の「Commit & push generated
#   learnings」ステップに到達できずその回の観測・作業が全て失われることの3点。
#   （直接原因の切り分けは decisions.md 2026-08-24エントリを参照。断定できない部分は
#   「特定できない」として記録している）。
#   ── 対策（既定値は現行動作を変えない・環境変数でループ別に上書き可能）───────
#   - CLAUDE_TIMEOUT_SECONDS を設定したループだけ、claude 実行を `timeout` で包む。
#     ジョブの timeout-minutes より十分手前の秒数に設定すること（呼び出し側workflowの
#     責務）。timeout はまず SIGTERM を送り、30秒後も生きていれば SIGKILL する
#     （--kill-after）。時間切れは exit 124 で判別する。
#   - CLAUDE_MAX_BUDGET_USD を設定したループだけ、`--max-budget-usd` で実行量に
#     上限を持たせる（claude CLI 組み込みの支出上限。--max-turns 相当のフラグは
#     このCLIバージョンに存在しないため採用。サブスクリプションOAuth認証での挙動は
#     未検証のため既定は未設定＝現行動作のまま）。
#   - CLAUDE_STREAM_PROGRESS=1 を設定したループだけ、`--output-format stream-json
#     --verbose` に切り替える。GitHub Actions は元々ログの各行にUTCタイムスタンプを
#     付与するため、text形式(完了時まで無出力)から stream-json(ターン/ツール呼び出し
#     ごとに1行出力)へ変えるだけで「どこまで進んだか」が時刻付きで分かるようになる
#     （JSON整形パーサは持たせない＝壊れても本体の可否に影響しない設計）。
#   - CLAUDE_TIMEOUT_SECONDS 到達（exit 124）は、既存の「利用上限=SKIPPED」と同じ
#     考え方で本物の失敗と区別し、GitHub Actions の notice/サマリにだけ出す
#     （Slack/LINE通知はしない＝SHARED_RULES 8章）。かつ exit 0 のまま後段の
#     「6. 生成物をconfig checkoutへ同期」まで必ず到達させる。ここまでの変更（ファイル
#     書き込みは同期的なので、打ち切り時点までの分は既にディスクへ反映済み）を
#     ワークフロー側の「Commit & push」ステップへ渡す。
CLAUDE_ARGS=(-p "${PROMPT}" --dangerously-skip-permissions --model "${CLAUDE_MODEL:-sonnet}")
if [ -n "${CLAUDE_MAX_BUDGET_USD:-}" ]; then
  CLAUDE_ARGS+=(--max-budget-usd "${CLAUDE_MAX_BUDGET_USD}")
fi
if [ "${CLAUDE_STREAM_PROGRESS:-}" = "1" ]; then
  CLAUDE_ARGS+=(--output-format stream-json --verbose)
fi

CLAUDE_LOG="$(mktemp)"
set +e
if [ -n "${CLAUDE_TIMEOUT_SECONDS:-}" ]; then
  echo "claude timeout budget: ${CLAUDE_TIMEOUT_SECONDS}s (SIGTERM, then SIGKILL after 30s if needed)"
  timeout --signal=TERM --kill-after=30s "${CLAUDE_TIMEOUT_SECONDS}s" \
    ${CLAUDE_CMD} "${CLAUDE_ARGS[@]}" 2>&1 | tee "${CLAUDE_LOG}"
else
  ${CLAUDE_CMD} "${CLAUDE_ARGS[@]}" 2>&1 | tee "${CLAUDE_LOG}"
fi
CLAUDE_EXIT="${PIPESTATUS[0]}"
set -e

# `timeout` reports 124 when its own SIGTERM ended the command, but if the
# command ignores SIGTERM and needs the --kill-after SIGKILL, GNU coreutils
# reports 128+9=137 instead (verified locally: a `trap '' TERM; sleep 30`
# child under `timeout --kill-after=5s 2s ...` exits 137, not 124). Treat
# both as a timeout — this branch only runs when CLAUDE_TIMEOUT_SECONDS was
# explicitly opted into, so a stray real 137 (e.g. external OOM kill) being
# misclassified as "timeout" is an acceptable, narrow trade-off.
CLAUDE_TIMED_OUT=0
if [ -n "${CLAUDE_TIMEOUT_SECONDS:-}" ] && { [ "${CLAUDE_EXIT}" -eq 124 ] || [ "${CLAUDE_EXIT}" -eq 137 ]; }; then
  CLAUDE_TIMED_OUT=1
fi

if [ "${CLAUDE_TIMED_OUT}" -eq 1 ]; then
  rm -f "${CLAUDE_LOG}"
  echo "== TIMEOUT: claude が実行予算(${CLAUDE_TIMEOUT_SECONDS}s)を超えたため打ち切り(exit=124) =="
  echo "   ここまでの成果物(ファイル変更)は既にディスクへ書き込まれているため、後続の"
  echo "   commit & push ステップで保存される。本物の失敗ではないので job は失敗にしない。"
  echo "::warning title=TIMEOUT (claude budget exceeded)::${LOOP_NAME}: ${CLAUDE_TIMEOUT_SECONDS}s budget exceeded, terminated. Partial progress will still be committed."
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      printf '### \xe2\x8f\xb1 TIMEOUT: claude budget exceeded (partial run)\n\n'
      printf -- '- loop: `%s`\n' "${LOOP_NAME}"
      printf -- '- budget: `%ss`\n' "${CLAUDE_TIMEOUT_SECONDS}"
      printf -- '- ここまでの変更は保存され、後続のcommit & pushに反映されます（失敗ではありません）。\n'
    } >> "${GITHUB_STEP_SUMMARY}"
  fi
elif [ "${CLAUDE_EXIT}" -ne 0 ]; then
  if grep -Eqi "${USAGE_LIMIT_PATTERN}" "${CLAUDE_LOG}"; then
    LIMIT_LINE="$(grep -Eim1 "${USAGE_LIMIT_PATTERN}" "${CLAUDE_LOG}" || true)"
    rm -f "${CLAUDE_LOG}"
    echo "== SKIPPED: Claudeの利用上限に到達 (exit=${CLAUDE_EXIT}) =="
    echo "   detected: ${LIMIT_LINE}"
    echo "   上限リセット後のcronが自動で再開するため、このrunは失敗にしない。"
    echo "::notice title=SKIPPED (Claude usage limit)::${LOOP_NAME}: ${LIMIT_LINE}"
    if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
      {
        printf '### ⏸ SKIPPED: Claude usage limit

'
        printf -- '- loop: `%s`
' "${LOOP_NAME}"
        printf -- '- detected: `%s`
' "${LIMIT_LINE}"
        printf -- '- 上限リセット後のcronが自動で再開します（失敗ではありません）。
'
      } >> "${GITHUB_STEP_SUMMARY}"
    fi
    exit 0
  fi
  rm -f "${CLAUDE_LOG}"
  echo "ERROR: claude run failed (exit=${CLAUDE_EXIT})" >&2
  exit "${CLAUDE_EXIT}"
else
  rm -f "${CLAUDE_LOG}"
fi

echo "== claude run finished (or was timed out), syncing generated changes back to config checkout =="

# 6. Copy back only the directories/files we manage. We deliberately do NOT
#    copy the whole $HOME/.claude back — anything Claude wrote outside
#    memory/ agents/ scheduled-tasks/ CLAUDE.md (cache, logs, etc.) is
#    dropped here and never committed.
for d in memory agents scheduled-tasks; do
  mkdir -p "${CONFIG_DIR}/${d}"
  cp -r "${HOME_CLAUDE}/${d}/." "${CONFIG_DIR}/${d}/"
done
if [ -f "${HOME_CLAUDE}/CLAUDE.md" ]; then
  cp "${HOME_CLAUDE}/CLAUDE.md" "${CONFIG_DIR}/CLAUDE.md"
fi

echo "== done =="
