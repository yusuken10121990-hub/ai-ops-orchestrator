#!/usr/bin/env bash
# setup-ssh-keys.sh
#
# Writes each provided GitHub deploy-key secret to its own keyfile and
# configures a distinct SSH host alias per key:
#   Host <alias>-gh -> HostName github.com, IdentityFile <keyfile>, IdentitiesOnly yes
#
# Why not webfactory/ssh-agent with multiple keys loaded at once: GitHub
# deploy keys are repo-scoped (one key = access to exactly one repo), but
# ssh-agent just offers whichever key comes first when authenticating to
# github.com. If that first key is valid for *some* repo, SSH auth succeeds
# at the transport layer, and git then fails with a misleading "Repository
# not found" for any *other* repo whose deploy key was never actually tried.
# (Hit this in practice: CONFIG_DEPLOY_KEY loaded alongside
# AI_BUSINESS_OPS_DEPLOY_KEY caused ai-business-ops clones to fail with
# "Repository not found" even though the key + repo were both fine.)
# Distinct host aliases + IdentitiesOnly=yes force each clone/push to use
# exactly the key intended for that repo.
#
# Usage: source or call with env vars set for whichever keys are needed:
#   CONFIG_DEPLOY_KEY, AI_BUSINESS_OPS_DEPLOY_KEY, SALES_RESEARCH_DEPLOY_KEY, META_ADS_DEPLOY_KEY
# Then clone/push using the alias host instead of github.com, e.g.:
#   git clone git@config-gh:yusuken10121990-hub/ai-ops-config.git config
#   git push git@ai-business-ops-gh:yusuken10121990-hub/ai-business-ops.git HEAD:main
set -euo pipefail

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
ssh-keyscan -H github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null || true
: > "$HOME/.ssh/config"
chmod 600 "$HOME/.ssh/config"

add_key() {
  local alias="$1" value="$2"
  if [ -z "${value}" ]; then
    echo "[setup-ssh-keys] skip ${alias} (no value provided)"
    return 0
  fi
  local keyfile="$HOME/.ssh/id_${alias}"
  printf '%s\n' "${value}" > "${keyfile}"
  chmod 600 "${keyfile}"
  {
    echo "Host ${alias}-gh"
    echo "  HostName github.com"
    echo "  User git"
    echo "  IdentityFile ${keyfile}"
    echo "  IdentitiesOnly yes"
    echo "  StrictHostKeyChecking accept-new"
    echo
  } >> "$HOME/.ssh/config"
  echo "[setup-ssh-keys] registered alias: ${alias}-gh"
}

add_key "config" "${CONFIG_DEPLOY_KEY:-}"
add_key "ai-business-ops" "${AI_BUSINESS_OPS_DEPLOY_KEY:-}"
add_key "sales-research" "${SALES_RESEARCH_DEPLOY_KEY:-}"
add_key "meta-ads" "${META_ADS_DEPLOY_KEY:-}"
# P2 (2026-07-23, pc-off-migration-plan.md Tier1): video-narration-learning
# needs the crudtest1 repo (video_factory lives under crudtest1/video_factory).
# Skips cleanly (see add_key) until CRUDTEST1_DEPLOY_KEY is provisioned --
# see owner-todos.md video-narration-learning-cloud-secrets.
add_key "crudtest1" "${CRUDTEST1_DEPLOY_KEY:-}"
# Tier0 (2026-07-23, pc-off-migration-plan.md): jobqueue-runner.yml (the
# cloud port of runner.ps1/Run-Build and Run-MeoApply) needs push access to
# the two repos the local runner self-modifies: jobqueue-backend itself
# (build_plan/build_apply -- Railway auto-rebuilds jobqueue-gate on push to
# master) and meo-backend (meo_plan/meo_apply -- Railway auto-rebuilds on
# push to main). Both skip cleanly until their *_DEPLOY_KEY secrets are
# provisioned -- see owner-todos.md jobqueue-runner-cloud-secrets.
add_key "jobqueue-backend" "${JOBQUEUE_BACKEND_DEPLOY_KEY:-}"
add_key "meo-backend" "${MEO_BACKEND_DEPLOY_KEY:-}"
# pcoff-secrets-one-enter仕上げ (2026-07-24, dev-devops): backup.sh(cloud) needs
# push access to ai-ops-backups (private repo storing gpg-encrypted daily
# dumps). Replaces the old BACKUPS_REPO_TOKEN (fine-grained PAT, required a
# manual mint via GitHub Settings -> now a self-generated SSH deploy key,
# same pattern as every other *_DEPLOY_KEY here). Skips cleanly until
# provisioned -- see owner-todos.md pcoff-secrets-one-enter.
add_key "ai-ops-backups" "${BACKUPS_REPO_DEPLOY_KEY:-}"
# dev-integration (2026-07-23, pc-off-migration-plan.md Tier3 #8, meo-review-api.yml):
# campaigns/_internal/camp_c7faa7c45e/clients/*.json (顧客PII: 氏名/メール/
# Stripe顧客ID/GBPアクセス情報) is currently local-only (no git repo at all --
# confirmed 2026-07-23, neither ai-business nor ai-business-ops tracks it).
# This is a real gap (no cloud backup of client contract data either -- flagged
# to backup-admin separately) as well as the reason meo-review-api.yml cannot
# yet read the client registry from the cloud. Once a scoped private repo for
# this data is created (owner/CTO data-handling decision, out of scope for a
# single dev-integration pass) and CLIENTS_DEPLOY_KEY is provisioned, this
# skips cleanly until then like every other not-yet-provisioned key here.
add_key "clients" "${CLIENTS_DEPLOY_KEY:-}"
