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

// 2026-10-19 run 39212354359: one nested query (projects->services->serviceInstances->domains)
// came back "Not Authorized" for the whole tree, so nothing was checked. Query step by step
// instead (same minimal projects query ops-auto-repair-cloud already succeeds with), and
// keep going when one project/service is refused. Stage errors are kept for diagnosis.
const stageErrors = {};
function noteErr(stage, e) {
  const k = `${stage}:${String(e.message).replace(/^railway-gql-/, '').slice(0, 70)}`;
  stageErrors[k] = (stageErrors[k] || 0) + 1;
}

async function railwayInstances() {
  const data = await gql(`query { projects { edges { node { id name } } } }`);
  const list = [];
  for (const pe of data.projects?.edges || []) {
    const p = pe.node;
    let proj;
    try {
      proj = (await gql(`query($id: String!) { project(id: $id) {
        environments { edges { node { id name } } }
        services { edges { node { id name } } }
      } }`, { id: p.id })).project;
    } catch (e) { noteErr('project', e); continue; }
    const envs = (proj.environments?.edges || []).map((x) => x.node);
    const env = envs.find((x) => x.name === 'production') || envs[0];
    if (!env) continue;
    for (const se of proj.services?.edges || []) {
      const s = se.node;
      let hosts = [];
      try {
        const d = (await gql(`query($p: String!, $e: String!, $s: String!) { domains(projectId: $p, environmentId: $e, serviceId: $s) {
          serviceDomains { domain } customDomains { domain } } }`, { p: p.id, e: env.id, s: s.id })).domains;
        hosts = [...(d?.serviceDomains || []), ...(d?.customDomains || [])].map((x) => x.domain);
      } catch (e) { noteErr('domains', e); }
      if (!hosts.length) continue;
      let deployment = null;
      try {
        const d = await gql(`query($p: String!, $e: String!, $s: String!) { deployments(first: 1, input: { projectId: $p, environmentId: $e, serviceId: $s }) {
          edges { node { id status createdAt } } } }`, { p: p.id, e: env.id, s: s.id });
        deployment = d.deployments?.edges?.[0]?.node || null;
      } catch (e) { noteErr('deployments', e); }
      list.push({ project: p.name, service: s.name, hosts, deployment });
    }
  }
  return list;
}

// Netlify: no log API, but deploy history shows build/deploy failures (the "deploy failure"
// part of check ①). Uses NETLIFY_AUTH_TOKEN (already given to this workflow).
async function netlifySites() {
  const tok = process.env.NETLIFY_AUTH_TOKEN;
  if (!tok) throw new Error('no-netlify-token');
  const h = { Authorization: `Bearer ${tok}` };
  const res = await fetch('https://api.netlify.com/api/v1/sites?per_page=200', { headers: h, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`netlify-${res.status}`);
  return { sites: await res.json(), h };
}

async function netlifyDeploys(site, h) {
  const res = await fetch(`https://api.netlify.com/api/v1/sites/${site.id}/deploys?per_page=20`, { headers: h, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`netlify-deploys-${res.status}`);
  const deps = (await res.json()).filter((d) => d.created_at >= WEEK_AGO);
  const failed = deps.filter((d) => d.state === 'error');
  return { deploys7d: deps.length, failed7d: failed.length, samples: [...new Set(failed.map((d) => String(d.error_message || '').slice(0, 140)))].slice(0, 3), publishedAt: site.published_deploy?.published_at || null };
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
  let netlify = null;
  let netlifyError = null;
  try { netlify = await netlifySites(); } catch (e) { netlifyError = e.message; }
  const netlifyHost = (s) => [s.url, s.ssl_url, s.custom_domain, ...(s.domain_aliases || [])].filter(Boolean).map((x) => { try { return new URL(/^https?:/.test(x) ? x : `https://${x}`).hostname; } catch { return ''; } });
  const netlifyCache = new Map();

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
    } else if (/netlify/i.test(`${sys.deploy || ''}`) || /\.netlify\.app$/.test(host)) {
      const site = netlify && netlify.sites.find((s) => netlifyHost(s).includes(host));
      if (netlifyError) e.logs = { status: 'skipped', reason: netlifyError };
      else if (!site) e.logs = { status: 'skipped', reason: 'netlify-site-not-found-for-host' };
      else {
        try {
          if (!netlifyCache.has(site.id)) netlifyCache.set(site.id, await netlifyDeploys(site, netlify.h));
          const d = netlifyCache.get(site.id);
          e.logs = { status: d.failed7d > 0 ? 'finding' : 'green', source: 'netlify-deploys', site: site.name, ...d, note: 'デプロイ失敗の有無(関数の実行ログはAPI非提供)' };
        } catch (err) { e.logs = { status: 'skipped', reason: err.message }; }
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
    railway: { reachable: !railwayError, error: railwayError, instances: instances ? instances.length : 0, stageErrors },
    netlify: { reachable: !netlifyError, error: netlifyError, sites: netlify ? netlify.sites.length : 0 },
    summary: { logs: count('logs'), backup: count('backup'), audit: count('audit') },
    systems,
  };
  writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`[maint-precheck] railway reachable=${!railwayError}${railwayError ? ` (${railwayError})` : ''} instances=${result.railway.instances} stageErrors=${JSON.stringify(stageErrors)}`);
  console.log(`[maint-precheck] netlify reachable=${!netlifyError}${netlifyError ? ` (${netlifyError})` : ''} sites=${result.netlify.sites}`);
  for (const [k, v] of Object.entries(result.summary)) console.log(`  ${k}: ${JSON.stringify(v)}`);
}

main().catch((e) => console.error('[maint-precheck] unexpected error (non-fatal):', String(e && e.message).slice(0, 200)));
