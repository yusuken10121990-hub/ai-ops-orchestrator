#!/usr/bin/env bash
# backup.sh
#
# P0-3 (2026-07-18, CTO設計「保守運用組織の24/7/365拡張」): 本番データの
# 日次暗号化バックアップ。対象は backup-admin.md が定義する最重要2点
#   (a) Railway Postgres(承認ゲート jobqueue-gate) — pg_dump
#   (b) Supabase(zerosys-research の認証+クレジット台帳) — backup-export.js
#       経由のJSONエクスポート(2026-07-24 pcoff-secrets-one-enter仕上げで
#       pg_dump+SUPABASE_DB_URLから置換。理由は下記参照)
# に加え、PC完全オフライン化Batch4(2026-07-24, dev-integration実装, prior plan
# P1繰越)で以下を追加:
#   (c) Netlify Blobs(jobs/enrich-cache/pending-research) — backup-blobs-export.mjs
#       経由。research.zerosys.jpに既にデプロイ済みのbackup-export.js Function
#       (ai-business/backup/local-backup.mjsがPC側で叩いているのと同じAPI)を
#       OPS_DASHBOARD_KEY(既存secret・新規投入不要)で呼び出すだけで、
#       Netlify Blobsの鍵をこのワークフローが直接扱うことは一切ない。
#
# 各dumpは gzip → gpg --symmetric --cipher-algo AES256 で暗号化してから
# private repo `ai-ops-backups` へ git push(SSH deploy key)でコミットする
# (ai-business/backup/local-backup.mjs=PC側の日次バックアップと全く同じ
# dumps/YYYY-MM-DD/ + manifest.json のレイアウトに統一。2026-07-24以前は
# `gh release create`(要BACKUPS_REPO_TOKEN=手動発行PAT)を使っていたが、
# 「オーナーのタイプ数ゼロ化」の一環でSSH deploy key方式に置換した
# — deploy keyは他のCONFIG_DEPLOY_KEY/CRUDTEST1_DEPLOY_KEY等と同じく
# provision-pcoff-values.ps1が自己生成してgh repo deploy-key addで登録する
# だけで済み、オーナーがPATをGitHub設定画面で手動発行する必要が無くなる)。
# 平文のDB接続文字列・dumpの中身は一切ログ/stdoutに出さない。
#
# secrets(全て未投入でも green終了する設計 = "skipped(no-secrets)"):
#   GATE_DATABASE_URL      : Railwayゲート用Postgres接続文字列
#   BACKUP_GPG_PASSPHRASE  : gpg暗号化パスフレーズ(オーナーが生成・保管。AIは生成しない。
#                            provision-pcoff-values.ps1がC:\Users\user\.claude\
#                            backup_passphrase.txtから自動読込するため手入力不要)
#   BACKUPS_REPO_DEPLOY_KEY: ai-ops-backups(private repo)への書き込み用SSH deploy key
#                            (provision-pcoff-values.ps1が自己生成・自動登録。手動PAT発行は廃止)
#   OPS_DASHBOARD_KEY      : Supabase/Netlify Blobsエクスポート用(既存secret。dashboard-sync.yml等で
#                            既に使用中のため新規投入不要。未設定でもこの工程だけskipし他は継続)
#
# Usage:
#   BACKUP_STATUS_JSON=config/memory/backup-status.json bash scripts/backup.sh
# 前提: setup-ssh-keys.sh が事前に実行され、BACKUPS_REPO_DEPLOY_KEYが渡されて
# いれば ~/.ssh/id_ai-ops-backups + Host ai-ops-backups-gh が設定済みであること。
set -uo pipefail

BACKUP_STATUS_JSON="${BACKUP_STATUS_JSON:-config/memory/backup-status.json}"
BACKUPS_REPO_SSH="git@ai-ops-backups-gh:yusuken10121990-hub/ai-ops-backups.git"
BACKUPS_REPO_KEYFILE="$HOME/.ssh/id_ai-ops-backups"
RETENTION_DAILY=14
DATE_JST=$(TZ=Asia/Tokyo date '+%Y-%m-%d')
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
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

