#!/usr/bin/env node
// security-daily.mjs
//
// 2026-10-19: daily security sweep over every systems.json status:"live" system.
// Before this, nothing checked security every day: maintenance-weekly looked at TLS
// once a week and its npm audit was "skipped" in the cloud for weeks because no repo
// was checked out. Pure script (no Claude call), same policy as health-check.mjs.
//
// Checks (per system / per repo):
//   1. tls       : certificate days left + chain validity (ng < 7d or invalid, warn < 14d)
//   2. exposure  : /.env, /.git/config, /.git/HEAD, SQL dumps served publicly (ng),
//                  admin-ish paths that answer 200 with their own page (warn = verify)
//   3. ai-auth   : AI-calling endpoints found statically in the checked-out repos
//                  (Netlify functions / Express routes that use an LLM SDK) are probed
//                  without credentials with an empty JSON body. 2xx = ng (Denial-of-
//                  Wallet risk), 401/403 = ok, 400/422 = warn (validation before auth).
//                  Systems may also declare securityProbes:[{path,method,body,expect}].
//   4. secrets   : (a) public HTML + same-origin JS bundles, (b) tracked files in every
//                  checked-out repo, scanned for high-confidence key patterns.
//   5. deps      : npm audit --omit=dev (critical/high) and pip-audit for every
//                  checked-out repo; for systems whose repo only exists on the owner's
//                  PC, the PC-side audit in ops-auto-repair-state.json is used if fresh.
//
// THIS REPO IS PUBLIC and so are its Actions logs. Never print a finding's URL, file
// path or matched value to stdout. Details go only to the private config repo
// (memory/security-status.json); stdout carries counts only.
//
// Usage:
//   SYSTEMS_JSON=config/memory/systems.json SECURITY_STATUS_JSON=config/memory/security-status.json \
//   REPOS_DIR=repos node scripts/security-daily.mjs
// Exit code is always 0 (a crash must not stop the status file from being written);
// the workflow turns SECURITY_ALERT= lines into a (detail-free) GitHub Issue.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, basename, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import tls from 'node:tls';
import { readJson } from './read-json.mjs';

const SYSTEMS_JSON = process.env.SYSTEMS_JSON || 'config/memory/systems.json';
const OUT = process.env.SECURITY_STATUS_JSON || 'config/memory/security-status.json';
const REPOS_DIR = process.env.REPOS_DIR || 'repos';
const MEM_DIR = dirname(SYSTEMS_JSON);
const TIMEOUT = 15000;
const UA = 'aiops-security-daily/1.0';
const NPM = 'npm';
const SHELL = process.platform === 'win32'; // npm is npm.cmd on Windows (local test runs)

// Repos the workflow can check out with deploy keys, and which systems.json `repo`
// strings belong to them. `dir` is relative to REPOS_DIR (or absolute via env override).
const REPOS = [
  { key: 'ai-ops-orchestrator', dir: process.env.ORCH_DIR || '.', match: /ai-ops-orchestrator/ },
  { key: 'ai-ops-config', dir: process.env.CONFIG_DIR || 'config', match: /user[\\/]\.claude\s*$/ },
  { key: 'sales-research-tool', dir: 'sales-research-tool', match: /sales-research-tool/ },
  { key: 'lp-ai-system-saas', dir: 'lp-ai-system-saas', match: /ai-system-saas-lp|lp-ai-system-saas/ },
  { key: 'crudtest1', dir: 'crudtest1', match: /crudtest1/ },
  { key: 'ai-business-ops', dir: 'ai-business-ops', match: /ai-business-ops/ },
  { key: 'meo-backend', dir: 'meo-backend', match: /meo-backend/ },
  { key: 'jobqueue-backend', dir: 'jobqueue-backend', match: /jobqueue/ },
  { key: 'meta-ads', dir: 'meta-ads', match: /meta-ads/ },
  // read-only keys added 2026-10-19 (skipped until the owner provisions them)
  { key: 'lp-camp-c7faa7c45e', dir: 'lp-camp-c7faa7c45e', match: /campaigns[\\/]camp_c7faa7c45e\s*$/ },
  { key: 'aim', dir: 'aim', match: /hub\/aim\b|user[\\/]aim\b/ },
  { key: 'ai-call-system', dir: 'ai-call-system', match: /ai-call-system/ },
  { key: 'torasaburo-vms', dir: 'torasaburo-vms', match: /torasaburo-vms/ },
  { key: 'iwill-erp', dir: 'iwill-erp', match: /iwill-erp/ },
  { key: 'commander', dir: 'commander', match: /[\\/]commander\s*$/ },
  { key: 'biz-erp-5', dir: 'biz-erp-5', match: /Desktop[\\/]5\s*$/ },
  { key: 'shodensha-page-assistant', dir: 'shodensha-page-assistant', match: /shodensha-page-assistant/ },
  { key: 'zerosys-dots-tasks', dir: 'zerosys-dots-tasks', match: /zerosys-dots-tasks/ },
];
// Hosts whose TLS/edge is run by a platform we cannot misconfigure (skip TLS/exposure).
const PLATFORM_HOSTS = new Set(['github.com', 'script.google.com']);

