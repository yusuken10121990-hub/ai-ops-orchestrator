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
 *   3 = outcome が無い/壊れている/必須項目欠落/偽のblocker → 呼び出し側の
 *       reclaim に任せる（推測で埋めない = FAIL-CLOSED）
 *   2 = 使い方の誤り
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * 真の Human-only blocker だけを認める（オーナー指定の7分類）。
 *
 * BLOCKED は Task を Consumer の対象外にする（consume() の eligible 条件が
 * blockers 空を要求する）。つまり「blockedと言えば自走が止まる」ので、
 * Worker が *自分で解消できること* を blocker と称して逃げるのを防ぐ必要がある。
 * 既定は「blockerではない」= ループを続ける側に倒す。
 */
export function isHumanOnlyBlocker(text) {
  const s = String(text);

  // これらは Worker 自身が解消すべきもの。blocker として認めない。
  const NOT_BLOCKER = /(context不足|コンテキスト不足|情報が足りな|別repo|別リポジトリ|他のリポジトリ|別agent|別エージェント|テストが必要|test.*必要|調査が必要|要調査|修正が必要|次のstep|次のステップ|わからな|不明|確認が必要|権限モード|permission-mode)/i;
  if (NOT_BLOCKER.test(s)) return false;

  const HUMAN_ONLY = [
    /(有料契約|新規契約|サブスクリプション契約|課金の開始|決済手段)/,
    /(credential|クレデンシャル|api.?key|アクセストークン|秘密鍵|パスワード|secret.*未投入|認証情報)/i,
    /(法的|法務|契約書|コンプライアンス|個人情報保護|利用規約)/,
    /(不可逆|取り消せな|復元できな|データ削除|本番削除|アカウント削除)/,
    /(広告費|予算変更|入札変更|出稿|支払|請求|返金|送金)/,
    /(経営判断|事業判断|オーナー判断|目標値の決定)/,
    /(high.?risk conflict|安全に解消不能|矛盾が解消できな|rule_conflict)/i,
  ];
  return HUMAN_ONLY.some((re) => re.test(s));
}

/** このファイルが直接実行されたか（import 時に CLI を走らせないため）。 */
function isMain() {
  return process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

function cli() {
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

  const chatTask = (args) => execFileSync('node',
    [path.join('scripts', 'chat-task.mjs'), ...args],
    { cwd: configDir, encoding: 'utf8' }).trim();

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
    // Context不足・別Repo・別Agent・Test・調査・修正・次Step は blocker ではない。
    if (!isHumanOnlyBlocker(blocker)) {
      console.log(`REJECTED_BLOCKER Human-only blocker ではない: ${blocker}`);
      console.log('  → Ledgerは前進させない。次のscheduled runで再試行する。');
      process.exit(3);
    }
    console.log(`BLOCKED ${taskId} -> ${chatTask(['block', taskId, '--blocker', blocker])}`);
  } else {
    console.log(`BAD_OUTCOME 未知の status: ${JSON.stringify(outcome.status)}`);
    process.exit(3);
  }

  process.exit(0);
}

if (isMain()) cli();
