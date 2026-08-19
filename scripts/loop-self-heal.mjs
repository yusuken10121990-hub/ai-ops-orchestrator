#!/usr/bin/env node
// loop-self-heal.mjs
//
// 「Claudeの利用上限で落ちた日次/週次ループを、上限が戻ったあと自動で取り戻す」
// 決定論スクリプト（LLMは使わない。automation-health-check.mjs / health-check.mjs と同方針）。
//
// ── なぜ必要か（2026-08-19 実測。推測ではない） ───────────────────────────────
//   2026-08-18〜19、週次トークン上限により run-loop.sh 系のループが軒並み25〜40秒で
//   即死した。ad-pdca-daily(32208326341) のログ:
//       auth mode: oauth
//       You've hit your weekly limit · resets 5am (UTC)
//       ##[error]Process completed with exit code 1.
//   上限は 05:00 UTC にリセットされ、*/5 のループ(creative-studio-apply-runner)は
//   05:05Z に自力で復活した。しかし **日次ループのcronは JST早朝に1回しか無い** ため、
//   ad-pdca-daily / zerosys-ad-pdca / zerosys-transport-ads-daily-pdca は
//   「上限が戻っているのに翌朝まで1日分まるごと失われる」状態になった。
//   同じ事故は 2026-08-04〜05 にも起きている（automation-health-check.mjs の
//   ヘッダコメントに「8/4-8/5にClaude週次上限で2日連続failure」と記録済み）。
//   = 同一Root Causeの再発。監視(automation-health-check)は通知するだけで復旧しない。
//   このスクリプトが「通知」ではなく「復旧」を担当する。
//
// ── 安全設計（safe-remediate.sh と同じ思想: モデルに実行権限を渡さない） ─────────
//   * できることは1つだけ: 既存workflowの workflow_dispatch 再実行。
//     予算変更・デプロイ・削除・課金は **このスクリプトに実装が存在しない**。
//   * 対象は .github/workflows/*.yml から自動発見するが、
//     「run-loop.sh を使う」かつ「1日1回以下のcron」かつ「workflow_dispatch を持つ」
//     ものだけ。*/5 系(creative-studio-apply-runner / jobqueue-runner)は自力で復活する上、
//     SKILL.md に2026-07-19の二重投入事故が記録されているため構造的に対象外になる。
//   * FAIL-CLOSED: 「今日ちゃんと動いたか」を判定できなかったループは再実行しない
//     （UNKNOWNを「動いていない」と決めつけて二重実行するより、1日待つ方が安全）。
//   * 1ループにつき1判定窓あたり最大 MAX_DISPATCH_PER_WINDOW 回まで。
//     オーナーの手動再実行も同じ枠を消費する（既に人が回したならAIは重ねない）。
//   * 上限がまだ切れている間は再実行しない（無駄撃ち防止）。判定は課金ゼロの
//     「*/5ループの直近runに SKIPPED注釈が付いているか」で行う（下記 quota probe）。
//
// ── 「今日ちゃんと動いたか」の判定（成功コード=成功ではない） ──────────────────
//   run-loop.sh は利用上限で終わったとき exit 0（SKIPPED）で終わるので、
//   conclusion=success だけを見ると「動いた」と誤判定する。
//   そこで run-loop.sh が出す GitHub Actions 注釈
//       ::notice title=SKIPPED (Claude usage limit)::<loop>: <検出行>
//   を check-runs annotations API で読み、注釈付きのsuccessは「実質未実行」と数える。
//   business-os-daily のように continue-on-error でAI失敗が緑に見えるケースも
//   これで正しく「未実行」と判定できる（実測: run 32206377773 は緑だがAIは5秒で上限死）。
//
// 出力: OUTPUT_JSON（既定 config/memory/loop-self-heal-status.json）。台帳。
// 終了コードは常に0（監視・復旧スクリプト自体の失敗でworkflowを落とすと台帳が飛ぶため。
// 異常はstatusフィールドとGitHub Issueで表現する。automation-health-check.mjs と同じ規約）。
//
// Usage:
//   node scripts/loop-self-heal.mjs [--dry-run]
// Env:
//   GITHUB_TOKEN            必須。workflow_dispatch のため actions:write が要る。
//   SELF_HEAL_TOKEN         任意。指定時はこちらを優先（PATを使いたい場合）。
//   GITHUB_REPOSITORY       既定 yusuken10121990-hub/ai-ops-orchestrator
//   WORKFLOWS_DIR           既定 .github/workflows
//   OUTPUT_JSON             既定 config/memory/loop-self-heal-status.json
//   GRACE_MINUTES           既定 90（cron予定時刻からこれだけ待ってから復旧を検討）
//   MAX_DISPATCH_PER_WINDOW 既定 2
//   DRY_RUN=1               再実行せず判定だけ行う（--dry-run と同じ）

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

