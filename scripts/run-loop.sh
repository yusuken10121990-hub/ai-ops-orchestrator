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

# 5.6 (2026-08-20): CLIの存在を「実行前に」検証してから本番実行する。
#   実測: zerosys-ad-pdca の schedule 実行が 2026-08-18/19/20 と3日連続で
#     "Error: claude native binary not installed."
#     "Either postinstall did not run (--ignore-scripts, some pnpm configs)
#      or the platform-native optional dependency was not downloaded"
#   で即死していた (run 32090463389 / 32207296598 / 32323369637)。
#   一方 workflow_dispatch は同日でも成功しており、npx のキャッシュ状態に
#   依存する間欠障害だった＝「手で叩けば動く」ため気付きにくい。
#   run-loop.sh は25本のworkflowが共有しているので、ここを直せば全ループに効く。
#   対策: (1) --version で実際に起動できることを確認してから本番呼び出しへ進む
#         (2) 失敗したら npx キャッシュを捨て、postinstall が確実に走る
#             グローバルインストールへフォールバックして再検証
#         (3) 3回試して駄目なら「CLIが用意できなかった」と明示して落とす
#             (プロンプトを投げずに落とすので、上限枯渇の SKIPPED とも混ざらない)
CLAUDE_CODE_PKG="@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION:-latest}"
CLAUDE_CMD=""
for _attempt in 1 2 3; do
  if npx -y "${CLAUDE_CODE_PKG}" --version >/dev/null 2>&1; then
    CLAUDE_CMD="npx -y ${CLAUDE_CODE_PKG}"
    break
  fi
  echo "WARN: claude CLI not runnable via npx (attempt ${_attempt}/3). repairing…" >&2
  npm cache clean --force >/dev/null 2>&1 || true
  if npm install -g --no-audit --no-fund "${CLAUDE_CODE_PKG}" >/dev/null 2>&1 \
    && command -v claude >/dev/null 2>&1 \
    && claude --version >/dev/null 2>&1; then
    CLAUDE_CMD="claude"
    break
  fi
done
if [ -z "${CLAUDE_CMD}" ]; then
  echo "ERROR: claude CLI could not be installed after 3 attempts (${CLAUDE_CODE_PKG})." >&2
  echo "       native binary missing — see scripts/run-loop.sh section 5.6." >&2
  exit 1
fi
echo "claude CLI: ${CLAUDE_CMD} ($(${CLAUDE_CMD} --version 2>/dev/null | head -1))"

CLAUDE_LOG="$(mktemp)"
set +e
${CLAUDE_CMD} -p "${PROMPT}" \
  --dangerously-skip-permissions \
  --model "${CLAUDE_MODEL:-sonnet}" 2>&1 | tee "${CLAUDE_LOG}"
CLAUDE_EXIT="${PIPESTATUS[0]}"
set -e

if [ "${CLAUDE_EXIT}" -ne 0 ]; then
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
fi
rm -f "${CLAUDE_LOG}"

echo "== claude run finished, syncing generated changes back to config checkout =="

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
