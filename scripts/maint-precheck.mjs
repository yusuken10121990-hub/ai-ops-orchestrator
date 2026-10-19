#!/usr/bin/env node
// maint-precheck.mjs
//
// 2026-10-19: deterministic pre-step for maintenance-weekly. The Claude-driven SKILL kept
// recording "logs: skipped(no-railway-token)", "backup: skipped(no-repo-access)" and
// "audit: skipped(local-unreachable)" for most systems because the cloud runner had no
// Railway CLI login and no repo checkouts. This script gathers what the runner CAN reach
// and writes memory/maintenance-precheck.json; the SKILL reads it instead of skipping.
//
//   logs   : Railway (RAILWAY_API_TOKEN, account token already used by ops-auto-repair-cloud)
//            -> latest deployment status, error-level log lines and HTTP 5xx in the last 7 days.
//   backup : product repos cloned by checkout-product-repos.sh -> remote HEAD sha/date
//            (= the rollback source exists and is reachable).
//   audit  : copied from memory/security-status.json (security-daily, same day).
//
// Public repo / public logs: stdout prints counts only. No secrets are printed.
// Exit code is always 0.

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJson } from './read-json.mjs';

const SYSTEMS_JSON = process.env.SYSTEMS_JSON || 'config/memory/systems.json';
const MEM = dirname(SYSTEMS_JSON);
const OUT = process.env.PRECHECK_JSON || join(MEM, 'maintenance-precheck.json');
const REPOS_DIR = process.env.REPOS_DIR || 'repos';
const TOKEN = process.env.RAILWAY_API_TOKEN || '';
const GQL = 'https://backboard.railway.com/graphql/v2';
const WEEK_AGO = new Date(Date.now() - 7 * 86400000).toISOString();

// same mapping idea as security-daily.mjs: systems.json `repo` string -> cloned dir
const REPOS = [
  { dir: 'sales-research-tool', match: /sales-research-tool/ },
  { dir: 'lp-ai-system-saas', match: /ai-system-saas-lp|lp-ai-system-saas/ },
  { dir: 'crudtest1', match: /crudtest1/ },
  { dir: 'ai-business-ops', match: /ai-business-ops/ },
  { dir: 'meo-backend', match: /meo-backend/ },
  { dir: 'jobqueue-backend', match: /jobqueue/ },
  { dir: 'lp-camp-c7faa7c45e', match: /campaigns[\\/]camp_c7faa7c45e\s*$/ },
  { dir: 'aim', match: /hub\/aim\b|user[\\/]aim\b/ },
  { dir: 'ai-call-system', match: /ai-call-system/ },
  { dir: 'torasaburo-vms', match: /torasaburo-vms/ },
  { dir: 'iwill-erp', match: /iwill-erp/ },
  { dir: 'commander', match: /[\\/]commander\s*$/ },
  { dir: 'biz-erp-5', match: /Desktop[\\/]5\s*$/ },
  { dir: 'shodensha-page-assistant', match: /shodensha-page-assistant/ },
];

async function gql(query, variables = {}) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.errors) throw new Error(`railway-gql-${res.status}:${String(j.errors?.[0]?.message || '').slice(0, 80)}`);
  return j.data;
}

async function railwayInstances() {
  const data = await gql(`query {
    projects { edges { node { name services { edges { node { name serviceInstances { edges { node {
      environmentId
      domains { serviceDomains { domain } customDomains { domain } }
      latestDeployment { id status createdAt }
    } } } } } } } } }
  }`);
  const list = [];
  for (const p of data.projects?.edges || []) {
    for (const s of p.node.services?.edges || []) {
      for (const i of s.node.serviceInstances?.edges || []) {
        const n = i.node;
        const hosts = [...(n.domains?.serviceDomains || []), ...(n.domains?.customDomains || [])].map((d) => d.domain);
        list.push({ project: p.node.name, service: s.node.name, hosts, deployment: n.latestDeployment });
      }
    }
  }
  return list;
}

async function railwayLogs(deploymentId) {
  const out = { errorLines: null, http5xx: null, samples: [] };
  try {
    const d = await gql(`query($id: String!, $start: DateTime) { deploymentLogs(deploymentId: $id, limit: 500, filter: "@level:error", startDate: $start) { message timestamp } }`, { id: deploymentId, start: WEEK_AGO });
    const logs = d.deploymentLogs || [];
    out.errorLines = logs.length;
    out.samples = [...new Set(logs.map((l) => String(l.message).replace(/\s+/g, ' ').slice(0, 140)))].slice(0, 3);
  } catch (e) { out.logsError = e.message; }
  try {
    const d = await gql(`query($id: String!, $start: DateTime) { httpLogs(deploymentId: $id, limit: 1000, startDate: $start) { httpStatus } }`, { id: deploymentId, start: WEEK_AGO });
    const h = d.httpLogs || [];
    out.httpSampled = h.length;
    out.http5xx = h.filter((x) => x.httpStatus >= 500).length;
  } catch (e) { out.httpError = e.message; }
  return out;
}

