#!/usr/bin/env node
// health-summary.mjs
//
// Daily (JST 8:00) health check for the 24h unmanned-ops loops running on
// GitHub Actions. Pure shell/node -- deliberately does NOT invoke Claude, to
// save tokens (per task instruction). Two data sources:
//   1. GitHub Actions run history for this repo (via REST API + GITHUB_TOKEN)
//      -> success/failure of each loop's most recent run in the last ~26h.
//   2. The ops-dashboard API (Netlify function on sales-research-tool) for
//      spend/revenue, if OPS_DASHBOARD_KEY is set.
// Sends one summary LINE push message. Never touches money.
import { setTimeout as sleep } from 'node:timers/promises';

const REPO = process.env.GITHUB_REPOSITORY || 'yusuken10121990-hub/ai-ops-orchestrator';
const GH_TOKEN = process.env.GITHUB_TOKEN;
const LINE_TOKEN = process.env.LINE_CHANNEL_TOKEN;
const LINE_USER_ID = process.env.LINE_USER_ID;
const OPS_DASHBOARD_KEY = process.env.OPS_DASHBOARD_KEY;

const LOOPS = [
  'team-learning-loop',
  'ad-lp-daily-learning',
  'ad-lp-apply-daily',
  'research-team-learning',
  'seo-daily',
  'ad-pdca-daily',
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

async function loopStatus(workflowFile) {
  try {
    const data = await ghApi(
      `/repos/${REPO}/actions/workflows/${workflowFile}.yml/runs?per_page=3`
    );
    const runs = data.workflow_runs || [];
    if (runs.length === 0) return { name: workflowFile, status: '⚪ 実行履歴なし' };
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
      name: workflowFile,
      status: `${mark} ${latest.conclusion || latest.status}${staleFlag}`,
      url: latest.html_url,
    };
  } catch (e) {
    return { name: workflowFile, status: `⚠️ 取得失敗(${e.message})` };
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

async function main() {
  const statuses = [];
  for (const loop of LOOPS) {
    statuses.push(await loopStatus(loop));
    await sleep(200); // be gentle on GitHub API rate limit
  }

  const ops = await fetchOpsDashboard();

  const lines = [];
  lines.push(`[24h無人運用 朝サマリ] ${jstNow()} JST`);
  lines.push('');
  lines.push('■ 学習/運用ループ稼働状況');
  for (const s of statuses) {
    lines.push(`- ${s.name}: ${s.status}`);
  }
  lines.push('');
  if (ops && !ops.error) {
    lines.push('■ 実績(ops-dashboard, ZEROSYSリサーチMeta広告 + Stripe全社)');
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
    lines.push(`■ 実績: ops-dashboard取得失敗 (${ops.error})`);
  } else {
    lines.push('■ 実績: OPS_DASHBOARD_KEY未設定のためスキップ');
  }

  const message = lines.join('\n').slice(0, 4900); // LINE push text limit ~5000 chars

  console.log('---- summary ----');
  console.log(message);
  console.log('------------------');

  if (!LINE_TOKEN || !LINE_USER_ID) {
    console.log('LINE secrets not set, skipping push.');
    return;
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to: LINE_USER_ID, messages: [{ type: 'text', text: message }] }),
  });
  if (!res.ok) {
    console.error(`LINE push failed: HTTP ${res.status} ${await res.text()}`);
    process.exitCode = 1;
  } else {
    console.log('LINE push sent.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
