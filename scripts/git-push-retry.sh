#!/usr/bin/env bash
# git-push-retry.sh <remote-url> [branch]
#
# Push HEAD:<branch> (default: main) to <remote-url> with retry-on-conflict.
# Multiple loops (team-learning-loop / ad-lp-daily-learning / ad-lp-apply-daily /
# research-team-learning / seo-daily / ad-pdca-daily) can run concurrently and
# all push generated changes (learnings, decisions.md, etc.) back to the same
# repo/branch (ai-ops-config or ai-business-ops). A plain `git push` races and
# non-fast-forward-rejects whichever run loses. Real-world hit: seo-daily and
# ad-lp-daily-learning both pushed to ai-business-ops within the same minute
# and one was rejected.
#
# Fix: on rejection, fetch + rebase onto the remote tip and retry. Content is
# append-only markdown (learnings/decisions logs), so a rebase almost never
# conflicts; if it somehow does, fall back to a plain merge (--no-edit) rather
# than aborting the whole loop, and worst case keep both sides via `git merge
# -X ours`+manual concat is overkill here -- see .gitattributes (merge=union)
# added to ai-ops-config/ai-business-ops for the actual append-only files,
# which makes git auto-resolve concurrent appends to the same file cleanly.
# Must be run from inside the target git working directory.
set -uo pipefail

REMOTE_URL="${1:?usage: git-push-retry.sh <remote-url> [branch]}"
BRANCH="${2:-main}"
MAX_ATTEMPTS=5

for i in $(seq 1 "${MAX_ATTEMPTS}"); do
  if git push "${REMOTE_URL}" "HEAD:${BRANCH}"; then
    echo "[git-push-retry] pushed on attempt ${i}"
    exit 0
  fi
  echo "[git-push-retry] attempt ${i} rejected, fetching + rebasing onto ${BRANCH}..."
  git fetch "${REMOTE_URL}" "${BRANCH}"
  if ! git rebase FETCH_HEAD; then
    echo "[git-push-retry] rebase had conflicts, aborting rebase and trying a plain merge instead"
    git rebase --abort || true
    if ! git pull --no-rebase "${REMOTE_URL}" "${BRANCH}" --no-edit; then
      echo "[git-push-retry] merge also failed, giving up this attempt" >&2
    fi
  fi
  sleep "$(( (RANDOM % 5) + 2 ))"
done

echo "[git-push-retry] FAILED after ${MAX_ATTEMPTS} attempts" >&2
exit 1
