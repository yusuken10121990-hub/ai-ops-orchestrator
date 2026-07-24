#!/usr/bin/env bash
# backup.sh
#
# P0-3 (2026-07-18, CTO設計「保守運用組織の24/7/365拡張」): 本番データの
# 日次暗号化バックアップ。対象は backup-admin.md が定義する最重要2点
#   (a) Railway Postgres(承認ゲート jobqueue-gate) — pg_dump
#   (b) Supabase(zerosys-research の認証+クレジット台帳) — pg_dump
# に加え、PC完全オフライン化Batch4(2026-07-24, dev-integration実装, prior plan
# P1繰越)で以下を追加:
#   (c) Netlify Blobs(jobs/enrich-cache/pending-research) — backup-blobs-export.mjs
#       経由。research.zerosys.jpに既にデプロイ済みのbackup-export.js Function
#       (ai-business/backup/local-backup.mjsがPC側で叩いているのと同じAPI)を
#       OPS_DASHBOARD_KEY(既存secret・新規投入不要)で呼び出すだけで、
#       Netlify Blobsの鍵をこのワークフローが直接扱うことは一切ない。
#
# 各dumpは gzip → gpg --symmetric --cipher-algo AES256 で暗号化してから
# private repo `ai-ops-backups` の Release asset としてアップロードする
# (バイナリ向き・git履歴を汚さない・無料枠)。平文のDB接続文字列・dumpの
# 中身は一切ログ/stdoutに出さない。
#
# secrets(全て未投入でも green終了する設計 = "skipped(no-secrets)"):
#   GATE_DATABASE_URL       : Railwayゲート用Postgres接続文字列
#   SUPABASE_DB_URL   : Supabase用Postgres接続文字列(pg_dump用、SERVICE_ROLE_KEYとは別物)
#   BACKUP_GPG_PASSPHRASE   : gpg暗号化パスフレーズ(オーナーが生成・保管。AIは生成しない)
#   BACKUPS_REPO_TOKEN         : ai-ops-backups(private repo)にrelease作成できるトークン
#                             (fine-grained PAT, contents:write on ai-ops-backups推奨。
#                              自動投入はAuto Mode classifierがブロックしたためオーナー作業=owner-todos.md参照)
#   OPS_DASHBOARD_KEY       : Netlify Blobsエクスポート用(既存secret。dashboard-sync.yml等で
#                             既に使用中のため新規投入不要。未設定でもこの工程だけskipし他は継続)
#
# Usage:
#   BACKUP_STATUS_JSON=config/memory/backup-status.json bash scripts/backup.sh
set -uo pipefail