encrypt_file() {
  # $1=input path (plaintext, will be gzipped+encrypted in place under WORKDIR)
  # $2=output basename (no ext) -> writes ${WORKDIR}/${2}.gz.gpg
  local in_path="$1" base="$2"
  if [ -z "${BACKUP_GPG_PASSPHRASE:-}" ]; then
    return 1
  fi
  gzip -c "${in_path}" > "${WORKDIR}/${base}.gz"
  gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase "${BACKUP_GPG_PASSPHRASE}" \
    -o "${WORKDIR}/${base}.gz.gpg" "${WORKDIR}/${base}.gz"
  return 0
}

# --- (a) Railway Postgres(承認ゲート) — pg_dump ---
if [ -z "${GATE_DATABASE_URL:-}" ]; then
  echo "[backup] gate: DATABASE_URL not set, skipping"
elif [ -z "${BACKUP_GPG_PASSPHRASE:-}" ]; then
  echo "[backup] gate: BACKUP_GPG_PASSPHRASE not set, skipping (cannot encrypt)"
else
  echo "[backup] gate: pg_dump..."
  if pg_dump "${GATE_DATABASE_URL}" --no-owner --no-privileges -f "${WORKDIR}/gate-${DATE_JST}.sql" 2>"${WORKDIR}/gate.err"; then
    encrypt_file "${WORKDIR}/gate-${DATE_JST}.sql" "gate-${DATE_JST}.sql"
    STATUS_GATE="ok"
    SIZE_GATE=$(stat -c%s "${WORKDIR}/gate-${DATE_JST}.sql.gz.gpg" 2>/dev/null || echo "")
    SHA_GATE=$(sha256sum "${WORKDIR}/gate-${DATE_JST}.sql.gz.gpg" 2>/dev/null | cut -d' ' -f1)
    UPLOADED_ANY=1
  else
    echo "[backup] gate: pg_dump FAILED" >&2
    cat "${WORKDIR}/gate.err" >&2
    STATUS_GATE="ng(pg_dump-failed)"
  fi
fi

# --- (b) Supabase(users + credits + credit_transactions) via backup-export.js ---
# 2026-07-24: SUPABASE_DB_URL(pg_dump直接接続、Freeプランでは自動バックアップ
# 無しかつDBパスワードのローカル/CLIソースが無いため恒久的にオーナー手入力が
# 必須だった)を廃止し、既にSUPABASE_SERVICE_ROLE_KEY権限で稼働している
# backup-export.js経由のJSONエクスポートに統一(OPS_DASHBOARD_KEY、新規secret不要)。
if [ -z "${OPS_DASHBOARD_KEY:-}" ]; then
  echo "[backup] supabase: OPS_DASHBOARD_KEY not set, skipping"
elif [ -z "${BACKUP_GPG_PASSPHRASE:-}" ]; then
  echo "[backup] supabase: BACKUP_GPG_PASSPHRASE not set, skipping (cannot encrypt)"
elif ! command -v node >/dev/null 2>&1; then
  echo "[backup] supabase: node not available in this runner, skipping"
else
  SUPABASE_JSON="${WORKDIR}/supabase-${DATE_JST}.json"
  echo "[backup] supabase: exporting via backup-export.js (users + credits + credit_transactions)..."
  if OPS_DASHBOARD_KEY="${OPS_DASHBOARD_KEY}" SUPABASE_EXPORT_JSON="${SUPABASE_JSON}" node "${SCRIPT_DIR}/backup-supabase-export.mjs" && [ -s "${SUPABASE_JSON}" ]; then
    encrypt_file "${SUPABASE_JSON}" "supabase-${DATE_JST}.json"
    STATUS_SUPABASE="ok"
    SIZE_SUPABASE=$(stat -c%s "${WORKDIR}/supabase-${DATE_JST}.json.gz.gpg" 2>/dev/null || echo "")
    SHA_SUPABASE=$(sha256sum "${WORKDIR}/supabase-${DATE_JST}.json.gz.gpg" 2>/dev/null | cut -d' ' -f1)
    UPLOADED_ANY=1
  else
    echo "[backup] supabase: export produced no output (see logs above), skipping"
    STATUS_SUPABASE="skipped(export-empty)"
  fi
