#!/usr/bin/env node
// checkout-ai-business-retry-test.mjs — regression test for the retry() helper added to
// scripts/checkout-ai-business.sh after a transient SSH drop failed the
// creative-studio-apply-runner workflow once (run 39643293922, 2026-10-21T17:23Z:
// "Connection to github.com closed by remote host" while cloning ai-business-ops, even
// though the deploy key was valid and an immediate re-run succeeded). See that script's
// header comment for the full root-cause note.
//
// Covers, offline / deterministic (no network, no real git clone):
//   1. retry() succeeds once the wrapped command stops failing (transient-failure case,
//      e.g. the SSH drop that triggered this fix) -- without waiting for the real 5s/15s
//      backoff (RETRY_BACKOFFS="0 0" overrides it for the test).
//   2. retry() still propagates a non-zero exit code when the wrapped command always
//      fails (persistent failure must not be swallowed under `set -e`).
//
// The real retry() definition is sourced from scripts/checkout-ai-business.sh itself
// (CHECKOUT_AI_BUSINESS_LIB=1 stops the script before it reaches the actual `git clone`
// calls) so there is exactly one copy of the retry logic -- the test never re-implements it.
//
// Run: node scripts/checkout-ai-business-retry-test.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'checkout-ai-business.sh');

let pass = 0, fail = 0;
function check(name, ok, got) {
  if (ok) { pass++; console.log(`  OK   ${name} -> ${got}`); }
  else { fail++; console.log(`  NG   ${name} -> ${got}`); }
}

function runBash(inlineScript) {
  try {
    const stdout = execFileSync('bash', ['-c', inlineScript], {
      encoding: 'utf8',
      env: { ...process.env, RETRY_BACKOFFS: '0 0' },
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: (err.stdout ?? '').toString() + (err.stderr ?? '').toString() };
  }
}

console.log('checkout-ai-business.sh retry() の回帰テスト');

// 1. transient failure: a fake command fails once, then succeeds -> retry() must
//    eventually return 0 (this is exactly the SSH-drop-then-reconnect case).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-retry-'));
  const counterFile = path.join(dir, 'attempts');
  fs.writeFileSync(counterFile, '0');

  const inline = `
    set -euo pipefail
    export CHECKOUT_AI_BUSINESS_LIB=1
    source "${SCRIPT}"

    flaky() {
      n=$(cat "${counterFile}")
      n=$((n + 1))
      echo "$n" > "${counterFile}"
      if [ "$n" -lt 2 ]; then
        return 1
      fi
      return 0
    }

    retry flaky
    echo "RC=$?"
    echo "ATTEMPTS=$(cat "${counterFile}")"
  `;
  const { code, stdout } = runBash(inline);
  check('transient failure: retry() exits 0 once the command stops failing', code === 0, `code=${code} stdout=${JSON.stringify(stdout)}`);
  check('transient failure: flaky() was retried (ran 2 times, not just once)', /ATTEMPTS=2/.test(stdout), stdout);
  check('transient failure: a "retrying" message was echoed', /\[checkout-ai-business\] attempt 1 failed, retrying in 0s/.test(stdout), stdout);
}

// 2. persistent failure: a command that always fails -> retry() must return non-zero
//    (must NOT be swallowed; the calling script still fails hard under set -e).
//
// Note: sourcing checkout-ai-business.sh also pulls in its `set -euo pipefail` into the
// calling shell (sourcing applies in the current shell, not a subshell) -- so calling
// `retry always_fails` at top level here triggers errexit immediately, exactly like the
// real `retry git clone ...` calls do in the actual script. That means the "echo RC=$?"
// line after it never runs; the process's own exit code (not stdout) is the signal that
// retry()'s final failure was NOT swallowed.
{
  const inline = `
    set -uo pipefail
    export CHECKOUT_AI_BUSINESS_LIB=1
    source "${SCRIPT}"

    always_fails() {
      return 7
    }

    retry always_fails
    echo "UNREACHABLE_UNDER_SET_E"
  `;
  const { code, stdout } = runBash(inline);
  check('persistent failure: retry() final failure propagates as the process exit code (not swallowed)', code === 7, `code=${code} stdout=${JSON.stringify(stdout)}`);
  check('persistent failure: final "giving up" message was echoed', /\[checkout-ai-business\] attempt 3 failed, giving up \(exit 7\)/.test(stdout), stdout);
  check('persistent failure: set -e (inherited from sourcing) stopped execution before the next line', !/UNREACHABLE_UNDER_SET_E/.test(stdout), stdout);
}

// 3. sourcing the real script with CHECKOUT_AI_BUSINESS_LIB=1 must not run any `git clone`
//    (guards the "one source of truth" structure itself, not just the retry logic).
{
  const inline = `
    set -euo pipefail
    export CHECKOUT_AI_BUSINESS_LIB=1
    source "${SCRIPT}"
    echo "SOURCED_OK"
    type retry > /dev/null && echo "RETRY_DEFINED"
  `;
  const { code, stdout } = runBash(inline);
  check('sourcing with CHECKOUT_AI_BUSINESS_LIB=1 succeeds without running the clones', code === 0 && /SOURCED_OK/.test(stdout), `code=${code} stdout=${JSON.stringify(stdout)}`);
  check('retry() is defined after sourcing as a lib', /RETRY_DEFINED/.test(stdout), stdout);
}

console.log(`\n合計: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
