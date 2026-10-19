#!/usr/bin/env bash
# checkout-product-repos.sh <dest-dir>
#
# 2026-10-19: shallow, read-only clones of every product repo this orchestrator
# holds a deploy key for, so security-daily / maintenance-weekly can run
# npm audit, secret scans and git-state checks in the cloud instead of
# recording "skipped(no-repo-access)". Requires scripts/setup-ssh-keys.sh first.
# A missing key or failed clone is skipped (logged), never fatal; nothing is
# ever pushed back from these clones.
set -uo pipefail

DEST="${1:-repos}"
mkdir -p "${DEST}"

# alias (from setup-ssh-keys.sh) : GitHub repo : local dir name
REPOS=(
  "ai-business-ops:ai-business-ops:ai-business-ops"
  "sales-research:sales-research-tool:sales-research-tool"
  "meta-ads:meta-ads:meta-ads"
  "crudtest1:crudtest1:crudtest1"
  "jobqueue-backend:jobqueue-backend:jobqueue-backend"
  "meo-backend:meo-backend:meo-backend"
  "lp-ai-system-saas:lp-ai-system-saas:lp-ai-system-saas"
)

ok=0; skip=0
for entry in "${REPOS[@]}"; do
  IFS=: read -r alias repo dir <<< "${entry}"
  if ! grep -q "^Host ${alias}-gh$" "$HOME/.ssh/config" 2>/dev/null; then
    echo "[checkout-product-repos] skip ${dir} (no deploy key)"; skip=$((skip+1)); continue
  fi
  if GIT_TERMINAL_PROMPT=0 timeout 180 git clone --quiet --depth 1 "git@${alias}-gh:yusuken10121990-hub/${repo}.git" "${DEST}/${dir}" 2>/dev/null; then
    echo "[checkout-product-repos] cloned ${dir}"; ok=$((ok+1))
  else
    echo "[checkout-product-repos] skip ${dir} (clone failed)"; skip=$((skip+1))
  fi
done
echo "[checkout-product-repos] cloned=${ok} skipped=${skip}"
exit 0
