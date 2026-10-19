#!/usr/bin/env node
// maint-fill-expiry.mjs
//
// 2026-10-19: deterministic safety net, run AFTER the Claude-driven maintenance-weekly
// SKILL finishes (i.e. after memory/maintenance-status.json has already been written for
// this run), BEFORE the workflow commits it.
//
// Root cause this closes (measured, see decisions.md + git history of
// memory/maintenance-status.json in the private config repo):
//   - "expiry" (TLS/domain expiry check, SKILL.md step 5) had no deterministic source --
//     every week the LLM free-texted it from scratch.
//   - commit 93569ff1 (2026-10-18 run) had correct per-system "expiry" values
//     (e.g. "green(TLS残75日、2026-12-11)").
//   - commits 82e3250a and b0fd71eb (both 2026-10-19, i.e. 2 consecutive runs) instead wrote
//     one aggregate "http_tls" string ("HTTPS系は全て200(TLS最短39日)") duplicated onto all
//     44 systems and dropped the per-system "expiry" key entirely. Any consumer reading
//     checks.expiry therefore sees it missing for 44/44 systems -- the "monitoring hole".
//
// Fix: maint-precheck.mjs (runs before Claude, deterministic TLS handshake, no credentials)
// now computes a real per-system expiry value into memory/maintenance-precheck.json. This
// script reads that plus the SKILL's own memory/maintenance-status.json output and, for any
// system where checks.expiry is missing, fills it in from the precheck data -- without
// touching anything the SKILL already wrote (reversible, additive only, never overwrites an
// existing checks.expiry so a future SKILL revision that writes it correctly again is not
// clobbered).
//
// Exit code is always 0 (same convention as maint-precheck.mjs): this is a best-effort patch,
// not a hard gate, and must not break the workflow's commit step.

import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readJson } from './read-json.mjs';

const STATUS_JSON = process.env.STATUS_JSON || 'config/memory/maintenance-status.json';
const PRECHECK_JSON = process.env.PRECHECK_JSON || 'config/memory/maintenance-precheck.json';

function formatExpiry(exp) {
  if (!exp) return null;
  if (exp.status === 'skipped') return `skipped(${exp.reason || 'unknown'})`;
  const days = exp.daysRemaining;
  const until = exp.notAfter ? `、${new Date(exp.notAfter).toISOString().slice(0, 10)}まで` : '';
  const label = exp.status === 'finding' ? `finding(${exp.severity || ''})` : 'green';
  return `${label}(TLS残${days}日${until})[tls-handshake:precheck補完]`;
}

export function fillMissingExpiry(status, precheck) {
  let filled = 0;
  let alreadyPresent = 0;
  const systems = Array.isArray(status.systems) ? status.systems : [];
  for (const sys of systems) {
    if (!sys || !sys.id) continue;
    sys.checks = sys.checks || {};
    if (sys.checks.expiry) { alreadyPresent++; continue; }
    const pre = precheck?.systems?.[sys.id]?.expiry;
    const text = formatExpiry(pre);
    if (!text) continue;
    sys.checks.expiry = text;
    filled++;
    if (pre && pre.status === 'finding') {
      status.openFindings = status.openFindings || [];
      const dup = status.openFindings.find((f) => f.area === 'expiry' && f.id === sys.id);
      if (!dup) {
        status.openFindings.push({
          sev: pre.severity || 'P2',
          area: 'expiry',
          id: sys.id,
          detail: `TLS残${pre.daysRemaining}日(閾値30日/14日)`,
          action: 'watch(自動更新想定が多い。更新されない場合は要対応)',
        });
      }
    }
  }
  return { filled, alreadyPresent, total: systems.length };
}

function main() {
  if (!existsSync(STATUS_JSON)) {
    console.log(`[maint-fill-expiry] skip: ${STATUS_JSON} not found (maintenance-weekly SKILL did not run / precheck_only mode)`);
    return;
  }
  if (!existsSync(PRECHECK_JSON)) {
    console.log(`[maint-fill-expiry] skip: ${PRECHECK_JSON} not found (precheck step did not run)`);
    return;
  }
  const status = readJson(STATUS_JSON);
  const precheck = readJson(PRECHECK_JSON);
  const { filled, alreadyPresent, total } = fillMissingExpiry(status, precheck);
  if (filled > 0) {
    writeFileSync(STATUS_JSON, JSON.stringify(status, null, 2) + '\n', 'utf8');
  }
  console.log(`[maint-fill-expiry] systems=${total} already-had-expiry=${alreadyPresent} filled-from-precheck=${filled}`);
}

// Run only when executed directly, not when imported for fillMissingExpiry() (e.g. by
// maint-precheck-expiry-test.mjs) -- otherwise importing this module in a directory that
// happens to have config/memory/maintenance-status.json would mutate it as a side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