const SECRET_PATTERNS = [
  // (?<![\w-]) stops slugs like "desk-automation-..." / "task-..." from matching sk-.
  { name: 'anthropic-key', re: /(?<![\w-])sk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{40,}/, sev: 'ng', mixed: true },
  { name: 'openai-key', re: /(?<![\w-])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|(?<![\w-])sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/, sev: 'ng', mixed: true },
  { name: 'stripe-live-secret', re: /(?:sk|rk)_live_[0-9A-Za-z]{20,}/, sev: 'ng' },
  { name: 'github-token', re: /(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}/, sev: 'ng' },
  { name: 'slack-token', re: /xox[bpas]-[0-9A-Za-z-]{20,}/, sev: 'ng' },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/, sev: 'ng' },
  { name: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, sev: 'ng' },
  { name: 'supabase-service-role', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, sev: 'ng', jwtRole: 'service_role' },
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/, sev: 'warn' }, // often public by design (Maps/Firebase)
];
const EXPOSURE_PATHS = [
  { path: '/.env', test: (b) => /^[A-Z][A-Z0-9_]{2,}=\S/m.test(b) && !/<html/i.test(b) },
  { path: '/.git/config', test: (b) => b.includes('[core]') },
  { path: '/.git/HEAD', test: (b) => /^ref: refs\//.test(b) },
  { path: '/backup.sql', test: (b) => /CREATE TABLE|INSERT INTO/i.test(b) && !/<html/i.test(b) },
  { path: '/dump.sql', test: (b) => /CREATE TABLE|INSERT INTO/i.test(b) && !/<html/i.test(b) },
];
const ADMIN_PATHS = ['/admin', '/admin/', '/wp-admin/', '/phpmyadmin/', '/_admin'];
const AI_SDK_RE = /@anthropic-ai\/sdk|api\.anthropic\.com|from ['"]openai['"]|require\(['"]openai['"]\)|api\.openai\.com|@google\/generative-ai|@google\/genai|generativelanguage\.googleapis\.com|anthropic\.Anthropic\(|import anthropic|from anthropic|import openai|google\.generativeai/;
const AUTH_MARKER_RE = /authorization|x-api-key|x-ops-key|bearer|verify(?:Id)?Token|getUser\(|requireAuth|isAuthenticated|session|OPS_DASHBOARD_KEY|STUDIO_KEY|RUNNER_API_KEY|AGENT_KEY|api_key|apikey|turnstile|recaptcha|hcaptcha|rateLimit|rate_limit|stripe\.checkout|paymentIntent|jwt/i;

const now = new Date();
const jst = () => new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' JST';
const sevRank = { ok: 0, skipped: 0, warn: 1, ng: 2 };
const worst = (a, b) => ((sevRank[b] ?? 0) > (sevRank[a] ?? 0) ? b : a);

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function get(url, opts = {}) {
  try {
    const res = await fetch(url, { redirect: opts.redirect || 'follow', method: opts.method || 'GET', headers: { 'user-agent': UA, ...(opts.headers || {}) }, body: opts.body, signal: AbortSignal.timeout(TIMEOUT) });
    const text = opts.noBody ? '' : (await res.text().catch(() => '')).slice(0, 3_000_000);
    return { status: res.status, text, location: res.headers.get('location') || '', finalUrl: res.url };
  } catch (e) {
    return { status: null, text: '', error: String(e.message || e).slice(0, 120) };
  }
}

function tlsCheck(host) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: TIMEOUT, rejectUnauthorized: false }, () => {
      const cert = sock.getPeerCertificate();
      const authorized = sock.authorized;
      const authError = sock.authorizationError ? String(sock.authorizationError) : undefined;
      sock.end();
      if (!cert || !cert.valid_to) return resolve({ status: 'ng', reason: 'no-certificate' });
      const days = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86400000);
      let status = days < 7 ? 'ng' : days < 14 ? 'warn' : 'ok';
      if (!authorized) status = 'ng';
      resolve({ status, daysLeft: days, validTo: new Date(cert.valid_to).toISOString().slice(0, 10), ...(authorized ? {} : { reason: `chain-invalid:${authError}` }) });
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ status: 'ng', reason: 'tls-timeout' }); });
    sock.on('error', (e) => resolve({ status: 'ng', reason: `tls-error:${String(e.code || e.message).slice(0, 60)}` }));
  });
}