function repoHead(dir) {
  try {
    const line = execFileSync('git', ['-C', dir, 'log', '-1', '--format=%h %cI'], { encoding: 'utf8' }).trim();
    const [sha, date] = line.split(' ');
    return { sha, date };
  } catch { return null; }
}

async function main() {
  const live = (readJson(SYSTEMS_JSON).systems || []).filter((s) => s.status === 'live');
  let sec = null;
  try { sec = readJson(join(MEM, 'security-status.json')); } catch {}

  let instances = null;
  let railwayError = null;
  if (!TOKEN) railwayError = 'no-railway-api-token';
  else {
    try { instances = await railwayInstances(); } catch (e) { railwayError = e.message; }
  }

  const systems = {};
  const logCache = new Map();
  for (const sys of live) {
    const e = {};
    let host = '';
    try { host = new URL(sys.url).hostname; } catch {}
    const isRailway = /railway/i.test(`${sys.deploy || ''}`) || /\.up\.railway\.app$/.test(host);

    // logs
    if (isRailway) {
      const inst = instances && instances.find((i) => i.hosts.includes(host));
      if (railwayError) e.logs = { status: 'skipped', reason: railwayError };
      else if (!inst) e.logs = { status: 'skipped', reason: 'railway-service-not-found-for-host' };
      else if (!inst.deployment) e.logs = { status: 'finding', reason: 'no-deployment' };
      else {
        if (!logCache.has(inst.deployment.id)) logCache.set(inst.deployment.id, await railwayLogs(inst.deployment.id));
        const l = logCache.get(inst.deployment.id);
        const failedDeploy = !['SUCCESS', 'SLEEPING'].includes(inst.deployment.status);
        const bad = failedDeploy || (l.http5xx || 0) > 0 || (l.errorLines || 0) > 0;
        e.logs = {
          status: l.errorLines == null && l.http5xx == null ? 'skipped' : bad ? 'finding' : 'green',
          source: 'railway-api',
          project: inst.project,
          service: inst.service,
          deploymentStatus: inst.deployment.status,
          deployedAt: inst.deployment.createdAt,
          errorLines7d: l.errorLines,
          http5xx7d: l.http5xx,
          httpSampled: l.httpSampled,
          samples: l.samples,
          ...(l.logsError ? { logsError: l.logsError } : {}),
          ...(l.httpError ? { httpError: l.httpError } : {}),
        };
      }
    }

    // backup / rollback source
    const r = REPOS.find((x) => x.match.test(String(sys.repo || '')));
    if (r) {
      const head = existsSync(join(REPOS_DIR, r.dir)) ? repoHead(join(REPOS_DIR, r.dir)) : null;
      e.backup = head ? { status: 'green', source: 'cloud-clone', repo: r.dir, head: head.sha, lastCommit: head.date } : { status: 'skipped', reason: 'clone-failed-or-no-key', repo: r.dir };
    }

    // audit (from today's security-daily)
    const sd = sec?.systems?.[sys.id]?.checks?.deps;
    if (sd) e.audit = { ...sd, from: 'security-status.json', checked_at: sec.checked_at };

    systems[sys.id] = e;
  }

  const count = (k) => {
    const c = {};
    for (const e of Object.values(systems)) if (e[k]) c[e[k].status] = (c[e[k].status] || 0) + 1;
    return c;
  };
  const result = {
    generatedAt: new Date().toISOString(),
    window: { since: WEEK_AGO },
    railway: { reachable: !railwayError, error: railwayError, instances: instances ? instances.length : 0 },
    summary: { logs: count('logs'), backup: count('backup'), audit: count('audit') },
    systems,
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`[maint-precheck] railway reachable=${!railwayError}${railwayError ? ` (${railwayError})` : ''} instances=${result.railway.instances}`);
  for (const [k, v] of Object.entries(result.summary)) console.log(`  ${k}: ${JSON.stringify(v)}`);
}

main().catch((e) => console.error('[maint-precheck] unexpected error (non-fatal):', String(e && e.message).slice(0, 200)));
