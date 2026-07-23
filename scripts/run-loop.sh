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
npx -y @anthropic-ai/claude-code@latest -p "${PROMPT}" \
  --dangerously-skip-permissions \
  --model "${CLAUDE_MODEL:-sonnet}"

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
