#!/usr/bin/env node
/**
 * chat-task-reclaim.mjs — Consumer が Task を拾ったのに前進させずに終わった場合の後始末。
 *
 * 2026-08-17 実測（GitHub Actions run 32006213949 / ai-ops-config chat-tasks.json）で
 * 確定した2つの欠陥を塞ぐ:
 *
 *   欠陥1: 無限リトライ。旧実装は IN_PROGRESS を黙って OPEN に戻すだけだった。
 *          Worker が構造的に前進できない状態（= 権限設定の誤り）だと、
 *          30分ごとに CONSUMED → RECLAIMED を永久に繰り返し、attempts だけが
 *          増えて誰にも気づかれない。失敗理由も残らない。
 *          → 失敗を evidence として記録し、max-attempts 到達で BLOCKED にして
 *            人間に見えるようにする。
 *
 *   欠陥2: 偽green。Workflow は全ステップ success で終わるが、台帳上は
 *          1mmも進んでいない。「成功コード=成功ではない」(QUALITY OS) 違反。
 *          → 前進しなかった場合は exit 1 して Job を赤くする。
 *
 * 使い方:
 *   node chat-task-reclaim.mjs <ledger.json> <task_id> [--max-attempts 3] [--reason "..."]
 *
 * 終了コード:
 *   0 = Worker が正常に台帳を更新していた（ADVANCED / COMPLETED / BLOCKED）
 *   1 = 前進しなかった（RECLAIMED または BLOCKED 化した）= Job を失敗させる
 *   2 = 使い方の誤り
 */
import fs from 'fs';

const argv = process.argv.slice(2);
const flag = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !String(argv[i - 1] || '').startsWith('--'));
const [ledgerPath, taskId] = positional;

if (!ledgerPath || !taskId) {
  console.error('usage: chat-task-reclaim.mjs <ledger.json> <task_id> [--max-attempts N] [--reason "..."]');
  process.exit(2);
}

const maxAttempts = Number(flag('max-attempts', '3'));
const reason = flag('reason', 'Workerが状態更新せず終了');

const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
const task = (ledger.items || []).find((x) => x.task_id === taskId);

if (!task) {
  console.error(`task not found: ${taskId}`);
  process.exit(2);
}

// Worker が自分で状態を更新できていれば、それが正。ここでは何もしない。
if (task.status !== 'IN_PROGRESS') {
  console.log(`OK 状態更新済み: ${task.status}`);
  process.exit(0);
}

const at = new Date().toISOString();
const attempts = Number(task.attempts || 0);

// 失敗そのものを Evidence として残す。次のSessionが「なぜ止まっているか」を
// 台帳だけで判断できるようにする（推測させない）。
task.evidence = [...(task.evidence || []), `[${at}] RECLAIM: ${reason} (attempt ${attempts}/${maxAttempts})`];
delete task.lease_owner;
delete task.lease_until;

if (attempts >= maxAttempts) {
  // 同じ失敗を繰り返している = Worker側の構造的欠陥。静かに回し続けない。
  task.status = 'BLOCKED';
  task.blockers = [...(task.blockers || []), `${maxAttempts}回連続で前進できず: ${reason}`];
  task.history.push({ at, event: 'BLOCKED', blocker: reason, attempts });
  console.log(`BLOCKED ${taskId} — ${attempts}回連続で前進せず。人間の判断が必要。`);
} else {
  task.status = 'OPEN';
  task.history.push({ at, event: 'RECLAIMED', note: reason, attempts });
  console.log(`RECLAIMED ${taskId} — attempt ${attempts}/${maxAttempts}`);
}

task.updated_at = at;
ledger.updated_at = at;
fs.writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);

// 台帳が進んでいない以上、この実行は成功ではない。
process.exit(1);
