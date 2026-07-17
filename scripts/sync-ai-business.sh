#!/usr/bin/env bash
# sync-ai-business.sh
#
# Counterpart to checkout-ai-business.sh: copies the (possibly Claude-edited)
# $AI_BUSINESS_DIR mirror back into the 3 separate repo checkouts, then
# commits & pushes each repo that actually changed. Run this *after*
# run-loop.sh in workflows that sourced checkout-ai-business.sh.
set -euo pipefail

: "${AI_BUSINESS_DIR:?AI_BUSINESS_DIR not set (did checkout-ai-business.sh run?)}"
: "${AI_BUSINESS_OPS_DIR:?AI_BUSINESS_OPS_DIR not set (did checkout-ai-business.sh run?)}"

echo "== sync-ai-business: copying changes back =="

mkdir -p "${AI_BUSINESS_OPS_DIR}/marketing" "${AI_BUSINESS_OPS_DIR}/google-ads" "${AI_BUSINESS_OPS_DIR}/.claude/memory"
cp -r "${AI_BUSINESS_DIR}/marketing/." "${AI_BUSINESS_OPS_DIR}/marketing/"
cp -r "${AI_BUSINESS_DIR}/google-ads/." "${AI_BUSINESS_OPS_DIR}/google-ads/"
cp -r "${AI_BUSINESS_DIR}/.claude/memory/." "${AI_BUSINESS_OPS_DIR}/.claude/memory/"
# never let CI-installed deps / generated local data leak back into the repo
rm -rf "${AI_BUSINESS_OPS_DIR}/google-ads/node_modules" "${AI_BUSINESS_OPS_DIR}/google-ads/.env" \
       "${AI_BUSINESS_OPS_DIR}/google-ads/data" "${AI_BUSINESS_OPS_DIR}/google-ads/reports"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

commit_and_push() {
  local dir="$1" remote="$2" label="$3"
  if [ ! -d "${dir}" ]; then
    echo "[sync] ${label}: dir not found, skipping"
    return 0
  fi
  (
    cd "${dir}"
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git add -A
    if git diff --cached --quiet; then
      echo "[sync] ${label}: no changes"
    else
      git commit -q -m "chore: ${GITHUB_WORKFLOW:-loop} auto update ($(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST'))"
      # Multiple loops can push to the same repo/branch concurrently -- retry
      # with rebase on non-fast-forward rejection instead of failing outright.
      bash "${SCRIPT_DIR}/git-push-retry.sh" "${remote}" main
      echo "[sync] ${label}: pushed"
    fi
  )
}

# Attempt all 3 repos even if one fails after retries -- one repo's push
# failure must not block the others (set -e would otherwise abort the whole
# script on the first non-zero from a subshell).
FAILED=0
commit_and_push "${AI_BUSINESS_OPS_DIR}" "git@ai-business-ops-gh:yusuken10121990-hub/ai-business-ops.git" "ai-business-ops" || FAILED=1
commit_and_push "${AI_BUSINESS_DIR}/sales-research-tool" "git@sales-research-gh:yusuken10121990-hub/sales-research-tool.git" "sales-research-tool" || FAILED=1
commit_and_push "${AI_BUSINESS_DIR}/meta-ads" "git@meta-ads-gh:yusuken10121990-hub/meta-ads.git" "meta-ads" || FAILED=1

if [ "${FAILED}" = "1" ]; then
  echo "== sync-ai-business: done (with at least one repo push failure, see above) ==" >&2
  exit 1
fi
echo "== sync-ai-business: done =="
