#!/usr/bin/env node
// health-summary.mjs
//
// Daily (JST 8:00) health check for the 24h unmanned-ops loops running on
// GitHub Actions. Pure shell/node -- deliberately does NOT invoke Claude, to
// save tokens. Two data sources:
//   1. GitHub Actions run history for this repo (via REST API + GITHUB_TOKEN)
//      -> success/failure of each loop's most recent run in the last ~26h.
//   2. The ops-dashboard API (Netlify function on sales-research-tool) for
//      spend/revenue, if OPS_DASHBOARD_KEY is set.
//
// 2026-07-17 (owner rule, ~/.claude/CLAUDE.md "LINE通知ルール"): LINE is
// reserved for money-approval requests only. Health/progress summaries must
// NOT be pushed to LINE (a prior version of this script did, and it spammed
// the owner). Instead this writes a markdown ledger file that dashboard-sync
// picks up, per "ダッシュボード更新ルール" (dashboard is generated from
// ledger files, never hand-edited). Never touches money.
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const REPO = process.env.GITHUB_REPOSITORY || 'yusuken10121990-hub/ai-ops-orchestrator';
const GH_TOKEN = process.env.GITHUB_TOKEN;
const OPS_DASHBOARD_KEY = process.env.OPS_DASHBOARD_KEY;
const NETLIFY_AUTH_TOKEN = process.env.NETLIFY_AUTH_TOKEN;
const OUTPUT_FILE = process.env.OUTPUT_FILE; // required: path to write the ledger markdown to

// { display name, actual .github/workflows/<file>.yml filename (they differ
// for team-learning-loop: file is team-learning.yml but workflow `name:` is
// team-learning-loop) }
const LOOPS = [
  { name: 'team-learning-loop', file: 'team-learning' },
  { name: 'ad-lp-daily-learning', file: 'ad-lp-daily-learning' },
  { name: 'ad-lp-apply-daily', file: 'ad-lp-apply-daily' },
  { name: 'research-team-learning', file: 'research-team-learning' },
  { name: 'seo-daily', file: 'seo-daily' },
  { name: 'ad-pdca-daily', file: 'ad-pdca-daily' },
];

async function ghApi(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}`);
  return res.json();
}

function jstNow() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

async function loopStatus(loop) {
  try {
    const data = await ghApi(
      `/repos/${REPO}/actions/workflows/${loop.file}.yml/runs?per_page=3`
    );
    const runs = data.workflow_runs || [];
    if (runs.length === 0) return { name: loop.name, status: '⚪ 実行履歴なし' };
    const latest = runs[0];
    const ranAgoH = (Date.now() - new Date(latest.run_started_at).getTime()) / 3600000;
    const staleFlag = ranAgoH > 26 ? '（26h以上前 ⚠️停止疑い）' : '';
    let mark = '⚪';
    if (latest.status === 'completed') {
      mark = latest.conclusion === 'success' ? '✅' : '❌';
    } else {
      mark = '🔄';
    }
    return {
      name: loop.name,
      status: `${mark} ${latest.conclusion || latest.status}${staleFlag}`,
      url: latest.html_url,
    };
  } catch (e) {
    return { name: loop.name, status: `⚠️ 取得失敗(${e.message})` };
  }
}

async function fetchOpsDashboard() {
  if (!OPS_DASHBOARD_KEY) return null;
  try {
    const res = await fetch(
      `https://research.zerosys.jp/api/ops-dashboard-data?k=${encodeURIComponent(OPS_DASHBOARD_KEY)}`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

function fmtYen(n) {
  if (n === undefined || n === null || Number.isNaN(n)) return '?';
  return Math.round(n).toLocaleString('ja-JP');
}

