#!/usr/bin/env bash
# checkout-ai-business.sh
#
# P2: some scheduled-tasks (ad-lp-daily-learning, ad-lp-apply-daily,
# seo-daily, ad-pdca-daily) reference absolute paths under
# C:\Users\user\ai-business\... on the owner's PC -- a tree separate from
# C:\Users\user\.claude (which ai-ops-config/run-loop.sh already mirrors).
#
# That tree is split across 3 private repos for this CI setup:
#   - ai-business-ops   (scoped snapshot: marketing/, google-ads/, .claude/memory/)
#   - sales-research-tool
#   - meta-ads
#
# This script clones all three and assembles them at $GITHUB_WORKSPACE/ai-business
# so that run-loop.sh's AI_BUSINESS_DIR path translation
# (C:\Users\user\ai-business\... -> $AI_BUSINESS_DIR/...) resolves correctly,
# mirroring the owner's real directory layout.
#
# Requires: scripts/setup-ssh-keys.sh already run (writes per-repo SSH host
# aliases config-gh / ai-business-ops-gh / sales-research-gh / meta-ads-gh),
# from secrets AI_BUSINESS_OPS_DEPLOY_KEY / SALES_RESEARCH_DEPLOY_KEY / META_ADS_DEPLOY_KEY.
set -euo pipefail

# retry(cmd...) -- run a command up to 3 attempts total, with backoff between
# attempts, to survive transient SSH drops during `git clone` (see run
# 39643293922, 2026-10-21T17:23Z: "Connection to github.com closed by remote
# host" on an otherwise-valid deploy key; an immediate re-run succeeded).
#
# Backoff schedule is overridable via RETRY_BACKOFFS (space-separated seconds,
# one entry per retry wait) so tests can run with zero sleep; default is
# "5 15" (3 attempts total: try, wait 5s, try, wait 15s, try).
#
# On persistent failure, returns the failing command's own exit code so the
# caller still fails hard under `set -e` -- this must never swallow a real
# failure.
retry() {
  local -a backoffs
  read -r -a backoffs <<< "${RETRY_BACKOFFS:-5 15}"
  local max_attempts=$(( ${#backoffs[@]} + 1 ))
  local attempt=1
  local rc=0
  while true; do
    # NOTE: deliberately "$@" && return 0", not "if "$@"; then return 0; fi" --
    # when the condition of an if-statement is false and no branch runs, bash
    # resets $? to 0, which would make the capture below always see rc=0.
    "$@" && return 0
    rc=$?
    if (( attempt >= max_attempts )); then
      echo "[checkout-ai-business] attempt ${attempt} failed, giving up (exit ${rc})"
      return "${rc}"
    fi
    local wait_s="${backoffs[$((attempt - 1))]}"
    echo "[checkout-ai-business] attempt ${attempt} failed, retrying in ${wait_s}s"
    sleep "${wait_s}"
    attempt=$((attempt + 1))
  done
}

# When sourced with CHECKOUT_AI_BUSINESS_LIB=1 (used by
# scripts/checkout-ai-business-retry-test.mjs), stop here so the retry()
# definition above can be exercised without running the real clones -- one
# source of truth, no copy-pasted retry logic in the test.
if [ "${CHECKOUT_AI_BUSINESS_LIB:-}" != "1" ]; then

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
AI_BUSINESS_OPS_DIR="${WORKSPACE}/ai-business-ops"
AI_BUSINESS_DIR="${WORKSPACE}/ai-business"

echo "== checkout-ai-business: cloning 3 repos =="

retry git clone --depth 1 --branch main git@ai-business-ops-gh:yusuken10121990-hub/ai-business-ops.git "${AI_BUSINESS_OPS_DIR}"
retry git clone --depth 1 --branch main git@sales-research-gh:yusuken10121990-hub/sales-research-tool.git "${AI_BUSINESS_DIR}/sales-research-tool"
retry git clone --depth 1 --branch main git@meta-ads-gh:yusuken10121990-hub/meta-ads.git "${AI_BUSINESS_DIR}/meta-ads"

mkdir -p "${AI_BUSINESS_DIR}/.claude"
cp -r "${AI_BUSINESS_OPS_DIR}/marketing" "${AI_BUSINESS_DIR}/marketing"
cp -r "${AI_BUSINESS_OPS_DIR}/google-ads" "${AI_BUSINESS_DIR}/google-ads"
cp -r "${AI_BUSINESS_OPS_DIR}/.claude/memory" "${AI_BUSINESS_DIR}/.claude/memory"

echo "AI_BUSINESS_DIR=${AI_BUSINESS_DIR}" >> "${GITHUB_ENV:?GITHUB_ENV not set}"
echo "AI_BUSINESS_OPS_DIR=${AI_BUSINESS_OPS_DIR}" >> "${GITHUB_ENV}"

echo "== checkout-ai-business: done =="

fi