fi

# --- (c) Netlify Blobs(jobs/enrich-cache/pending-research, Batch4 2026-07-24追加) ---
if [ -z "${OPS_DASHBOARD_KEY:-}" ]; then
  echo "[backup] blobs: OPS_DASHBOARD_KEY not set, skipping"
elif [ -z "${BACKUP_GPG_PASSPHRASE:-}" ]; then
  echo "[backup] blobs: BACKUP_GPG_PASSPHRASE not set, skipping (cannot encrypt)"
elif ! command -v node >/dev/null 2>&1; then
  echo "[backup] blobs: node not available in this runner, skipping"
else
  BLOBS_JSON="${WORKDIR}/blobs-${DATE_JST}.json"
  echo "[backup] blobs: exporting via backup-export.js (research.zerosys.jp)..."
  if OPS_DASHBOARD_KEY="${OPS_DASHBOARD_KEY}" BLOBS_EXPORT_JSON="${BLOBS_JSON}" node "${SCRIPT_DIR}/backup-blobs-export.mjs" && [ -s "${BLOBS_JSON}" ]; then
    encrypt_file "${BLOBS_JSON}" "blobs-${DATE_JST}.json"
    STATUS_BLOBS="ok"
    SIZE_BLOBS=$(stat -c%s "${WORKDIR}/blobs-${DATE_JST}.json.gz.gpg" 2>/dev/null || echo "")
    SHA_BLOBS=$(sha256sum "${WORKDIR}/blobs-${DATE_JST}.json.gz.gpg" 2>/dev/null | cut -d' ' -f1)
    UPLOADED_ANY=1
  else
    echo "[backup] blobs: export produced no output (see logs above), skipping"
    STATUS_BLOBS="skipped(export-empty)"
  fi
fi