BACKUP_STATUS_JSON="${BACKUP_STATUS_JSON:-config/memory/backup-status.json}"
BACKUP_REPO="yusuken10121990-hub/ai-ops-backups"
RETENTION_DAILY=14
DATE_JST=$(TZ=Asia/Tokyo date '+%Y%m%d')
NOW_JST=$(TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M JST')
WORKDIR=$(mktemp -d)
trap 'rm -rf "${WORKDIR}"' EXIT

STATUS_GATE="skipped(no-secrets)"
STATUS_SUPABASE="skipped(no-secrets)"
STATUS_BLOBS="skipped(no-secrets)"
SIZE_GATE=""
SIZE_SUPABASE=""
SIZE_BLOBS=""
SHA_GATE=""
SHA_SUPABASE=""
SHA_BLOBS=""
UPLOADED_ANY=0

have_gh_token=0
if [ -n "${BACKUPS_REPO_TOKEN:-}" ]; then
  have_gh_token=1
  export GH_TOKEN="${BACKUPS_REPO_TOKEN}"
fi

dump_and_encrypt() {
  # $1=label $2=DATABASE_URL $3=output-basename(no ext)
  local label="$1" db_url="$2" base="$3"
  if [ -z "${db_url}" ]; then
    echo "[backup] ${label}: DATABASE_URL not set, skipping"
    return 1
  fi
  if [ -z "${BACKUP_GPG_PASSPHRASE:-}" ]; then
    echo "[backup] ${label}: BACKUP_GPG_PASSPHRASE not set, skipping (cannot encrypt)"
    return 1
  fi
  echo "[backup] ${label}: pg_dump..."
  if ! pg_dump "${db_url}" --no-owner --no-privileges -f "${WORKDIR}/${base}.sql" 2>"${WORKDIR}/${base}.err"; then
    echo "[backup] ${label}: pg_dump FAILED" >&2
    cat "${WORKDIR}/${base}.err" >&2
    return 1
  fi
  gzip "${WORKDIR}/${base}.sql"
  gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase "${BACKUP_GPG_PASSPHRASE}" \
    -o "${WORKDIR}/${base}.sql.gz.gpg" "${WORKDIR}/${base}.sql.gz"
  return 0
}

# --- (a) Railway Postgres(承認ゲート) ---
if dump_and_encrypt "gate" "${GATE_DATABASE_URL:-}" "gate-${DATE_JST}"; then
  STATUS_GATE="ok"
  SIZE_GATE=$(stat -c%s "${WORKDIR}/gate-${DATE_JST}.sql.gz.gpg" 2>/dev/null || echo "")
  SHA_GATE=$(sha256sum "${WORKDIR}/gate-${DATE_JST}.sql.gz.gpg" 2>/dev/null | cut -d' ' -f1)
  UPLOADED_ANY=1
fi

# --- (b) Supabase ---
if dump_and_encrypt "supabase" "${SUPABASE_DB_URL:-}" "supabase-${DATE_JST}"; then
  STATUS_SUPABASE="ok"
  SIZE_SUPABASE=$(stat -c%s "${WORKDIR}/supabase-${DATE_JST}.sql.gz.gpg" 2>/dev/null || echo "")
  SHA_SUPABASE=$(sha256sum "${WORKDIR}/supabase-${DATE_JST}.sql.gz.gpg" 2>/dev/null | cut -d' ' -f1)
  UPLOADED_ANY=1
fi

# --- (c) Netlify Blobs(jobs/enrich-cache/pending-research, Batch4 2026-07-24追加) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${OPS_DASHBOARD_KEY:-}" ]; then
  echo "[backup] blobs: OPS_DASHBOARD_KEY not set, skipping"
elif [ -z "${BACKUP_GPG_PASSPHRASE:-}" ]; then
  echo "[backup] blobs: BACKUP_GPG_PASSPHRASE not set, skipping (cannot encrypt)"
elif ! command -v node >/dev/null 2>&1; then
  echo "[backup] blobs: node not available in this runner, skipping"
else
  BLOBS_JSON="${WORKDIR}/blobs-${DATE_JST}.json"
  echo "[backup] blobs: exporting via backup-export.js (research.zerosys.jp)..."
  if BLOBS_EXPORT_JSON="${BLOBS_JSON}" node "${SCRIPT_DIR}/backup-blobs-export.mjs" && [ -s "${BLOBS_JSON}" ]; then
    gzip "${BLOBS_JSON}"
    gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase "${BACKUP_GPG_PASSPHRASE}" \
      -o "${WORKDIR}/blobs-${DATE_JST}.json.gz.gpg" "${BLOBS_JSON}.gz"
    STATUS_BLOBS="ok"
    SIZE_BLOBS=$(stat -c%s "${WORKDIR}/blobs-${DATE_JST}.json.gz.gpg" 2>/dev/null || echo "")
    SHA_BLOBS=$(sha256sum "${WORKDIR}/blobs-${DATE_JST}.json.gz.gpg" 2>/dev/null | cut -d' ' -f1)
    UPLOADED_ANY=1
  else
    echo "[backup] blobs: export produced no output (see logs above), skipping"
    STATUS_BLOBS="skipped(export-empty)"
  fi
fi

if [ "${UPLOADED_ANY}" -eq 1 ]; then
  if [ "${have_gh_token}" -eq 0 ]; then
    echo "[backup] BACKUPS_REPO_TOKEN not set: dumps were created+encrypted but cannot be uploaded to ${BACKUP_REPO}. Discarding (never persisted unencrypted, never committed)."
    STATUS_GATE="skipped(no-gh-token)"
    STATUS_SUPABASE="skipped(no-gh-token)"
    [ "${STATUS_BLOBS}" = "ok" ] && STATUS_BLOBS="skipped(no-gh-token)"
  else
    ASSETS=()
    [ "${STATUS_GATE}" = "ok" ] && ASSETS+=("${WORKDIR}/gate-${DATE_JST}.sql.gz.gpg")
    [ "${STATUS_SUPABASE}" = "ok" ] && ASSETS+=("${WORKDIR}/supabase-${DATE_JST}.sql.gz.gpg")
    [ "${STATUS_BLOBS}" = "ok" ] && ASSETS+=("${WORKDIR}/blobs-${DATE_JST}.json.gz.gpg")

    echo "[backup] creating release backup-${DATE_JST} on ${BACKUP_REPO} with ${#ASSETS[@]} asset(s)..."
    if gh release create "backup-${DATE_JST}" "${ASSETS[@]}" \
        -R "${BACKUP_REPO}" \
        --title "backup-${DATE_JST}" \
        --notes "Daily encrypted backup (gpg AES256). Generated by ai-ops-orchestrator backup-daily workflow." 2>"${WORKDIR}/release.err"; then
      echo "[backup] release created OK"
    else
      # 既に同名releaseがある場合(再実行)はasset追加を試みる
      echo "[backup] release create failed, retrying as upload to existing release..."
      cat "${WORKDIR}/release.err" >&2
      if ! gh release upload "backup-${DATE_JST}" "${ASSETS[@]}" -R "${BACKUP_REPO}" --clobber; then
        echo "[backup] upload also failed" >&2
        [ "${STATUS_GATE}" = "ok" ] && STATUS_GATE="ng(upload-failed)"
        [ "${STATUS_SUPABASE}" = "ok" ] && STATUS_SUPABASE="ng(upload-failed)"
        [ "${STATUS_BLOBS}" = "ok" ] && STATUS_BLOBS="ng(upload-failed)"
      fi
    fi

    # --- 保持ポリシー: 日次14世代を超えたら古いreleaseをprune ---
    echo "[backup] pruning old backup-* releases beyond ${RETENTION_DAILY} generations..."
    ALL_TAGS=$(gh release list -R "${BACKUP_REPO}" --limit 200 --json tagName,createdAt \
      --jq '[.[] | select(.tagName | startswith("backup-"))] | sort_by(.createdAt) | reverse | .[].tagName')
    i=0
    while IFS= read -r tag; do
      [ -z "${tag}" ] && continue
      i=$((i + 1))
      if [ "${i}" -gt "${RETENTION_DAILY}" ]; then
        echo "[backup] pruning old release ${tag}"
        gh release delete "${tag}" -R "${BACKUP_REPO}" --yes --cleanup-tag || true
      fi
    done <<< "${ALL_TAGS}"
  fi
fi

# --- backup-status.json 記録 ---
mkdir -p "$(dirname "${BACKUP_STATUS_JSON}")"
cat > "${BACKUP_STATUS_JSON}" <<EOF
{
  "last_run": "${NOW_JST}",
  "retention_daily": ${RETENTION_DAILY},
  "targets": {
    "gate": { "status": "${STATUS_GATE}", "size_bytes": "${SIZE_GATE}", "sha256": "${SHA_GATE}", "release": "backup-${DATE_JST}" },
    "supabase": { "status": "${STATUS_SUPABASE}", "size_bytes": "${SIZE_SUPABASE}", "sha256": "${SHA_SUPABASE}", "release": "backup-${DATE_JST}" },
    "blobs": { "status": "${STATUS_BLOBS}", "size_bytes": "${SIZE_BLOBS}", "sha256": "${SHA_BLOBS}", "release": "backup-${DATE_JST}" }
  }
}
EOF

echo "[backup] wrote ${BACKUP_STATUS_JSON}"
echo "[backup] gate=${STATUS_GATE} supabase=${STATUS_SUPABASE} blobs=${STATUS_BLOBS}"
exit 0
