#!/usr/bin/env node
/**
 * business-os-freshness.mjs — Business OS が「静かに止まっていないか」を監視する
 *
 * workflowが失敗したときはIssueが立つので気づける。
 * 本当に危ないのは **一度も起動しなくなる** 場合（cron停止・repo権限切れ・
 * ロックが返らず全部LOCK_HELDで即死、など）。この場合エラーが1件も出ないまま
 * AI CEOだけが沈黙する。ここがその検知。
 *
 * 判定は last-run.json の finished_at の鮮度。日次なので26時間を超えたら異常。
 * 検知したらGitHub Issueを1本立てる（同じ日に何度も立てない）。
 *
 * 実行（system-health-cloud から30分毎に呼ばれる）:
 *   CONFIG_DIR=config node scripts/business-os-freshness.mjs
 */
import fs from 'fs';
import path from 'path';

const CONFIG_DIR = process.env.CONFIG_DIR || 'config';
const BOS = path.join(CONFIG_DIR, 'memory', 'business-os');
const LAST_RUN = path.join(BOS, 'last-run.json');
const LOCK = path.join(BOS, 'run-lock.json');
const STATE = path.join(BOS, 'freshness-state.json');

const MAX_AGE_H = Number(process.env.BOS_MAX_AGE_HOURS || 26);
const REPO = process.env.ALERT_REPO || process.env.GITHUB_REPOSITORY
  || 'yusuken10121990-hub/ai-ops-orchestrator';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

const J = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fb; } };
const W = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); };
const jstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

async function openIssue(title, body) {
  if (!TOKEN) { console.error('GITHUB_TOKEN が無いためIssueを立てられない'); return null; }
  const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, labels: ['business-os', 'alert', 'incident'] }),
  });
  if (!res.ok) { console.error(`Issue作成失敗: HTTP ${res.status}`); return null; }
  return (await res.json()).html_url;
}

const last = J(LAST_RUN, null);
const lock = J(LOCK, null);
const state = J(STATE, { last_alert_day: null });

if (!last?.finished_at) {
  console.log('[bos-freshness] last-run.json が読めない -> UNKNOWN（Issueは立てない）');
  process.exit(0);
}

const ageH = (Date.now() - Date.parse(last.finished_at)) / 3600000;
const stale = ageH > MAX_AGE_H;
// ロックが返っていない状態が長く続くと、以後の全実行が LOCK_HELD で死ぬ
const lockStuck = lock && !lock.released_at
  && (Date.now() - Date.parse(lock.acquired_at)) / 3600000 > 2;

console.log(`[bos-freshness] cycle=${last.cycle_id} runner=${last.runner ?? 'unknown'} `
  + `経過=${ageH.toFixed(1)}h 閾値=${MAX_AGE_H}h stale=${stale} lock_stuck=${!!lockStuck}`);

if (!stale && !lockStuck) process.exit(0);

// 1日1回まで。壊れている間ずっとIssueを量産しない。
if (state.last_alert_day === jstDay()) {
  console.log('[bos-freshness] 本日は通報済みのため重複起票しない');
  process.exit(0);
}

const reasons = [];
if (stale) reasons.push(`最終実行から ${ageH.toFixed(1)} 時間経過（閾値 ${MAX_AGE_H}h）。日次のはずが動いていない`);
if (lockStuck) reasons.push(`run-lock.json が ${lock.runner}(${lock.host}) の名前で解放されていない。`
  + ' 以後の実行が LOCK_HELD で全て停止する恐れがある');

const url = await openIssue(
  `[Business OS 停止疑い] 最終実行から ${ageH.toFixed(0)} 時間`,
  [
    '**AI Business OS が動いていない可能性がある。**',
    '',
    ...reasons.map((r) => `- ${r}`),
    '',
    `- 最後に成功したCycle: \`${last.cycle_id}\`（${last.finished_at}）`,
    `- 実行主体: ${last.runner ?? 'unknown'}`,
    `- halted: ${last.halted ? JSON.stringify(last.halted) : 'null'}`,
    '',
    '確認する順:',
    '1. Actions の business-os-daily が起動しているか（cron停止・repo無効化）',
    '2. 直近runのログでどのstepで落ちたか',
    '3. `node scripts/run-guard.mjs` でロックの保持者を見る。固まっていれば release',
    '',
    '---',
    'system-health-cloud が30分毎に鮮度を見て自動起票した。',
  ].join('\n'));

W(STATE, { last_alert_day: jstDay(), age_hours: Number(ageH.toFixed(1)),
  reasons, issue: url, checked_at: new Date().toISOString() });
console.log(`[bos-freshness] 通報した: ${url ?? '(Issue作成失敗)'}`);
