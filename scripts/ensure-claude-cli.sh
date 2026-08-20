#!/usr/bin/env bash
# ensure-claude-cli.sh
#
# Claude Code CLI が「実際に起動できる」ことを確認し、起動コマンドを
# CLAUDE_CMD にセットする。source して使う（実行ではなく読み込み）:
#
#     . "${GITHUB_WORKSPACE}/scripts/ensure-claude-cli.sh"
#     ${CLAUDE_CMD} -p "${PROMPT}" --dangerously-skip-permissions
#
# ── なぜ必要か（2026-08-20 実測。推測ではない）────────────────────────────
#   `npx -y @anthropic-ai/claude-code@latest` は、npxキャッシュの状態によって
#   ネイティブバイナリを取り漏らし、実行時に
#       Error: claude native binary not installed.
#       Either postinstall did not run (--ignore-scripts, some pnpm configs)
#       or the platform-native optional dependency was not downloaded
#   で即死する。2026-08-18〜20 の schedule 実行で
#   zerosys-ad-pdca / ad-pdca-daily / ad-lp-apply-daily / team-learning /
#   learning-enforcer が同じ原因で落ちていた（run 32090463389 / 32207296598 /
#   32323369637 / 32324337923 / 32320895111 / 32324198995 / 32323962432）。
#   間欠障害なので「手で叩くと動く」＝気付きにくい。
#
# ── 対策 ────────────────────────────────────────────────────────────────
#   (1) 本番プロンプトを投げる前に `--version` で起動を確認する
#   (2) 失敗したら npx キャッシュを捨て、postinstall が確実に走る
#       グローバルインストールへフォールバックして再検証する
#   (3) 3回試して駄目なら明示エラーで落とす（プロンプトを投げない）
#
# CLAUDE_CODE_VERSION を渡すとバージョンを固定できる（既定 latest）。

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
  echo "       native binary missing — see scripts/ensure-claude-cli.sh." >&2
  exit 1
fi

echo "claude CLI: ${CLAUDE_CMD} ($(${CLAUDE_CMD} --version 2>/dev/null | head -1))"