const TOKEN = process.env.SELF_HEAL_TOKEN || process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY || 'yusuken10121990-hub/ai-ops-orchestrator';
const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR || '.github/workflows';
const OUTPUT_JSON = process.env.OUTPUT_JSON || 'config/memory/loop-self-heal-status.json';
const GRACE_MINUTES = Number(process.env.GRACE_MINUTES || 90);
const MAX_DISPATCH_PER_WINDOW = Number(process.env.MAX_DISPATCH_PER_WINDOW || 2);
// 2026-08-19 本番dry-runで判明: 上限に2日当たった直後は復旧対象が16本同時に立つ。
// これを1tickで全部撃つと、戻ったばかりの週次トークンを復旧作業自体が焼き切り、
// 「上限で止まる→復旧で上限に当たる」の自家中毒になる。毎時走るので、1tick数本ずつ
// 古い取りこぼしから順に返す（16本なら約6時間で回収し、スパイクを作らない）。
const MAX_DISPATCH_PER_TICK = Number(process.env.MAX_DISPATCH_PER_TICK || 3);
const DRY_RUN = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');

// run-loop.sh が SKIPPED 時に出す注釈のタイトル。両者を変えるときは必ず一緒に変えること
// （文字列が食い違うと「上限で未実行」を「実行済み」と誤判定し、復旧が静かに止まる）。
export const SKIP_ANNOTATION_TITLE = 'SKIPPED (Claude usage limit)';

// 上限が今も切れているかを課金ゼロで判定するためのプローブ。*/5 で回っている
// run-loop.sh 系ループを使う（専用にclaudeを叩くとトークンを消費してしまうため）。
const QUOTA_PROBE_WORKFLOW = process.env.QUOTA_PROBE_WORKFLOW || 'creative-studio-apply-runner.yml';
// 2026-08-19 本番実測で修正: */5 のcronでもGitHub側の間引きで実際には20〜40分空く
// （8/18-19の実測で 20/22/25/39分間隔）。25分だとプローブがほぼ常に probe-stale で
// UNKNOWNになり、上限中でも無駄撃ちしてしまう。実測レンジを覆う60分にする。
const QUOTA_PROBE_MAX_AGE_MIN = Number(process.env.QUOTA_PROBE_MAX_AGE_MIN || 60);

const ISSUE_LABEL = 'loop-self-heal';

// ───────────────────────────────────────────────────────────── GitHub API