function decodeJwtRole(tok) {
  try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8')).role || null; } catch { return null; }
}

// Returns [{pattern, sev, line?}] -- never the value itself.
function scanText(text, withLines) {
  const hits = [];
  for (const p of SECRET_PATTERNS) {
    const re = new RegExp(p.re.source, 'g');
    let m;
    while ((m = re.exec(text)) && hits.length < 50) {
      if (p.jwtRole && decodeJwtRole(m[0]) !== p.jwtRole) continue;
      const v = m[0];
      if (/x{6,}|\.\.\.|your[_-]|example|dummy|placeholder|<|REDACTED/i.test(v)) continue;
      // real keys are random: upper + lower + digit. Lowercase slugs/IDs are not keys.
      if (p.mixed && !(/[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v))) continue;
      // test fixtures label themselves on the same line (FAKE_XOXB = "...", # dummy)
      const ls = text.lastIndexOf('\n', m.index) + 1;
      const le = text.indexOf('\n', m.index);
      const lineText = text.slice(ls, le === -1 ? undefined : le);
      if (/fake|dummy|ダミー|mock|fixture/i.test(lineText)) continue;
      const hit = { pattern: p.name, sev: p.sev };
      if (withLines) hit.line = text.slice(0, m.index).split('\n').length;
      hits.push(hit);
    }
  }
  return hits;
}

