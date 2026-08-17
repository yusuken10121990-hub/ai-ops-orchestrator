#!/usr/bin/env node
/**
 * auto-resume-e2e.mjs — Zero-Prompt / Auto-Resume 系の回帰テスト。
 *
 * 2026-08-17 の実測事故を永久回帰ケースとして固定する:
 *
 *   INCIDENT-1 (RUNTIME_BYPASS): chat-task-consumer が Task を CONSUMED した後、
 *     `--permission-mode acceptEdits` では Bash が承認待ちになりヘッドレスでは
 *     拒否されるため、台帳更新コマンドを実行できず永久に前進できなかった。
 *     旧実装は黙って OPEN に戻すだけで、30分ごとに同じ失敗を無限反復していた。
 *
 *   INCIDENT-2 (FALSE_GREEN): それでも Workflow は全ステップ success で終わり、
 *     実行履歴は「成功」に見えた。QUALITY OS「成功コード=成功ではない」違反。
 *
 *   INCIDENT-3 (SELF_REPORTED_METRIC): AUTO_RESUME_* 指標に計測子が存在せず、
 *     報告が自己申告になっていた。UNKNOWN を「自動」で埋めない。
 *
 * 実行: node scripts/auto-resume-e2e.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RECLAIM = path.join(HERE, 'chat-task-reclaim.mjs');
const METRICS = path.join(HERE, 'auto-resume-metrics.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-resume-e2e-'));

let pass = 0;
let fail = 0;

const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`  PASS  ${name}`); } else {
    fail += 1;
    console.log(`  FAIL  ${name}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
};

/** スクリプトを実行し {code, stdout} を返す（非0でも例外にしない）。 */
function run(script, args) {
  try {
    const stdout = execFileSync('node', [script, ...args], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? -1, stdout: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function ledger(file, items) {
  const p = path.join(TMP, file);
  fs.writeFileSync(p, JSON.stringify({ version: '1.0.0', items }, null, 2));
  return p;
}

const task = (over = {}) => ({
  task_id: 'ct_test', status: 'IN_PROGRESS', attempts: 1,
  evidence: [], blockers: [], history: [], ...over,
});

console.log('=== INCIDENT-1: 無限リトライを止める ===');
{
  const p = ledger('a.json', [task({ attempts: 1 })]);
  const r = run(RECLAIM, [p, 'ct_test', '--max-attempts', '3', '--reason', 'x']);
  const t = JSON.parse(fs.readFileSync(p, 'utf8')).items[0];
  check('未到達なら OPEN に戻して再試行を許す', t.status, 'OPEN');
  check('失敗理由を evidence に残す（推測させない）', t.evidence.length, 1);
  check('前進していないので exit 1', r.code, 1);
}
{
  const p = ledger('b.json', [task({ attempts: 3 })]);
  run(RECLAIM, [p, 'ct_test', '--max-attempts', '3', '--reason', 'x']);
  const t = JSON.parse(fs.readFileSync(p, 'utf8')).items[0];
  check('上限到達で BLOCKED（静かに回し続けない）', t.status, 'BLOCKED');
  check('blocker が人間に見える形で残る', t.blockers.length, 1);
}
{
  const p = ledger('c.json', [task({ status: 'COMPLETED' })]);
  const r = run(RECLAIM, [p, 'ct_test']);
  check('Worker が更新済みなら上書きしない', JSON.parse(fs.readFileSync(p, 'utf8')).items[0].status, 'COMPLETED');
  check('正常時は exit 0', r.code, 0);
}

console.log('=== INCIDENT-2: 偽green を作らない ===');
{
  const wf = fs.readFileSync(path.join(HERE, '..', '.github', 'workflows', 'chat-task-consumer.yml'), 'utf8');
  check('Worker は承認不要なファイル書き込みで報告する',
    /\.chat-task-outcome\.json/.test(wf), true);
  check('Ledger 更新は Runtime 側が決定論的に行う',
    /chat-task-apply\.mjs/.test(wf), true);
  check('前進しなかったら Job を失敗させるステップがある',
    /steps\.apply\.outcome != 'success'/.test(wf), true);

  // 2026-08-17 実測: ":00 / :30" に置いた schedule は 62分経っても発火しなかった。
  // GitHub は高負荷時に schedule を遅延・間引くと明記しており、毎時の開始時刻が
  // 最も混雑する。混雑枠に戻す退行を検出する。
  const cron = (wf.match(/- cron:\s*"([^"]+)"/) || [])[1] || '';
  check('schedule が設定されている', !!cron, true);
  const minuteField = cron.split(/\s+/)[0] || '';
  const firesAtTopOfHour = minuteField === '*'
    || /(^|,)0($|,)/.test(minuteField)
    || /^\*\/(1|2|3|4|5|6|10|12|15|20|30|60)$/.test(minuteField);
  check('毎時 :00 の混雑枠を使っていない', firesAtTopOfHour, false);
}

console.log('=== apply: Worker報告のLedger反映 ===');
{
  // config を模したディレクトリ（chat-task.mjs を薄いスタブで置き換える）
  const cfg = path.join(TMP, 'cfg');
  fs.mkdirSync(path.join(cfg, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'scripts', 'chat-task.mjs'),
    "console.log('CALLED:'+process.argv.slice(2).join('|'));\n");

  const apply = (obj) => {
    const f = path.join(TMP, 'outcome.json');
    if (obj === null) { fs.rmSync(f, { force: true }); } else { fs.writeFileSync(f, JSON.stringify(obj)); }
    return run(path.join(HERE, 'chat-task-apply.mjs'),
      ['--config-dir', cfg, '--task', 'ct_test', '--outcome', f]);
  };

  const adv = apply({ status: 'advanced', evidence: '実測した', next_action: '次の一手' });
  check('advanced → chat-task.mjs advance を呼ぶ', /CALLED:advance\|ct_test/.test(adv.stdout), true);
  check('advanced は exit 0', adv.code, 0);
  check('next_action が渡る', /次の一手/.test(adv.stdout), true);

  check('completed → complete を呼ぶ',
    /CALLED:complete\|ct_test/.test(apply({ status: 'completed', evidence: 'e' }).stdout), true);
  check('blocked → block を呼ぶ（真のHuman-only blockerのみ）',
    /CALLED:block\|ct_test/.test(
      apply({ status: 'blocked', evidence: 'e', blocker: 'API keyが未投入' }).stdout), true);

  check('outcome 未提出は exit 3（推測で進めない）', apply(null).code, 3);
  check('evidence 空は拒否', apply({ status: 'completed', evidence: '' }).code, 3);
  check('advanced で next_action 欠落は拒否（再開不能にしない）',
    apply({ status: 'advanced', evidence: 'e' }).code, 3);
  check('未知の status は拒否', apply({ status: 'done', evidence: 'e' }).code, 3);

  // F: 偽のblockerで自走を止めさせない
  const bogus = apply({ status: 'blocked', evidence: 'e', blocker: 'Context不足で判断できない' });
  check('Context不足を blocker として認めない', bogus.code, 3);
  check('偽blockerは Ledger を触らない', /REJECTED_BLOCKER/.test(bogus.stdout), true);
  check('別Repoを blocker として認めない',
    apply({ status: 'blocked', evidence: 'e', blocker: '別Repoのファイルが見えない' }).code, 3);
  check('調査が必要を blocker として認めない',
    apply({ status: 'blocked', evidence: 'e', blocker: 'さらに調査が必要' }).code, 3);
  check('真のblocker(Credential)は認める',
    apply({ status: 'blocked', evidence: 'e', blocker: 'META_APP_SECRET が未投入' }).code, 0);
  check('真のblocker(金銭)は認める',
    apply({ status: 'blocked', evidence: 'e', blocker: '広告費の予算変更が必要' }).code, 0);
}

console.log('=== F: Human-only blocker の判定 ===');
{
  const { isHumanOnlyBlocker: h } = await import(path.join(HERE, 'chat-task-apply.mjs'));
  for (const t of ['Context不足', '別Repoにある', '別Agentが必要', 'テストが必要',
    '調査が必要', '修正が必要', '次のStepが不明', 'permission-modeの問題']) {
    check(`NOT blocker: ${t}`, h(t), false);
  }
  for (const t of ['有料契約が必要', 'API keyが未投入', '法的判断が必要',
    '不可逆なデータ削除になる', '入札変更が必要', 'オーナー判断が必要',
    'High-Risk Conflictで安全に解消不能']) {
    check(`HUMAN-ONLY: ${t}`, h(t), true);
  }
  check('既定は blocker ではない（ループを続ける側に倒す）', h('よくわからない状況'), false);
}

console.log('=== INCIDENT-3: 指標を自己申告にしない ===');
{
  const hist = [
    { at: '2026-08-17T09:01:00.000Z', event: 'CONSUMED', by: 'cloud-consumer' },
    { at: '2026-08-17T09:03:00.000Z', event: 'ADVANCED' },
  ];
  const p = ledger('d.json', [task({ status: 'OPEN', history: hist })]);
  const runsP = path.join(TMP, 'runs.json');

  fs.writeFileSync(runsP, JSON.stringify({ workflow_runs: [{
    id: 1, event: 'schedule', conclusion: 'success',
    run_started_at: '2026-08-17T09:00:00Z', updated_at: '2026-08-17T09:05:00Z' }] }));
  const auto = JSON.parse(run(METRICS, ['--ledger', p, '--runs', runsP, '--json']).stdout).metrics;
  check('schedule起動+前進 → without_prompt が立つ', auto.OPEN_TASKS_RESUMED_WITHOUT_PROMPT, 1);

  fs.writeFileSync(runsP, JSON.stringify({ workflow_runs: [{
    id: 1, event: 'workflow_dispatch', conclusion: 'success',
    run_started_at: '2026-08-17T09:00:00Z', updated_at: '2026-08-17T09:05:00Z' }] }));
  const manual = JSON.parse(run(METRICS, ['--ledger', p, '--runs', runsP, '--json']).stdout).metrics;
  check('人間が起動した run は without_prompt に数えない', manual.OPEN_TASKS_RESUMED_WITHOUT_PROMPT, 0);

  const unknown = JSON.parse(run(METRICS, ['--ledger', p, '--json']).stdout);
  check('run が特定できなければ FAIL-CLOSED', unknown.metrics.OPEN_TASKS_RESUMED_WITHOUT_PROMPT, 0);
  check('検証状態を PARTIALLY_VERIFIED として明示', unknown.verification_status, 'PARTIALLY_VERIFIED');

  const noProgress = ledger('e.json', [task({
    history: [{ at: '2026-08-17T09:01:00.000Z', event: 'CONSUMED', by: 'cloud-consumer' },
      { at: '2026-08-17T09:02:00.000Z', event: 'RECLAIMED' }] })]);
  const m = JSON.parse(run(METRICS, ['--ledger', noProgress, '--json']).stdout).metrics;
  check('拾っただけでは SUCCESS に数えない', m.AUTO_RESUME_SUCCESSES, 0);
  check('拾った事実は ATTEMPTS に数える', m.AUTO_RESUME_ATTEMPTS, 1);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n[auto-resume-e2e] ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