async function ghApi(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub API ${init.method || 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// ───────────────────────────────────────────────────────── cron / 時刻計算

/**
 * 5フィールドcronを分類する。
 * 復旧対象にするのは「1日1回」または「週1回」の固定時刻だけ。
 * 複数時刻(0,3,6,...)・N分毎・月次は、取りこぼしても次の発火が近い or 復旧の
 * 妥当な判定窓が作れないため対象外にする。
 */
export function classifyCron(cron) {
  if (typeof cron !== 'string') return { kind: 'unsupported', reason: 'not-a-string' };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { kind: 'unsupported', reason: 'not-5-fields' };
  const [min, hour, dom, mon, dow] = parts;
  if (!/^\d+$/.test(min)) return { kind: 'unsupported', reason: 'minute-not-fixed' };
  if (!/^\d+$/.test(hour)) return { kind: 'unsupported', reason: 'hour-not-fixed' };
  if (mon !== '*') return { kind: 'unsupported', reason: 'month-restricted' };
  if (dom !== '*') return { kind: 'unsupported', reason: 'day-of-month-restricted' };
  if (dow === '*') return { kind: 'daily', minute: +min, hour: +hour };
  if (/^\d+$/.test(dow)) return { kind: 'weekly', minute: +min, hour: +hour, dow: +dow % 7 };
  return { kind: 'unsupported', reason: 'day-of-week-not-fixed' };
}

/** cron(UTC)の「直近の予定時刻」をUTCのDateで返す。now以前で最も新しいもの。 */
export function lastScheduledOccurrence(cls, now) {
  const d = new Date(now.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCHours(cls.hour, cls.minute);
  if (cls.kind === 'daily') {
    if (d.getTime() > now.getTime()) d.setUTCDate(d.getUTCDate() - 1);
    return d;
  }
  // weekly: 同じ曜日まで最大7日戻す
  for (let i = 0; i < 8; i++) {
    if (d.getUTCDay() === cls.dow && d.getTime() <= now.getTime()) return d;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return null;
}

// ────────────────────────────────────────────────── workflow の自動発見

/**
 * .github/workflows/*.yml を読み、復旧対象になりうるループを列挙する。
 * ハードコードした一覧を持たないので、ループを1本足しても勝手に保護対象に入る
 * （2026-08-05の「ローカル→クラウド移行でcriticalマークが失われた」型の抜けを防ぐ）。
 */
export function discoverLoops(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const file = join(dir, name);
    const text = readFileSync(file, 'utf8');
    const id = name.replace(/\.ya?ml$/, '');
    const usesRunLoop = /run-loop\.sh/.test(text);
    const hasDispatch = /^\s*workflow_dispatch\s*:/m.test(text);
    const crons = [...text.matchAll(/^\s*-\s*cron:\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    const classified = crons.map(classifyCron);
    const recoverable = classified.filter((c) => c.kind === 'daily' || c.kind === 'weekly');

    let skipReason = null;
    if (!usesRunLoop) skipReason = 'no-claude-loop';        // Claudeを使わない=上限の影響を受けない
    else if (crons.length === 0) skipReason = 'no-schedule'; // 手動専用
    else if (recoverable.length === 0) skipReason = 'high-frequency-or-unsupported-cron'; // */5 等は自力復活
    else if (recoverable.length !== crons.length) skipReason = 'mixed-schedule';
    else if (!hasDispatch) skipReason = 'no-workflow_dispatch';

    out.push({ id, workflowFile: name, usesRunLoop, hasDispatch, crons, schedule: recoverable[0] || null, skipReason });
  }
  return out;
}

// ───────────────────────────────────────────────── 「実際に動いたか」の判定

/**
 * run が「実質未実行(上限でSKIPPED)」かどうかを注釈から判定する。
 * 戻り値: true=SKIPPED / false=本当に動いた / null=判定不能(FAIL-CLOSED用)
 */
async function isUsageLimitSkipped(runId) {
  let jobs;
  try {
    jobs = await ghApi(`/repos/${REPO}/actions/runs/${runId}/jobs?per_page=30`);
  } catch {
    return null;
  }
  let sawAny = false;
  for (const job of jobs?.jobs || []) {
    try {
      // GitHub Actions では job.id がそのまま check_run_id。
      const anns = await ghApi(`/repos/${REPO}/check-runs/${job.id}/annotations?per_page=50`);
      sawAny = true;
      for (const a of anns || []) {
        const hay = `${a.title || ''} ${a.message || ''}`;
        if (hay.includes(SKIP_ANNOTATION_TITLE)) return true;
      }
    } catch {
      return null; // 注釈が読めない = 判定不能。推測しない。
    }
  }
  return sawAny ? false : null;
}

/**
 * 判定窓(since以降)のrunを見て、ループの状態を決める。
 *   ok            … 上限SKIPでない成功runがあった = 今回の窓は消化済み
 *   running       … 実行中/待機中のrunがある
 *   needs-recovery… 成功runが無い or 全部が上限SKIP
 *   unverifiable  … 注釈が読めず判定不能（FAIL-CLOSED: 再実行しない）
 */
export function decideState(runs, skipFlags) {
  if (runs.some((r) => r.status !== 'completed')) return 'running';
  const successes = runs.filter((r) => r.conclusion === 'success');
  if (successes.some((r) => skipFlags.get(r.id) === false)) return 'ok';
  if (successes.some((r) => skipFlags.get(r.id) === null)) return 'unverifiable';
  return 'needs-recovery';
}

// ─────────────────────────────────────────────────────── quota probe

/**
 * 「今も上限が切れているか」を課金ゼロで判定する。
 * 5分毎で回る run-loop.sh 系ループの直近runにSKIPPED注釈があれば、上限はまだ切れている。
 * 戻り値 { limited: true|false|null, reason }（null = 判定不能）
 */
async function probeQuota() {
  let runs;
  try {
    runs = await ghApi(`/repos/${REPO}/actions/workflows/${QUOTA_PROBE_WORKFLOW}/runs?per_page=5&status=completed`);
  } catch (e) {
    return { limited: null, reason: `probe-api-error: ${e.message}` };
  }
  const latest = (runs?.workflow_runs || [])[0];
  if (!latest) return { limited: null, reason: 'probe-no-runs' };
  const ageMin = (Date.now() - Date.parse(latest.updated_at || latest.created_at)) / 60000;
  if (!Number.isFinite(ageMin) || ageMin > QUOTA_PROBE_MAX_AGE_MIN) {
    return { limited: null, reason: `probe-stale (${Math.round(ageMin)}min > ${QUOTA_PROBE_MAX_AGE_MIN})` };
  }
  if (latest.conclusion !== 'success') {
    return { limited: null, reason: `probe-run-not-success (${latest.conclusion})` };
  }
  const skipped = await isUsageLimitSkipped(latest.id);
  if (skipped === null) return { limited: null, reason: 'probe-annotations-unreadable' };
  return { limited: skipped, reason: skipped ? 'usage-limit-still-active' : 'quota-available' };
}

// ─────────────────────────────────────────────────────── Issue 起票/クローズ

async function upsertIssue(title, body, shouldBeOpen) {
  try {
    const list = await ghApi(`/repos/${REPO}/issues?state=open&per_page=50&labels=${ISSUE_LABEL}`);
    const existing = (Array.isArray(list) ? list : []).find((i) => i.title === title);
    if (shouldBeOpen && !existing) {
      await ghApi(`/repos/${REPO}/issues`, {
        method: 'POST',
        body: JSON.stringify({ title, body, labels: [ISSUE_LABEL, 'alert'] }),
      });
      console.log(`[loop-self-heal] opened issue: ${title}`);
    } else if (!shouldBeOpen && existing) {
      await ghApi(`/repos/${REPO}/issues/${existing.number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: '自動復旧を確認したためクローズします。' }),
      });
      await ghApi(`/repos/${REPO}/issues/${existing.number}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed' }),
      });
      console.log(`[loop-self-heal] closed recovered issue #${existing.number}`);
    }
  } catch (e) {
    console.log(`[loop-self-heal] issue upsert failed (non-fatal): ${e.message}`);
  }
}


// 事業のPDCAそのものを回すループ。1tickの枠が埋まるとき、学習系より先に返す。
// （2026-08-19 本番実測: 古い順だけで並べたら research-team-learning / rivet-* が
//  先に入り、ad-pdca-daily と zerosys-* が次tickへ回った。取りこぼしの古さより
//  事業影響の大きさを優先する。automation-health-check.mjs の critical と同じ考え方。）
export const BUSINESS_CRITICAL_LOOPS = new Set([
  'business-os-daily', 'ad-pdca-daily', 'zerosys-ad-pdca', 'zerosys-transport-ads-daily-pdca',
  'ad-lp-apply-daily', 'qa-daily', 'service-assurance-daily',
]);

/**
 * 再実行するループを選ぶ。事業クリティカル優先 → 取りこぼしが古い順 → cap 本だけ。
 * 復旧作業そのものが週次上限を焼き切らないための安全弁なので、純粋関数にして
 * 回帰テストで固定する（loop-self-heal-e2e.mjs）。
 */
export function selectForDispatch(eligible, cap) {
  const tier = (l) => (BUSINESS_CRITICAL_LOOPS.has(l.id) ? 0 : 1);
  const sorted = [...eligible].sort((a, b) =>
    tier(a) - tier(b) || (b._missedForMinutes ?? 0) - (a._missedForMinutes ?? 0));
  return { dispatch: sorted.slice(0, cap), deferred: sorted.slice(cap) };
}

// ──────────────────────────────────────────────────────────────── main

async function main() {
  const now = new Date();
  const generatedAt = now.toISOString();

  if (!TOKEN) {
    console.error('[loop-self-heal] GITHUB_TOKEN / SELF_HEAL_TOKEN が無いため判定できません（FAIL-CLOSED: 何もしない）');
    writeStatus({ generatedAt, status: 'VALIDATION_UNAVAILABLE', reason: 'no-token', loops: [] });
    return;
  }

  const discovered = discoverLoops(WORKFLOWS_DIR);
  const targets = discovered.filter((d) => !d.skipReason);
  console.log(`[loop-self-heal] workflows=${discovered.length} 復旧対象=${targets.length}`);

  const quota = await probeQuota();
  console.log(`[loop-self-heal] quota probe: limited=${quota.limited} (${quota.reason})`);

  const loops = [];
  let dispatched = 0;
  let stuck = 0;

  for (const t of targets) {
    const since = lastScheduledOccurrence(t.schedule, now);
    const entry = {
      id: t.id,
      workflowFile: t.workflowFile,
      cron: t.crons[0],
      kind: t.schedule.kind,
      windowStart: since ? since.toISOString() : null,
      state: 'unknown',
      action: 'none',
      dispatchesInWindow: 0,
    };

    if (!since) {
      entry.state = 'unverifiable';
      entry.action = 'hold-unverifiable';
      entry.detail = 'cron予定時刻を算出できなかった';
      loops.push(entry);
      continue;
    }

    const minutesSinceSlot = (now.getTime() - since.getTime()) / 60000;
    let runs = [];
    try {
      const data = await ghApi(
        `/repos/${REPO}/actions/workflows/${t.workflowFile}/runs?per_page=20&created=%3E%3D${since.toISOString().slice(0, 19)}Z`,
      );
      runs = (data?.workflow_runs || []).filter((r) => Date.parse(r.created_at) >= since.getTime());
    } catch (e) {
      entry.state = 'unverifiable';
      entry.action = 'hold-unverifiable';
      entry.detail = `runs取得失敗: ${e.message}`;
      loops.push(entry);
      continue;
    }

    entry.runsInWindow = runs.length;
    entry.dispatchesInWindow = runs.filter((r) => r.event === 'workflow_dispatch').length;

    const skipFlags = new Map();
    for (const r of runs.filter((r) => r.conclusion === 'success')) {
      skipFlags.set(r.id, await isUsageLimitSkipped(r.id));
    }
    entry.skippedByUsageLimit = [...skipFlags.values()].filter((v) => v === true).length;
    entry.state = decideState(runs, skipFlags);

    if (entry.state === 'ok' || entry.state === 'running') {
      entry.action = 'none';
    } else if (entry.state === 'unverifiable') {
      // FAIL-CLOSED。二重実行より1日待つ方を選ぶ。
      entry.action = 'hold-unverifiable';
    } else if (minutesSinceSlot < GRACE_MINUTES) {
      entry.action = 'wait-grace';
      entry.detail = `予定時刻から${Math.round(minutesSinceSlot)}分（猶予${GRACE_MINUTES}分）`;
    } else if (entry.dispatchesInWindow >= MAX_DISPATCH_PER_WINDOW) {
      entry.action = 'cap-reached';
      stuck++;
    } else if (quota.limited === true) {
      entry.action = 'hold-usage-limit';
      entry.detail = '上限がまだ切れているため再実行を見送り（次のtickで再判定）';
    } else {
      // ここでは撃たない。全ループの判定が出揃ってから、古い取りこぼし順に
      // MAX_DISPATCH_PER_TICK 本だけ撃つ（下の第2段）。
      entry.action = 'eligible';
      entry._workflowFile = t.workflowFile;
      entry._missedForMinutes = Math.round(minutesSinceSlot);
    }
    loops.push(entry);
  }

  // ── 第2段: 再実行の実行（1tickあたりの本数を絞る）─────────────────────────
  // 取りこぼしが古いものから返す。復旧作業そのものが上限を焼き切らないようにする。
  const { dispatch, deferred } = selectForDispatch(
    loops.filter((l) => l.action === 'eligible'), MAX_DISPATCH_PER_TICK);
  for (const entry of deferred) {
    entry.action = 'queued-next-tick';
    entry.detail = `1tick上限${MAX_DISPATCH_PER_TICK}本のため次のtickへ（毎時実行）`;
  }
  for (const entry of dispatch) {
    if (DRY_RUN) { entry.action = 'would-dispatch'; continue; }
    try {
      await ghApi(`/repos/${REPO}/actions/workflows/${entry._workflowFile}/dispatches`, {
        method: 'POST',
        body: JSON.stringify({ ref: 'master' }),
      });
      entry.action = 'dispatch';
      dispatched++;
      console.log(`[loop-self-heal] 再実行しました: ${entry.id}`);
    } catch (e) {
      entry.action = 'dispatch-failed';
      entry.detail = e.message;
      stuck++;
      console.log(`[loop-self-heal] 再実行に失敗: ${entry.id}: ${e.message}`);
    }
  }
  for (const l of loops) { delete l._workflowFile; }

  // 検証系そのものが壊れているときに 'OK' と名乗らない（VALIDATION_UNAVAILABLE も
  // 停止条件のひとつ。「判定できなかった」を「異常なし」と表示するのが一番危ない）。
  const unverifiable = loops.filter((l) => l.state === 'unverifiable').length;
  let status;
  if (loops.length > 0 && unverifiable === loops.length) status = 'VALIDATION_UNAVAILABLE';
  else if (stuck > 0) status = 'DEGRADED';
  else if (unverifiable > 0) status = 'PARTIAL';
  else status = 'OK';
  writeStatus({
    generatedAt,
    status,
    quotaProbe: quota,
    graceMinutes: GRACE_MINUTES,
    maxDispatchPerWindow: MAX_DISPATCH_PER_WINDOW,
    maxDispatchPerTick: MAX_DISPATCH_PER_TICK,
    dryRun: DRY_RUN,
    dispatched,
    unverifiable,
    loops,
    excluded: discovered.filter((d) => d.skipReason).map((d) => ({ id: d.id, reason: d.skipReason })),
  });

  for (const l of loops) console.log(`  ${l.state.padEnd(14)} ${l.action.padEnd(18)} ${l.id}`);

  const stuckLoops = loops.filter((l) => l.action === 'cap-reached' || l.action === 'dispatch-failed');
  await upsertIssue(
    '[loop-self-heal] 自動復旧できないループがあります',
    [
      '自動再実行の上限に達した、または再実行APIが失敗したループがあります。',
      '利用上限では説明できない失敗の可能性があるため、原因を確認してください。',
      '',
      ...stuckLoops.map((l) => `- \`${l.id}\` — ${l.action}${l.detail ? ` (${l.detail})` : ''}`),
      '',
      `検出時刻: ${generatedAt}`,
    ].join('\n'),
    stuckLoops.length > 0,
  );
}

function writeStatus(obj) {
  try {
    mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
    writeFileSync(OUTPUT_JSON, JSON.stringify(obj, null, 2) + '\n');
    console.log(`[loop-self-heal] -> ${OUTPUT_JSON}`);
  } catch (e) {
    console.log(`[loop-self-heal] 台帳の書き込みに失敗(非致命): ${e.message}`);
  }
}

// テストから import したときは実行しない。
if (basename(process.argv[1] || '') === 'loop-self-heal.mjs') {
  main().catch((e) => {
    console.error(`[loop-self-heal] 予期しないエラー(非致命): ${e.stack || e.message}`);
  });
}