// 2026-07-20 P1対策(Netlify全サイト503・原因=production deploy 266回/12日で
// Pro枠3,000クレジットを枯渇ペース)。日次で残クレジットと消費ペースを見て、
// 期末までに危険水準(80%)を超えそうなら早期警告する。account.capabilities.credits
// (used/included)とcurrent_billing_period_start/next_billing_period_startを使う
// (netlify api listAccountsForUserで実測確認済み。専用のusage APIは無いためaccount
// オブジェクトから算出する)。金銭操作はしない(読み取りのみ)。
async function fetchNetlifyCredits() {
  if (!NETLIFY_AUTH_TOKEN) return null;
  try {
    const res = await fetch('https://api.netlify.com/api/v1/accounts', {
      headers: { Authorization: `Bearer ${NETLIFY_AUTH_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const accounts = await res.json();
    const a = Array.isArray(accounts) ? accounts[0] : null;
    if (!a) return { error: 'no-account-returned' };
    const used = a.capabilities?.credits?.used;
    const included = a.capabilities?.credits?.included ?? a.plan_credits;
    const periodStart = a.current_billing_period_start ? new Date(a.current_billing_period_start) : null;
    const periodEnd = a.next_billing_period_start ? new Date(a.next_billing_period_start) : null;
    if (typeof used !== 'number' || typeof included !== 'number' || !periodStart || !periodEnd) {
      return { error: 'missing-fields-in-account-response' };
    }
    const now = new Date();
    const elapsedDays = Math.max(0.1, (now - periodStart) / 86400000);
    const remainingDays = Math.max(0, (periodEnd - now) / 86400000);
    const pacePerDay = used / elapsedDays;
    const projectedTotal = used + pacePerDay * remainingDays;
    const projectedPct = included > 0 ? (projectedTotal / included) * 100 : null;
    return {
      used,
      included,
      periodStart,
      periodEnd,
      pacePerDay,
      projectedTotal,
      projectedPct,
      warn: projectedPct !== null && projectedPct >= 80,
    };
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  if (!OUTPUT_FILE) {
    console.error('ERROR: OUTPUT_FILE env var not set (path to write the ledger markdown to)');
    process.exitCode = 1;
    return;
  }

  const statuses = [];
  for (const loop of LOOPS) {
    statuses.push(await loopStatus(loop));
    await sleep(200); // be gentle on GitHub API rate limit
  }

  const ops = await fetchOpsDashboard();

  const lines = [];
  lines.push(`# 24h無人運用 ヘルスサマリ`);
  lines.push('');
  lines.push(`最終更新: ${jstNow()} JST（毎朝8:00自動更新・ダッシュボードのソース）`);
  lines.push('');
  lines.push('## 学習/運用ループ稼働状況');
  for (const s of statuses) {
    lines.push(`- ${s.name}: ${s.status}${s.url ? ` ([run](${s.url}))` : ''}`);
  }
  lines.push('');
  if (ops && !ops.error) {
    lines.push('## 実績(ops-dashboard, ZEROSYSリサーチMeta広告 + Stripe全社)');
    try {
      // Shape matches netlify/functions/ops-dashboard-data.js in sales-research-tool:
      //   { meta: { campaignToday, campaignMax, ads: [...] } | { error },
      //     stripe: { today: {total:{count,totalYen}}, all: {...} } | { error } }
      if (ops.meta && !ops.meta.error) {
        const t = ops.meta.campaignToday || {};
        lines.push(`- 本日Meta広告費: ¥${fmtYen(t.spend)} / クリック${t.clicks ?? '?'} / 購入${t.purchases ?? '?'}件`);
      } else if (ops.meta?.error) {
        lines.push(`- Meta広告データ取得失敗: ${ops.meta.error}`);
      }
      if (ops.stripe && !ops.stripe.error) {
        const today = ops.stripe.today?.total || {};
        const all = ops.stripe.all?.total || {};
        lines.push(`- 本日Stripe売上(全社): ¥${fmtYen(today.totalYen)}（${today.count ?? '?'}件）`);
        lines.push(`- 累計Stripe売上(全社): ¥${fmtYen(all.totalYen)}（${all.count ?? '?'}件）`);
      } else if (ops.stripe?.error) {
        lines.push(`- Stripe売上取得失敗: ${ops.stripe.error}`);
      }
    } catch {
      lines.push('- 集計整形に失敗(生データはActionsログ参照)');
    }
  } else if (ops && ops.error) {
    lines.push(`## 実績: ops-dashboard取得失敗 (${ops.error})`);
  } else {
    lines.push('## 実績: OPS_DASHBOARD_KEY未設定のためスキップ');
  }
  lines.push('');

  const credits = await fetchNetlifyCredits();
  lines.push('## Netlifyクレジット消費状況(Pro枠・2026-07-20 P1対策で新設)');
  if (!NETLIFY_AUTH_TOKEN) {
    lines.push('- NETLIFY_AUTH_TOKEN未設定のためスキップ');
  } else if (credits?.error) {
    lines.push(`- 取得失敗: ${credits.error}`);
  } else if (credits) {
    const pctUsed = credits.included > 0 ? ((credits.used / credits.included) * 100).toFixed(1) : '?';
    const fmtDate = (d) => d.toISOString().slice(0, 10);
    lines.push(`- 当期間: ${fmtDate(credits.periodStart)} 〜 ${fmtDate(credits.periodEnd)}`);
    lines.push(`- 使用済み: ${Math.round(credits.used).toLocaleString('ja-JP')} / ${credits.included.toLocaleString('ja-JP')} クレジット (${pctUsed}%)`);
    lines.push(
      `- 消費ペース: ${credits.pacePerDay.toFixed(1)}/日 → 期末予測 ${Math.round(credits.projectedTotal).toLocaleString('ja-JP')} (${credits.projectedPct.toFixed(0)}%)`
    );
    if (credits.warn) {
      lines.push(
        `- ⚠️ 枯渇警告: このペースだと期末までにplan枠(${credits.included.toLocaleString('ja-JP')})の80%超を消費する見込み。dashboard-sync等のproduction deploy頻度を確認してください。`
      );
    } else {
      lines.push('- 正常ペース(期末予測80%未満)');
    }
  }
  lines.push('');
  lines.push('_このファイルは health-summary workflow (毎朝8:00 JST) が自動生成。手で編集しない。_');

  const content = lines.join('\n') + '\n';

  console.log('---- summary ----');
  console.log(content);
  console.log('------------------');

  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, content, 'utf8');
  console.log(`Written to ${OUTPUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