# --- git push(SSH deploy key)で ai-ops-backups へコミット + 保持ポリシー ---
BACKUP_DEST_LABEL=""
if [ "${UPLOADED_ANY}" -eq 1 ]; then
  if [ ! -f "${BACKUPS_REPO_KEYFILE}" ]; then
    echo "[backup] BACKUPS_REPO_DEPLOY_KEY not set: dumps were created+encrypted but cannot be pushed to ai-ops-backups. Discarding (never persisted unencrypted, never committed)."
    [ "${STATUS_GATE}" = "ok" ] && STATUS_GATE="skipped(no-deploy-key)"
    [ "${STATUS_SUPABASE}" = "ok" ] && STATUS_SUPABASE="skipped(no-deploy-key)"
    [ "${STATUS_BLOBS}" = "ok" ] && STATUS_BLOBS="skipped(no-deploy-key)"
  else
    BREPO="${WORKDIR}/ai-ops-backups-checkout"
    echo "[backup] cloning ai-ops-backups via deploy key..."
    if git clone --depth 50 --branch main "${BACKUPS_REPO_SSH}" "${BREPO}" 2>"${WORKDIR}/clone.err"; then
      DEST="${BREPO}/dumps/${DATE_JST}"
      mkdir -p "${DEST}"
      [ "${STATUS_GATE}" = "ok" ] && cp "${WORKDIR}/gate-${DATE_JST}.sql.gz.gpg" "${DEST}/"
      [ "${STATUS_SUPABASE}" = "ok" ] && cp "${WORKDIR}/supabase-${DATE_JST}.json.gz.gpg" "${DEST}/"
      [ "${STATUS_BLOBS}" = "ok" ] && cp "${WORKDIR}/blobs-${DATE_JST}.json.gz.gpg" "${DEST}/"
      cat > "${DEST}/manifest.json" <<EOF
{
  "date": "${DATE_JST}",
  "generatedAt": "${NOW_JST}",
  "source": "ai-ops-orchestrator/backup-daily.yml (cloud)",
  "gate": { "status": "${STATUS_GATE}", "size_bytes": "${SIZE_GATE}", "sha256": "${SHA_GATE}" },
  "supabase": { "status": "${STATUS_SUPABASE}", "size_bytes": "${SIZE_SUPABASE}", "sha256": "${SHA_SUPABASE}" },
  "blobs": { "status": "${STATUS_BLOBS}", "size_bytes": "${SIZE_BLOBS}", "sha256": "${SHA_BLOBS}" }
}
EOF
      BACKUP_DEST_LABEL="dumps/${DATE_JST}"
      (
        cd "${BREPO}"
        git config user.name "github-actions[bot]"
        git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
        git add -A "dumps/${DATE_JST}"

        # --- 保持ポリシー: 日次14世代を超えた古い dumps/YYYY-MM-DD を削除 ---
        if [ -d dumps ]; then
          ALL_DATES=$(find dumps -maxdepth 1 -mindepth 1 -type d -printf '%f\n' 2>/dev/null | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort -r)
          i=0
          while IFS= read -r d; do
            [ -z "${d}" ] && continue
            i=$((i + 1))
            if [ "${i}" -gt "${RETENTION_DAILY}" ]; then
              echo "[backup] pruning old dumps/${d}"
              git rm -r -q "dumps/${d}" 2>/dev/null || rm -rf "dumps/${d}"
            fi
          done <<< "${ALL_DATES}"
        fi

        if git diff --cached --quiet && [ -z "$(git status --porcelain)" ]; then
          echo "[backup] no changes to commit"
        else
          git add -A
          git commit -q -m "chore: daily backup ${DATE_JST} (retention ${RETENTION_DAILY}d)"
          if ! bash "${SCRIPT_DIR}/git-push-retry.sh" "${BACKUPS_REPO_SSH}" main; then
            echo "[backup] git push to ai-ops-backups FAILED" >&2
            [ "${STATUS_GATE}" = "ok" ] && STATUS_GATE="ng(push-failed)"
            [ "${STATUS_SUPABASE}" = "ok" ] && STATUS_SUPABASE="ng(push-failed)"
            [ "${STATUS_BLOBS}" = "ok" ] && STATUS_BLOBS="ng(push-failed)"
          fi
        fi
      )
    else
      echo "[backup] git clone of ai-ops-backups FAILED" >&2
      cat "${WORKDIR}/clone.err" >&2
      [ "${STATUS_GATE}" = "ok" ] && STATUS_GATE="ng(clone-failed)"
      [ "${STATUS_SUPABASE}" = "ok" ] && STATUS_SUPABASE="ng(clone-failed)"
      [ "${STATUS_BLOBS}" = "ok" ] && STATUS_BLOBS="ng(clone-failed)"
    fi
  fi
fi

# --- backup-status.json 記録 ---
mkdir -p "$(dirname "${BACKUP_STATUS_JSON}")"
cat > "${BACKUP_STATUS_JSON}" <<EOF
{
  "last_run": "${NOW_JST}",
  "retention_daily": ${RETENTION_DAILY},
  "targets": {
    "gate": { "status": "${STATUS_GATE}", "size_bytes": "${SIZE_GATE}", "sha256": "${SHA_GATE}", "release": "${BACKUP_DEST_LABEL}" },
    "supabase": { "status": "${STATUS_SUPABASE}", "size_bytes": "${SIZE_SUPABASE}", "sha256": "${SHA_SUPABASE}", "release": "${BACKUP_DEST_LABEL}" },
    "blobs": { "status": "${STATUS_BLOBS}", "size_bytes": "${SIZE_BLOBS}", "sha256": "${SHA_BLOBS}", "release": "${BACKUP_DEST_LABEL}" }
  }
}
EOF

echo "[backup] wrote ${BACKUP_STATUS_JSON}"
echo "[backup] gate=${STATUS_GATE} supabase=${STATUS_SUPABASE} blobs=${STATUS_BLOBS}"
exit 0
