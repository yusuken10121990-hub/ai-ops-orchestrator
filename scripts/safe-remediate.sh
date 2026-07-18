#!/usr/bin/env bash
# safe-remediate.sh <system_id>
#
# P0-2 (2026-07-18, CTO設計「保守運用組織の24/7/365拡張」): 夜間自動一次対応。
#
# 安全設計(OWASP Excessive Agency回避・モデルに実行権限を渡さない):
#   - 対象はホワイトリストの3システム(Railway系)のみ。それ以外のIDは即エラー終了。
#   - 実行できるのは「再デプロイ(redeploy)」だけ。データ削除・課金系の操作は
#     このスクリプトに一切実装しない(物理的に存在しない = モデルが誘導しても実行不可)。
#   - 呼び出し元(system-health-cloud.yml)が1システム1時間1回のクールダウンを
#     health-status.json の last_remediate_at で判定してから呼ぶ。このスクリプト
#     自身はクールダウン判定を持たない(呼び出し側の責務)。
#
# Railwayの認証について:
#   fuu / jobqueue-gate / ads-ops-backend は別々のRailwayプロジェクトのため、
#   1個の汎用トークンで全プロジェクトを操作することはできない可能性が高い
#   (Railway CLIのプロジェクトトークンはプロジェクト単位でスコープされる)。
#   デフォルト判断(1行): まずは共通secret RAILWAY_TOKEN を試し、無ければ
#   システム別 RAILWAY_TOKEN_<ID> (例: RAILWAY_TOKEN_FUU)を探す方式にして、
#   オーナーが1個のトークンで始めても・後で3個に分けても両方動くようにする。
#
# Usage: safe-remediate.sh <system_id>
# Env:   RAILWAY_TOKEN (共通) または RAILWAY_TOKEN_<SYSTEM_ID upper, - -> _>
set -uo pipefail

SYSTEM_ID="${1:?usage: safe-remediate.sh <system_id>}"

# id -> Railwayサービス名 のマッピング(2026-07-18時点のベストな推定。
# RAILWAY_TOKEN投入時にオーナー/次のEngineerセッションが実際のRailway
# ダッシュボードのサービス名と突合して要修正の可能性あり)。
declare -A SERVICE_NAME=(
  [fuu]="fuu"
  [jobqueue-gate]="jobqueue-gate-backend"
  [ads-ops-backend]="ads-ops-backend"
)

if [[ -z "${SERVICE_NAME[$SYSTEM_ID]+x}" ]]; then
  echo "[safe-remediate] REFUSED: '${SYSTEM_ID}' is not in the remediation whitelist (fuu / jobqueue-gate / ads-ops-backend only)." >&2
  exit 1
fi

SERVICE="${SERVICE_NAME[$SYSTEM_ID]}"

# system_id -> env var suffix (ハイフンをアンダースコアに、大文字化)
ENV_SUFFIX=$(echo "${SYSTEM_ID}" | tr '[:lower:]-' '[:upper:]_')
PER_SYSTEM_VAR="RAILWAY_TOKEN_${ENV_SUFFIX}"
TOKEN="${!PER_SYSTEM_VAR:-${RAILWAY_TOKEN:-}}"

if [[ -z "${TOKEN}" ]]; then
  echo "[safe-remediate] skipped(no-token): neither ${PER_SYSTEM_VAR} nor RAILWAY_TOKEN is set. system-health-monitor(死活監視)自体は正常に継続しています。"
  echo "REMEDIATE_RESULT=skipped(no-token)"
  exit 0
fi

if ! command -v railway >/dev/null 2>&1; then
  echo "[safe-remediate] installing railway CLI..."
  npm install -g @railway/cli@latest >/dev/null 2>&1 || {
    echo "[safe-remediate] skipped(cli-install-failed)"
    echo "REMEDIATE_RESULT=skipped(cli-install-failed)"
    exit 0
  }
fi

echo "[safe-remediate] redeploying whitelisted service '${SERVICE}' (system_id=${SYSTEM_ID})..."
export RAILWAY_TOKEN="${TOKEN}"
if railway redeploy --service "${SERVICE}" --yes; then
  echo "[safe-remediate] redeploy triggered OK for ${SYSTEM_ID}"
  echo "REMEDIATE_RESULT=triggered"
  exit 0
else
  echo "[safe-remediate] redeploy command failed for ${SYSTEM_ID} (service name may need correction: ${SERVICE})" >&2
  echo "REMEDIATE_RESULT=failed"
  exit 0
fi