async function originChecks(origin) {
  const r = { exposure: { status: 'ok', findings: [] }, publicSecrets: { status: 'ok', findings: [] } };
  const root = await get(origin + '/');
  const notFound = await get(origin + `/__aiops_probe_${Date.now().toString(36)}`);
  if (root.status == null) {
    r.exposure = { status: 'skipped', reason: `root-unreachable:${root.error}`, findings: [] };
    r.publicSecrets = { status: 'skipped', reason: 'root-unreachable', findings: [] };
    return r;
  }
  for (const e of EXPOSURE_PATHS) {
    const res = await get(origin + e.path, { redirect: 'manual' });
    if (res.status === 200 && e.test(res.text)) {
      r.exposure.findings.push({ sev: 'ng', kind: 'sensitive-file-public', path: e.path });
    }
  }
  for (const p of ADMIN_PATHS) {
    const res = await get(origin + p, { redirect: 'manual' });
    if (res.status === 200 && res.text && res.text !== root.text && res.text !== notFound.text && /admin|邂｡逅・dashboard|login/i.test(res.text.slice(0, 20000))) {
      const looksLogin = /type=["']?password|繝ｭ繧ｰ繧､繝ｳ|sign in|log in/i.test(res.text);
      if (!looksLogin) r.exposure.findings.push({ sev: 'warn', kind: 'admin-path-200-without-login-form', path: p });
    }
  }
  r.exposure.status = r.exposure.findings.reduce((s, f) => worst(s, f.sev), 'ok');

  // public HTML + same-origin JS bundles
  const srcs = new Set();
  for (const m of root.text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    try { const u = new URL(m[1], origin + '/'); if (u.origin === origin) srcs.add(u.href); } catch {}
  }
  const bodies = [{ where: '/', text: root.text }];
  for (const s of [...srcs].slice(0, 15)) {
    const res = await get(s);
    if (res.status === 200) bodies.push({ where: new URL(s).pathname, text: res.text });
  }
  for (const b of bodies) {
    for (const h of scanText(b.text, false)) r.publicSecrets.findings.push({ ...h, where: b.where });
  }
  r.publicSecrets.scanned = bodies.length;
  r.publicSecrets.status = r.publicSecrets.findings.reduce((s, f) => worst(s, f.sev), 'ok');
  return r;
}

function walk(dir, files = [], depth = 0) {
  if (depth > 6) return files;
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return files; }
  for (const e of ents) {
    if (['node_modules', '.git', '.next', 'dist', 'build', '.venv', 'venv', '__pycache__', '.netlify'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, files, depth + 1);
    else files.push(p);
  }
  return files;
}

function gitFiles(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean).map((f) => join(dir, f));
  } catch { return walk(dir); }
}

function repoSecretScan(dir) {
  const findings = [];
  let scanned = 0;
  for (const f of gitFiles(dir)) {
    let st; try { st = statSync(f); } catch { continue; }
    if (!st.isFile() || st.size > 1024 * 1024) continue;
    if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|mp[34]|wav|woff2?|ttf|otf|lock|gpg|pyc)$/i.test(f)) continue;
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    scanned++;
    const rel = relative(dir, f).replace(/\\/g, '/');
    for (const h of scanText(text, true)) findings.push({ ...h, file: rel });
    if (/(^|\/)\.env(\.[a-z]+)?$/.test(rel) && !/\.example$|\.sample$|\.template$/.test(rel) && /^[A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=\S{8,}/m.test(text)) {
      findings.push({ pattern: 'tracked-env-file-with-secret-like-values', sev: 'ng', file: rel });
    }
  }
  return { status: findings.reduce((s, x) => worst(s, x.sev), 'ok'), scanned, findings };
}

