#!/usr/bin/env node
/**
 * chat-task-apply.mjs — Worker の実行結果を Task Ledger へ決定論的に反映する。
 *
 * 2026-08-17 実測（run 32006213949）で確定した Runtime Orchestration の欠陥:
 *   ヘッドレス Worker は `--permission-mode acceptEdits` の下で
 *     - ファイル書き込み → 承認不要で通る
 *     - Bash コマンド実行 → 承認待ちになり、ユーザー不在なので拒否される
 *   だった。台帳更新は Bash 経由だったので構造的に不可能だった。
 *
 * したがって役割を入れ替える:
 *   Worker      … 結果を **JSONファイルに書く**（承認不要な操作だけ）
 *   このスクリプト … そのファイルを読み、Ledger 更新コマンドを **Runtime 側で** 実行
 *
 * これで「LLMが指示に従ってBashを叩けたか」に依存しなくなる。
 * 台帳更新の実装は既存の chat-task.mjs をそのまま呼ぶ（再実装しない）。
 *
 * 使い方:
 *   node chat-task-apply.mjs --config-dir <ai-ops-config> --task <ct_id> \
 *                            --outcome <outcome.json>
 *
 * outcome.json のスキーマ:
 *   { "status": "advanced" | "completed" | "blocked",
 *     "evidence": "実測結果（必須）",
 *     "next_action": "次の具体的Action（status=advanced のとき必須）",
 *     "resume_point": "任意",
 *     "blocker": "理由（status=blocked のとき必須）" }
 *
 * 終了コード:
 *   0 = Ledger を更新した（= Task が前進した）
 *   3 = outcome ファイルが無い / 壊れている / 必須項目欠落 → 呼び出し側の
 *       reclaim に任せる（推測で埋めない = FAIL-CLOSED）
 *   2 = 使い方の誤り
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const argv = process.argv.slice(2);
const flag = (k, d = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};

const configDir = flag('config-dir');
const taskId = flag('task');
const outcomePath = flag('outcome');

if (!configDir || !taskId || !outcomePath) {
  console.error('usage: chat-task-apply.mjs --config-dir <dir> --task <ct_id> --outcome <file>');
  process.exit(2);
}

if (!fs.existsSync(outcomePath)) {
  console.log(`NO_OUTCOME Worker が ${path.basename(outcomePath)} を書かなかった`);
  process.exit(3);
}

let outcome;
try {
  outcome = JSON.parse(fs.readFileSync(outcomePath, 'utf8'));
} catch (e) {
  console.log(`BAD_OUTCOME JSONとして読めない: ${e.message}`);
  process.exit(3);
}

const status = String(outcome.status || '').toLowerCase();
const evidence = String(outcome.evidence || '').trim();

// Evidence の無い状態遷移は受け付けない（EVIDENCE FIRST）。
if (!evidence) {
  console.log('BAD_OUTCOME evidence が空。Evidenceなしで状態を進めない');
  process.exit(3);
}

const chatTask = (args) => {
  const out = execFileSync('node', [path.join('scripts', 'chat-task.mjs'), ...args],
    { cwd: configDir, encoding: 'utf8' });
  return out.trim();
};

if (status === 'advanced') {
  const next = String(outcome.next_action || '').trim();
  if (!next) {
    console.log('BAD_OUTCOME status=advanced なのに next_action が空。再開不能な状態にしない');
    process.exit(3);
  }
  const args = ['advance', taskId, '--next', next, '--evidence', evidence];
  if (outcome.resume_point) args.push('--resume', String(outcome.resume_point));
  console.log(`ADVANCED ${taskId} -> ${chatTask(args)}`);
  console.log(`  next_action: ${next}`);
} else if (status === 'completed') {
  console.log(`COMPLETED ${taskId} -> ${chatTask(['complete', taskId, '--evidence', evidence])}`);
} else if (status === 'blocked') {
  const blocker = String(outcome.blocker || '').trim();
  if (!blocker) {
    console.log('BAD_OUTCOME status=blocked なのに blocker が空');
    process.exit(3);
  }
  console.log(`BLOCKED ${taskId} -> ${chatTask(['block', taskId, '--blocker', blocker])}`);
} else {
  console.log(`BAD_OUTCOME 未知の status: ${JSON.stringify(outcome.status)}`);
  process.exit(3);
}

process.exit(0);
