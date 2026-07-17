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

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
AI_BUSINESS_OPS_DIR="${WORKSPACE}/ai-business-ops"
AI_BUSINESS_DIR="${WORKSPACE}/ai-business"

echo "== checkout-ai-business: cloning 3 repos =="

git clone --depth 1 --branch main git@ai-business-ops-gh:yusuken10121990-hub/ai-business-ops.git "${AI_BUSINESS_OPS_DIR}"
git clone --depth 1 --branch main git@sales-research-gh:yusuken10121990-hub/sales-research-tool.git "${AI_BUSINESS_DIR}/sales-research-tool"
git clone --depth 1 --branch main git@meta-ads-gh:yusuken10121990-hub/meta-ads.git "${AI_BUSINESS_DIR}/meta-ads"

mkdir -p "${AI_BUSINESS_DIR}/.claude"
cp -r "${AI_BUSINESS_OPS_DIR}/marketing" "${AI_BUSINESS_DIR}/marketing"
cp -r "${AI_BUSINESS_OPS_DIR}/google-ads" "${AI_BUSINESS_DIR}/google-ads"
cp -r "${AI_BUSINESS_OPS_DIR}/.claude/memory" "${AI_BUSINESS_DIR}/.claude/memory"

echo "AI_BUSINESS_DIR=${AI_BUSINESS_DIR}" >> "${GITHUB_ENV:?GITHUB_ENV not set}"
echo "AI_BUSINESS_OPS_DIR=${AI_BUSINESS_OPS_DIR}" >> "${GITHUB_ENV}"

echo "== checkout-ai-business: done =="