function npmAudit(pkgDir) {
  const hasLock = existsSync(join(pkgDir, 'package-lock.json')) || existsSync(join(pkgDir, 'npm-shrinkwrap.json'));
  if (!hasLock) {
    // generating a lockfile writes into the checkout; only do it on throwaway CI clones
    if (process.env.AUDIT_NO_GENERATE) return { status: 'skipped', reason: 'no-lockfile' };
    try {
      execFileSync(NPM, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: pkgDir, stdio: 'ignore', timeout: 240000, shell: SHELL });
    } catch { return { status: 'skipped', reason: 'lockfile-generation-failed' }; }
  }
  let out = '';
  try { out = execFileSync(NPM, ['audit', '--omit=dev', '--json', '--package-lock-only'], { cwd: pkgDir, shell: SHELL, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { out = e.stdout || ''; }
  let j; try { j = JSON.parse(out); } catch { return { status: 'skipped', reason: 'audit-unparseable' }; }
  if (j.error) return { status: 'skipped', reason: `audit-error:${String(j.error.code || j.error.summary || '').slice(0, 60)}` };
  const v = j.metadata?.vulnerabilities || {};
  const bad = Object.entries(j.vulnerabilities || {}).filter(([, x]) => ['critical', 'high'].includes(x.severity)).map(([k, x]) => `${x.severity}:${k}`);
  return { status: v.critical > 0 ? 'ng' : v.high > 0 ? 'warn' : 'ok', tool: 'npm', lockfile: hasLock ? 'committed' : 'generated', critical: v.critical || 0, high: v.high || 0, moderate: v.moderate || 0, packages: bad.slice(0, 30) };
}

function pipAudit(reqFile) {
  let out = '';
  try { out = execFileSync('pip-audit', ['-r', reqFile, '-f', 'json', '--progress-spinner', 'off'], { encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { out = e.stdout || ''; if (!out) return { status: 'skipped', reason: e.code === 'ENOENT' ? 'pip-audit-not-installed' : 'pip-audit-failed' }; }
  let j; try { j = JSON.parse(out); } catch { return { status: 'skipped', reason: 'pip-audit-unparseable' }; }
  const deps = Array.isArray(j) ? j : j.dependencies || [];
  const vulns = deps.filter((d) => (d.vulns || []).length).map((d) => `${d.name}:${d.vulns.map((x) => x.id).join('/')}`);
  // pip-audit has no severity; any known vuln is a warn to review (ng is reserved for npm critical)
  return { status: vulns.length ? 'warn' : 'ok', tool: 'pip-audit', vulnerable: vulns.length, packages: vulns.slice(0, 30) };
}

function repoDeps(dir) {
  const results = [];
  for (const f of gitFiles(dir)) {
    const name = basename(f);
    const rel = relative(dir, dirname(f)).replace(/\\/g, '/') || '.';
    if (rel.split('/').length > 3) continue;
    if (name === 'package.json') {
      let pj; try { pj = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
      if (!pj.dependencies && !pj.devDependencies) continue;
      results.push({ path: rel, ...npmAudit(dirname(f)) });
    } else if (name === 'requirements.txt') {
      results.push({ path: rel, ...pipAudit(f) });
    }
  }
  if (!results.length) return { status: 'ok', note: 'no-manifests', manifests: [] };
  return { status: results.reduce((s, r) => worst(s, r.status), 'ok'), manifests: results };
}

// Static discovery of AI-calling HTTP endpoints in a checked-out repo.
function discoverAiEndpoints(dir) {
  const eps = [];
  for (const f of gitFiles(dir)) {
    if (!/\.(m?js|cjs|ts|py)$/.test(f) || /test|spec|__tests__|scripts[\\/]/i.test(relative(dir, f))) continue;
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    if (!AI_SDK_RE.test(text)) continue;
    const rel = relative(dir, f).replace(/\\/g, '/');
    const hasAuthMarker = AUTH_MARKER_RE.test(text);
    const nf = rel.match(/netlify\/functions\/([^/]+?)(?:\/index)?\.(?:m?js|cjs|ts)$/);
    if (nf) eps.push({ path: `/.netlify/functions/${nf[1]}`, file: rel, staticAuthMarker: hasAuthMarker });
    for (const m of text.matchAll(/(?:app|router)\.(post|put)\(\s*['"`](\/[^'"`]*)['"`]/g)) {
      if (!m[2].includes(':')) eps.push({ path: m[2], method: m[1].toUpperCase(), file: rel, staticAuthMarker: hasAuthMarker });
    }
    for (const m of text.matchAll(/@(?:app|router)\.(post|put)\(\s*['"](\/[^'"]*)['"]/g)) {
      if (!m[2].includes('{')) eps.push({ path: m[2], method: m[1].toUpperCase(), file: rel, staticAuthMarker: hasAuthMarker });
    }
  }
  const seen = new Set();
  return eps.filter((e) => (seen.has(e.path) ? false : seen.add(e.path))).slice(0, 25);
}

async function probeEndpoint(origin, ep) {
  // Netlify background functions always answer 202 before the handler runs, so a live
  // probe says nothing about auth. Judge them statically only.
  if (/-background$/.test(ep.path) && ep.staticAuthMarker !== undefined) {
    return { path: ep.path, method: 'POST', http: null, sev: ep.staticAuthMarker ? 'ok' : 'warn', note: 'background-fn-static-only', file: ep.file, staticAuthMarker: ep.staticAuthMarker };
  }
  const res = await get(origin + ep.path, { method: ep.method || 'POST', headers: { 'content-type': ep.contentType || 'application/json' }, body: ep.body ?? '{}', redirect: 'manual' });
  const expect = ep.expect || [401, 403];
  let sev;
  if (res.status == null) sev = 'skipped';
  else if (expect.includes(res.status)) sev = 'ok';
  else if (res.status >= 200 && res.status < 300) sev = 'ng';
  else if ([400, 422].includes(res.status)) sev = ep.staticAuthMarker === false ? 'warn' : 'ok';
  else sev = 'ok'; // 404/405/429/3xx/5xx: not callable anonymously right now
  return { path: ep.path, method: ep.method || 'POST', http: res.status, sev, ...(ep.file ? { file: ep.file, staticAuthMarker: ep.staticAuthMarker } : {}) };
}

async function main() {
  const catalog = readJson(SYSTEMS_JSON);
  const live = (catalog.systems || []).filter((s) => s.status === 'live');

  // --- repos: secrets + deps + AI endpoint discovery ---
  const repos = {};
  for (const r of REPOS) {
    const dir = isAbsolute(r.dir) || r.dir === '.' || r.dir === 'config' ? r.dir : join(REPOS_DIR, r.dir);
    if (!existsSync(dir)) { repos[r.key] = { status: 'skipped', reason: 'not-checked-out' }; continue; }
    const secrets = repoSecretScan(dir);
    const deps = repoDeps(dir);
    const aiEndpoints = discoverAiEndpoints(dir);
    repos[r.key] = { status: worst(secrets.status, deps.status), secrets, deps, aiEndpoints };
  }

  // --- PC-side audit (ops-auto-repair, local repos only) ---
  let pcAudit = null;
  try {
    const st = readJson(join(MEM_DIR, 'ops-auto-repair-state.json'));
    const ageH = (Date.now() - new Date(st.lastAuditAt).getTime()) / 3600000;
    pcAudit = { at: st.lastAuditAt, fresh: ageH < 48, map: st.audit || {} };
  } catch {}

  // --- per system ---
  const originCache = new Map();
  const tlsCache = new Map();
  const probeCache = new Map(); // one probe per origin+path, even when several systems share a site
  const systems = {};
  await pool(live, 6, async (sys) => {
    const e = { checks: {} };
    let u = null;
    try { u = sys.url ? new URL(sys.url) : null; } catch {}
    const host = u?.hostname;
    const httpTarget = u && u.protocol === 'https:' && !PLATFORM_HOSTS.has(host) && host !== 'localhost' && host !== '127.0.0.1';

    if (httpTarget) {
      if (!tlsCache.has(host)) tlsCache.set(host, tlsCheck(host));
      e.checks.tls = await tlsCache.get(host);
      if (!originCache.has(u.origin)) originCache.set(u.origin, originChecks(u.origin));
      const oc = await originCache.get(u.origin);
      e.checks.exposure = oc.exposure;
      e.checks.publicSecrets = oc.publicSecrets;
    } else {
      const why = !u ? 'no-public-url' : PLATFORM_HOSTS.has(host) ? 'platform-managed-host' : 'not-https';
      e.checks.tls = { status: 'skipped', reason: why };
      e.checks.exposure = { status: 'skipped', reason: why };
      e.checks.publicSecrets = { status: 'skipped', reason: why };
    }

    const repoKeys = REPOS.filter((r) => r.match.test(String(sys.repo || '')) || r.match.test(String(sys._deploy_note || ''))).map((r) => r.key);
    const reachable = repoKeys.filter((k) => repos[k] && repos[k].status !== 'skipped' && repos[k].reason !== 'not-checked-out');
    e.repos = repoKeys;

    // ai-auth: endpoints discovered in this system's repo(s) + ledger securityProbes
    const eps = [];
    for (const k of reachable) eps.push(...(repos[k].aiEndpoints || []));
    for (const p of sys.securityProbes || []) eps.push(p);
    if (httpTarget && eps.length) {
      const results = [];
      for (const ep of eps.slice(0, 25)) {
        const ck = `${u.origin} ${ep.method || 'POST'} ${ep.path}`;
        if (!probeCache.has(ck)) probeCache.set(ck, probeEndpoint(u.origin, ep));
        results.push(await probeCache.get(ck));
      }
      e.checks.aiAuth = { status: results.reduce((s, r) => worst(s, r.sev), 'ok'), probes: results };
    } else {
      e.checks.aiAuth = { status: 'skipped', reason: !httpTarget ? 'no-public-https-url' : reachable.length ? 'no-ai-endpoints-found' : 'no-repo-access' };
      if (e.checks.aiAuth.reason === 'no-ai-endpoints-found') e.checks.aiAuth.status = 'ok';
    }

    // repo secrets + deps
    if (reachable.length) {
      e.checks.repoSecrets = { status: reachable.reduce((s, k) => worst(s, repos[k].secrets.status), 'ok'), source: 'cloud', repos: reachable };
      e.checks.deps = { status: reachable.reduce((s, k) => worst(s, repos[k].deps.status), 'ok'), source: 'cloud', repos: reachable };
    } else if (pcAudit && pcAudit.map[sys.id] && pcAudit.fresh) {
      const v = pcAudit.map[sys.id];
      e.checks.repoSecrets = { status: 'skipped', reason: 'no-cloud-repo-access' };
      e.checks.deps = v === 'clean' ? { status: 'ok', source: 'pc', at: pcAudit.at }
        : v === 'no-lockfile' || v === 'audit-error' ? { status: 'skipped', source: 'pc', reason: v, at: pcAudit.at }
        : { status: /critical/.test(v) ? 'ng' : 'warn', source: 'pc', at: pcAudit.at, packages: v.split(',').slice(0, 30) };
    } else {
      e.checks.repoSecrets = { status: 'skipped', reason: 'no-cloud-repo-access' };
      e.checks.deps = { status: 'skipped', reason: pcAudit && pcAudit.map[sys.id] && !pcAudit.fresh ? 'pc-audit-stale' : 'no-cloud-repo-access' };
    }

    e.status = Object.values(e.checks).reduce((s, c) => worst(s, c.status), 'ok');
    e.skipped = Object.entries(e.checks).filter(([, c]) => c.status === 'skipped').map(([k, c]) => `${k}:${c.reason}`);
    systems[sys.id] = e;
  });

  // repo-level findings that belong to no live system still count (e.g. a key committed to config)
  const summary = {};
  for (const name of ['tls', 'exposure', 'publicSecrets', 'aiAuth', 'repoSecrets', 'deps']) {
    summary[name] = { ok: 0, warn: 0, ng: 0, skipped: 0 };
    for (const e of Object.values(systems)) summary[name][e.checks[name].status]++;
  }
  const repoNg = Object.entries(repos).filter(([, r]) => r.status === 'ng').map(([k]) => k);
  const anyNg = Object.values(systems).some((e) => e.status === 'ng') || repoNg.length > 0;
  const anyWarn = Object.values(systems).some((e) => e.status === 'warn') || Object.values(repos).some((r) => r.status === 'warn');

  const result = {
    checked_at: jst(),
    checked_at_iso: now.toISOString(),
    overall: anyNg ? 'ng' : anyWarn ? 'warn' : 'ok',
    summary,
    repos,
    pcAudit: pcAudit ? { at: pcAudit.at, fresh: pcAudit.fresh } : null,
    systems,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n', 'utf8');

  // stdout: counts only (public log)
  console.log(`[security-daily] ${live.length} live systems, overall=${result.overall}`);
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(13)} ok=${v.ok} warn=${v.warn} ng=${v.ng} skipped=${v.skipped}`);
  const repoLine = Object.entries(repos).map(([k, r]) => `${k}=${r.status}`).join(' ');
  console.log(`  repos: ${repoLine}`);
  const ngCount = Object.values(systems).filter((e) => e.status === 'ng').length + repoNg.length;
  if (ngCount > 0) console.log(`SECURITY_ALERT=${ngCount}`);
}

main().catch((e) => {
  console.error('[security-daily] unexpected error (non-fatal):', String(e && e.message).slice(0, 200));
});
