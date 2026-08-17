#!/usr/bin/env node
/**
 * auto-resume-metrics.mjs — Zero-Prompt / Auto-Resume の4指標を「実測」する。
 *
 * 2026-08-17: オーナーから AUTO_RESUME_ATTEMPTS 等の報告を求められた際、
 * これらの指標がコード上のどこにも計測子として存在しないことが判明した
 * （ai-ops-config / ai-ops-orchestrator 全文検索で 0 件）。
 * 計測子が無い指標は「自己申告」にしかならない = EVIDENCE FIRST 違反。
 * そこで、既に永続化されている一次Evidenceだけから機械的に導出する。
 *
 * 一次Evidence（推測を挟まない）:
 *   1. chat-tasks.json の history[]  … CONSUMED / ADVANCED / COMPLETED /
 *                                      RECLAIMED / BLOCKED の実イベント列
 *   2. chat-task-consumer の GitHub Actions 実行履歴 … 各 run の `event` が
 *      'schedule' なら人間の介在なし、'workflow_dispatch' なら人間が起動。
 *
 * FAIL-CLOSED: run と対応づけられなかった CONSUMED は trigger=UNKNOWN とし、
 * 「without_prompt」には決して数えない（UNKNOWN を 0 や「自動」で埋めない）。
 *
 * 使い方:
 *   node auto-resume-metrics.mjs --ledger <chat-tasks.json> [--runs <runs.json>] [--json]
 *
 *   --runs は GitHub API の `GET /actions/workflows/chat-task-consumer.yml/runs`
 *   のレスポンス（{workflow_runs:[...]}）またはその配列をそのまま渡す。
 *   省略した場合、全 CONSUMED の trigger は UNKNOWN になる。
 */
import fs from 'fs';

const argv = process.argv.slice(2);
const flag = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const asJson = argv.includes('--json');

const ledgerPath = flag('ledger');
if (!ledgerPath) {
  console.error('usage: auto-resume-metrics.mjs --ledger <chat-tasks.json> [--runs <runs.json>] [--json]');
  process.exit(2);
}

const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));

/** GitHub Actions の run 一覧 → 実行時間窓つきの配列。 */
function loadRuns(p) {
  if (!p) return [];
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const runs = Array.isArray(raw) ? raw : (raw.workflow_runs || []);
  return runs
    .map((r) => ({
      id: r.id,
      event: r.event, // schedule | workflow_dispatch | ...
      conclusion: r.conclusion,
      from: Date.parse(r.run_started_at || r.created_at),
      // 終了時刻が無い run は窓を閉じられないので Infinity にはせず除外する。
      to: Date.parse(r.updated_at || r.created_at),
    }))
    .filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to));
}

const runs = loadRuns(flag('runs'));

/** イベント時刻を含む run を探す。見つからなければ null（= UNKNOWN）。 */
function runFor(tsMs) {
  return runs.find((r) => tsMs >= r.from - 5000 && tsMs <= r.to + 5000) || null;
}

const PROGRESS = new Set(['ADVANCED', 'COMPLETED']);
const GIVEUP = new Set(['RECLAIMED', 'BLOCKED']);

const attempts = [];

for (const task of ledger.items || []) {
  const hist = [...(task.history || [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  hist.forEach((ev, i) => {
    if (ev.event !== 'CONSUMED') return;

    const at = Date.parse(ev.at);
    const run = runFor(at);

    // この CONSUMED の後、次の CONSUMED までの間に前進イベントがあったか。
    let outcome = 'NO_PROGRESS';
    const progressed = [];
    for (const nxt of hist.slice(i + 1)) {
      if (nxt.event === 'CONSUMED') break;
      if (PROGRESS.has(nxt.event)) { outcome = 'PROGRESSED'; progressed.push(nxt.event); }
      if (GIVEUP.has(nxt.event) && outcome !== 'PROGRESSED') { outcome = nxt.event; break; }
    }

    attempts.push({
      task_id: task.task_id,
      at: ev.at,
      by: ev.by || 'UNKNOWN',
      // 人間の介在なし = schedule で起動された run の中で起きた CONSUMED のみ。
      // run が特定できない場合は UNKNOWN のまま（without_prompt に数えない）。
      trigger: run ? run.event : 'UNKNOWN',
      run_id: run ? run.id : null,
      outcome,
      progressed,
    });
  });
}

const withoutPrompt = (a) => a.trigger === 'schedule';
const succeeded = (a) => a.outcome === 'PROGRESSED';

const metrics = {
  AUTO_RESUME_ATTEMPTS: attempts.length,
  AUTO_RESUME_SUCCESSES: attempts.filter(succeeded).length,
  OPEN_TASKS_RESUMED_WITHOUT_PROMPT:
    new Set(attempts.filter((a) => withoutPrompt(a) && succeeded(a)).map((a) => a.task_id)).size,
  NEXT_ACTIONS_EXECUTED_WITHOUT_PROMPT:
    attempts.filter((a) => withoutPrompt(a) && succeeded(a))
      .reduce((n, a) => n + a.progressed.length, 0),
};

const report = {
  measured_at: new Date().toISOString(),
  verification_status: runs.length ? 'VERIFIED' : 'PARTIALLY_VERIFIED',
  evidence: {
    ledger: ledgerPath,
    ledger_updated_at: ledger.updated_at || null,
    consumer_runs_loaded: runs.length,
    note: runs.length
      ? null
      : '--runs 未指定のため全 trigger が UNKNOWN。without_prompt 系は 0 に固定される（推測で埋めない）。',
  },
  metrics,
  attempts,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[auto-resume-metrics] ${report.verification_status}  runs=${runs.length}  attempts=${attempts.length}`);
  for (const [k, v] of Object.entries(metrics)) console.log(`  ${k} = ${v}`);
  if (attempts.length) {
    console.log('  --- 実測されたResume試行 ---');
    for (const a of attempts) {
      console.log(`  ${a.at}  ${a.task_id}  by=${a.by}  trigger=${a.trigger}  outcome=${a.outcome}`);
    }
  }
  if (report.evidence.note) console.log(`  NOTE: ${report.evidence.note}`);
}
