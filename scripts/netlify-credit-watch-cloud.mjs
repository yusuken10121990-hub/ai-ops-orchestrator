// netlify-credit-watch-cloud.mjs
// Cloud (GitHub Actions) replacement for the PC-only scheduled task
// AIOps-NetlifyCreditWatch-Headless (.claude/scripts/netlify-credit-watch.mjs).
// Logic mirrors the PC script 1:1, with two PC-only pieces swapped for cloud
// equivalents that already exist and use only already-registered secrets:
//   - approval queue: request_action.ps1 (local PowerShell) -> direct POST to
//     the cloud gate (GATE_URL/actions, header x-agent-key: GATE_AGENT_KEY),
//     same {type, title, requires_approval, payload} body shape.
//   - health/log file: .claude/memory/local-watch-status.json (PC-only) ->
//     config/memory/health-status.json (the shared cloud-owned file other
//     *-cloud workflows already read/write), committed back by the workflow.
//
// Env required: NETLIFY_AUTH_TOKEN, GATE_URL, GATE_AGENT_KEY, HEALTH_STATUS_JSON
// (path to config/memory/health-status.json checked out by the workflow).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const HEALTH = process.env.HEALTH_STATUS_JSON || 'config/memory/health-status.json';
const SITES = ['https://zerosys.jp', 'https://research.zerosys.jp', 'https://aiwill-ops-dashboard.netlify.app'];
const now = new Date().toISOString();

// --- 1. credits via netlify CLI (canonical: capabilities.credits) ---
let credits = null;
let apiFailed = false;
try {
  const out = execFileSync('netlify', ['api', 'listAccountsForUser', '--data', '{}'], {
    timeout: 60000, encoding: 'utf8',
  });
  const accounts = JSON.parse(out.slice(out.indexOf('[')));
  const acct = accounts.find((a) => (a.slug || '').includes('yusuke-n10121990')) || accounts[0];
  const c = acct?.capabilities?.credits || {};
  const included = c.included ?? null;
  const used = c.used ?? null;
  credits = {
    included,
    used,
    remainingPct: (included && used != null) ? Math.round(((included - used) / included) * 1000) / 10 : null,
    usagesExceeded: acct?.usages_exceeded || [],
  };
} catch (e) {
  apiFailed = true; // FAIL-CLOSED: do not guess credit numbers
  console.error(`api-failed ${String(e.message).slice(0, 300)}`);
}

// --- 2. site pause checks (AND condition: non-200 + marker + body < 5000 bytes) ---
const siteStatus = {};
const paused = [];
for (const url of SITES) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
    const body = await res.text();
    siteStatus[new URL(url).hostname] = res.status;
    const marker = /Site not available|usage limits/i.test(body);
    if (res.status !== 200 && marker && body.length < 5000) paused.push(url);
  } catch {
    siteStatus[new URL(url).hostname] = 0; // network error, not proof of pause
  }
}

// --- 3. judge ---
const usagesExceeded = credits?.usagesExceeded || [];
const warning = credits?.remainingPct != null && credits.remainingPct < 30;
const stopped = usagesExceeded.length > 0 || paused.length > 0;

// --- 4. dedupe: no re-queue within 24h (state kept in health-status.json itself) ---
let prevHealth = {};
try { prevHealth = JSON.parse(fs.readFileSync(HEALTH, 'utf8')); } catch {}
const lastQueuedAt = prevHealth?.netlify?.last_queued_approval_at || null;
const recentlyQueued = !!(lastQueuedAt && (Date.now() - new Date(lastQueuedAt).getTime()) < 24 * 3600 * 1000);

let queuedThisRun = false;
if ((warning || stopped) && !recentlyQueued) {
  try {
    const gateUrl = String(process.env.GATE_URL || '').replace(/\/$/, '') + '/actions';
    const resp = await fetch(gateUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-agent-key': process.env.GATE_AGENT_KEY || '' },
      body: JSON.stringify({
        type: 'execute_action',
        title: 'Netlifyクレジット追加購入 1,500クレジット(約$10)',
        requires_approval: true,
        payload: { action: 'netlify_credit_topup', team: 'yusuke-n10121990' },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const txt = await resp.text().catch(() => '');
    console.log(`queued-approval warning=${warning} stopped=${stopped} status=${resp.status} body=${txt.slice(0, 200)}`);
    queuedThisRun = resp.ok;
  } catch (e) {
    console.error(`gate-post-failed ${String(e.message).slice(0, 200)}`);
  }
}

// --- 5. health-status.json netlify block ---
try {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(HEALTH, 'utf8')); } catch {}
  j.netlify = {
    checked_at: now,
    status: stopped ? 'stopped' : warning ? 'warning' : apiFailed ? 'api-failed' : 'ok',
    credits_included: credits?.included ?? 'UNKNOWN',
    credits_used: credits?.used ?? 'UNKNOWN',
    credits_remaining_pct: credits?.remainingPct ?? 'UNKNOWN',
    usages_exceeded: usagesExceeded,
    sites: siteStatus,
    last_queued_approval_at: queuedThisRun ? now : (lastQueuedAt || null),
  };
  fs.writeFileSync(HEALTH, JSON.stringify(j, null, 2) + '\n', 'utf8');
} catch (e) {
  console.error(`health-json-skip ${String(e.message).slice(0, 200)}`);
}

console.log(stopped
  ? `STOPPED usages=${JSON.stringify(usagesExceeded)} paused=${paused.join(',')}`
  : warning
    ? `warning remaining=${credits.remainingPct}%`
    : apiFailed
      ? `ok-sites-only sites=${JSON.stringify(siteStatus)}`
      : `ok remaining=${credits?.remainingPct}% sites=${JSON.stringify(siteStatus)}`);
