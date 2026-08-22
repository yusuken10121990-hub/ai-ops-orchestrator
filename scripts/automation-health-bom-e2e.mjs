#!/usr/bin/env node
/**
 * automation-health-bom-e2e.mjs
 *   「PC側が書いたJSONをクラウド側が読む」経路のBOM耐性を固定する回帰テスト。
 *
 * 実障害 (2026-08-23):
 *   automation-health-cloud は毎回 success で終わっていたのに、中身は
 *   localRunner.status="unknown" / error="Unexpected token '﻿' ..." だった。
 *   ローカルWindowsのスケジューラが書く automation-heartbeat.json が UTF-8 BOM 付きで、
 *   素の JSON.parse がBOMで落ちていた。
 *
 *   これは「読めなかった」だけでは終わらない。heartbeat=null になると
 *   checkLocalTasks() のheartbeatIdsが空集合になり、実際には動いている
 *   ローカルタスクがまるごと監視対象から外れる。
 *   ワークフローは緑のまま ＝ 監視のFALSE PASS で誰も気づけない。
 *
 * ここで固定すること:
 *   1. stripBom / readJson がBOM付き・BOM無しの両方を同じ値にする
 *   2. BOM付き heartbeat でも localRunner が unknown にならない
 *   3. BOM付きと BOM無しで localRunner の判定結果が一致する（metamorphic）
 *   4. 検出力の確認: BOMを剥がさない素の JSON.parse なら実際に落ちること
 *      （これが落ちないなら、このテスト自体がBOMを検知できていない＝無意味）
 *
 * 実行: node scripts/automation-health-bom-e2e.mjs   (非PASSで exit 1)
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { stripBom, readJson } from './read-json.mjs';

const SELF = dirname(fileURLToPath(import.meta.url));
const BOM = '﻿';
let pass = 0, fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)})`}`);
};

const work = mkdtempSync(join(tmpdir(), 'health-bom-'));

// automation-health-check.mjs は SCHEDULED_TASKS_DIR を import時に確定させる。
// 実リポジトリの scheduled-tasks/ に依存させるとCIの作業ディレクトリ次第で
// 結果が変わる（実際、env無しで3件落ちることを確認した）。
// テスト専用のfixtureを先に用意し、envを差してから動的importする。
const fixtureTasks = join(work, 'fixture-scheduled-tasks');
mkdirSync(join(fixtureTasks, 'brand-visual-learning'), { recursive: true });
mkdirSync(join(fixtureTasks, 'browser-task-runner'), { recursive: true });
process.env.SCHEDULED_TASKS_DIR = fixtureTasks;
const {
  windowsTaskNameToId, parseWindowsLocalTime, normalizeHeartbeatTasks, checkLocalTasks,
} = await import('./automation-health-check.mjs');

try {
  /* --- 1. ヘルパ単体 --- */
  check('stripBom: BOM付きを剥がす', stripBom(`${BOM}{"a":1}`), '{"a":1}');
  check('stripBom: BOM無しは変えない', stripBom('{"a":1}'), '{"a":1}');
  check('stripBom: 文字列以外は素通し', stripBom(null), null);

  const p = join(work, 'bom.json');
  writeFileSync(p, `${BOM}{"generatedAt":"2026-08-23T00:00:00Z","tasks":[]}\n`);
  check('readJson: BOM付きJSONを読める', readJson(p).generatedAt, '2026-08-23T00:00:00Z');

  /* --- 2. 検出力の確認（このテストがBOMをちゃんと見ているか） --- */
  let rawThrew = false;
  try { JSON.parse(readFileSync(p, 'utf8')); } catch { rawThrew = true; }
  check('検出力: BOMを剥がさない素のJSON.parseは落ちる', rawThrew, true);

  /* --- 3. 実スクリプトを両方の入力で走らせて一致を見る --- */
  const cfg = join(work, 'config');
  mkdirSync(join(cfg, 'memory'), { recursive: true });
  mkdirSync(join(cfg, 'scheduled-tasks'), { recursive: true });
  const hb = {
    generatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10分前=ok相当
    tasks: [],
  };

  const runWith = (text, tag) => {
    writeFileSync(join(cfg, 'memory/automation-heartbeat.json'), text);
    const out = join(work, `out-${tag}.json`);
    const r = spawnSync(process.execPath, [join(SELF, 'automation-health-check.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, CONFIG_DIR: cfg, OUTPUT_JSON: out, GITHUB_TOKEN: '' },
    });
    if (r.status !== 0) throw new Error(`health-check exited ${r.status}: ${r.stderr}`);
    return readJson(out).localRunner;
  };

  const withBom = runWith(BOM + JSON.stringify(hb, null, 2) + '\n', 'bom');
  const noBom = runWith(JSON.stringify(hb, null, 2) + '\n', 'nobom');

  check('BOM付きheartbeatでも localRunner が unknown にならない', withBom.status !== 'unknown', true);
  check('BOM付きheartbeatで parse error が出ない', withBom.error, null);
  check('BOM付きheartbeatの lastHeartbeatAt を読めている', withBom.lastHeartbeatAt, hb.generatedAt);
  // metamorphic: BOMの有無は判定に影響してはならない
  check('BOM有無で localRunner.status が一致', withBom.status, noBom.status);
  check('BOM有無で lastHeartbeatAt が一致', withBom.lastHeartbeatAt, noBom.lastHeartbeatAt);
  /* --- 4. heartbeatスキーマの吸収（Windowsタスクスケジューラ形式） --- */
  // 実障害2件目: BOMを直しても t.taskId は全件 undefined のままで、
  // 12タスクが id:undefined のゴミとして台帳に入るだけだった。
  check('name->id: 接頭/接尾を落としてkebabへ',
    windowsTaskNameToId('AIOps-ZerosysTransportAdsDailyPdca-Headless'), 'zerosys-transport-ads-daily-pdca');
  check('name->id: -Headless無しでも変換できる',
    windowsTaskNameToId('AIOps-WindowLedgerCleanup'), 'window-ledger-cleanup');
  check('name->id: 文字列でなければnull', windowsTaskNameToId(undefined), null);

  check('時刻: JST表記をUTCのISOへ', parseWindowsLocalTime('2026/08/22 19:47:36'), '2026-08-22T10:47:36.000Z');
  check('時刻: "N/A" は捏造せずnull', parseWindowsLocalTime('N/A'), null);
  check('時刻: 壊れた文字列もnull', parseWindowsLocalTime('2026-13-45 99:99'), null);

  const known = new Set(['browser-task-runner']);
  const norm = normalizeHeartbeatTasks({
    tasks: [
      { name: 'AIOps-BrowserTaskRunner-Headless', lastRunTime: '2026/08/22 19:47:36', status: 'ok' },
      { name: 'AIOps-KeepAwake-Headless', lastRunTime: '2026/08/21 15:47:12', status: 'not_run_or_terminated' },
    ],
  }, known);
  check('正規化: 既知タスクはIDへ解決', norm[0].taskId, 'browser-task-runner');
  check('正規化: 既知タスクは unmapped=false', norm[0].unmapped, false);
  // FACT SAFETY: 実在しないIDへ勝手に紐付けない
  check('正規化: 未知タスクはIDを捏造せず生名を保持', norm[1].taskId, 'AIOps-KeepAwake-Headless');
  check('正規化: 未知タスクは unmapped=true', norm[1].unmapped, true);
  check('正規化: ランナー申告statusを保持', norm[1].runnerReported, 'not_run_or_terminated');

  // 既存スキーマ({taskId,...})も引き続き受けられること（後方互換）
  const legacy = normalizeHeartbeatTasks({ tasks: [{ taskId: 'qa-daily', lastRunAt: '2026-08-22T00:00:00Z' }] }, known);
  check('正規化: 旧スキーマ(taskId)もそのまま通る', legacy[0].taskId, 'qa-daily');

  /* --- 5. 判定ロジック --- */
  const recent = new Date(Date.now() - 60 * 60 * 1000);
  const fmtJst = (d) => {
    const j = new Date(d.getTime() + 9 * 3600 * 1000);
    const p2 = (v) => String(v).padStart(2, '0');
    return `${j.getUTCFullYear()}/${p2(j.getUTCMonth() + 1)}/${p2(j.getUTCDate())} ${p2(j.getUTCHours())}:${p2(j.getUTCMinutes())}:${p2(j.getUTCSeconds())}`;
  };
  const hbTasks = { tasks: [{ name: 'AIOps-BrandVisualLearning-Headless', lastRunTime: fmtJst(recent), status: 'ok' }] };

  // クラウドへ移設済みなら、ローカルが止まっていても警告にしない
  const superseded = checkLocalTasks(hbTasks, [{ id: 'brand-visual-learning' }])
    .find((r) => r.id === 'brand-visual-learning');
  check('移設済みは superseded-by-cloud（逆向きの偽警告を出さない）', superseded?.status, 'superseded-by-cloud');

  // ランナーが明示的に「動いていない」と言っているなら鮮度で上書きしない
  const bad = checkLocalTasks(
    { tasks: [{ name: 'AIOps-BrandVisualLearning-Headless', lastRunTime: fmtJst(recent), status: 'not_run_or_terminated' }] },
    [],
  ).find((r) => r.id === 'brand-visual-learning');
  check('ランナー申告の失敗は鮮度より優先して stalled', bad?.status, 'stalled');

  // 日次タスクを24.5h後に見ても毎日 stalled にならないこと
  const d24 = new Date(Date.now() - 24.5 * 3600 * 1000);
  const daily = checkLocalTasks(
    { tasks: [{ name: 'AIOps-BrandVisualLearning-Headless', lastRunTime: fmtJst(d24), status: 'ok' }] },
    [],
  ).find((r) => r.id === 'brand-visual-learning');
  check('cadence不明の日次相当は24.5hで偽stalledにしない', daily?.status, 'ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`=== ${pass} passed / ${fail} failed ===`);
process.exit(fail ? 1 : 0);
