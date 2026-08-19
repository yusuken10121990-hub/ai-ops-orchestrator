#!/usr/bin/env node
// loop-self-heal-e2e.mjs — loop-self-heal.mjs の回帰テスト（ネットワーク不要・冪等）。
//
// 実測事故ベースのケースを永久回帰として持つ:
//   TEST-A: 2026-08-19 の「exit 0(SKIPPED)なのに実質未実行」を ok と誤判定しないこと
//   TEST-B: */5 ループ(creative-studio-apply-runner)を復旧対象にしないこと
//           （SKILL.md の 2026-07-19 二重投入事故。自力で復活するので触る必要もない）
//   TEST-C: 判定不能(注釈が読めない)を needs-recovery に倒さないこと(FAIL-CLOSED)
//
// Usage: node scripts/loop-self-heal-e2e.mjs

import { classifyCron, lastScheduledOccurrence, discoverLoops, decideState, selectForDispatch } from './loop-self-heal.mjs';

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  failures.push(`${name}\n    expected: ${e}\n    actual:   ${a}`);
}

// ── classifyCron ────────────────────────────────────────────────────────────
check('cron daily (ad-pdca-daily)', classifyCron('10 1 * * *'), { kind: 'daily', minute: 10, hour: 1 });
check('cron weekly (maintenance-weekly)', classifyCron('0 0 * * 0'), { kind: 'weekly', minute: 0, hour: 0, dow: 0 });
check('cron 5分毎は対象外', classifyCron('*/5 * * * *').kind, 'unsupported');
check('cron 複数時刻は対象外', classifyCron('45 0,3,6,9,12,15,18,21 * * *').kind, 'unsupported');
check('cron 毎時は対象外', classifyCron('8,38 * * * *').kind, 'unsupported');
check('cron 月次は対象外', classifyCron('0 1 1 * *').kind, 'unsupported');
check('cron 不正入力', classifyCron('nonsense').kind, 'unsupported');
check('cron null入力', classifyCron(null).kind, 'unsupported');

// ── lastScheduledOccurrence ─────────────────────────────────────────────────
const daily = classifyCron('10 1 * * *');
check(
  '日次: 予定時刻を過ぎていれば当日',
  lastScheduledOccurrence(daily, new Date('2026-08-19T05:00:00Z')).toISOString(),
  '2026-08-19T01:10:00.000Z',
);
check(
  '日次: 予定時刻前なら前日',
  lastScheduledOccurrence(daily, new Date('2026-08-19T00:30:00Z')).toISOString(),
  '2026-08-18T01:10:00.000Z',
);
const weekly = classifyCron('0 0 * * 0'); // 日曜 00:00 UTC
check(
  '週次: 直近の日曜まで巻き戻す',
  lastScheduledOccurrence(weekly, new Date('2026-08-19T05:00:00Z')).toISOString(), // 8/19は水曜
  '2026-08-16T00:00:00.000Z', // 直前の日曜
);

// ── discoverLoops（実物の .github/workflows を読む）────────────────────────
const loops = discoverLoops('.github/workflows');
const byId = Object.fromEntries(loops.map((l) => [l.id, l]));
const targets = loops.filter((l) => !l.skipReason).map((l) => l.id);

check('ワークフローを1本以上発見できている', loops.length > 0, true);
check('ad-pdca-daily は復旧対象', targets.includes('ad-pdca-daily'), true);
check('business-os-daily は復旧対象', targets.includes('business-os-daily'), true);
check('zerosys-ad-pdca は復旧対象', targets.includes('zerosys-ad-pdca'), true);
// TEST-B: 5分ループは触らない
check('creative-studio-apply-runner は対象外', byId['creative-studio-apply-runner']?.skipReason,
  'high-frequency-or-unsupported-cron');
check('jobqueue-runner は対象外', byId['jobqueue-runner']?.skipReason, 'high-frequency-or-unsupported-cron');
// Claudeを使わない=上限の影響を受けない
check('automation-health-cloud は対象外(Claude不使用)', byId['automation-health-cloud']?.skipReason, 'no-claude-loop');
check('backup-daily は対象外(Claude不使用)', byId['backup-daily']?.skipReason, 'no-claude-loop');
check('対象は全て run-loop.sh を使う', targets.every((id) => byId[id].usesRunLoop), true);
check('対象は全て workflow_dispatch を持つ', targets.every((id) => byId[id].hasDispatch), true);

// ── decideState ─────────────────────────────────────────────────────────────
const R = (id, conclusion, status = 'completed', event = 'schedule') => ({ id, conclusion, status, event });

check('本当に成功したrunがあれば ok',
  decideState([R(1, 'success')], new Map([[1, false]])), 'ok');

// TEST-A: 上限SKIPPED(exit 0)のsuccessを「動いた」と誤判定しない
check('上限SKIPPEDのsuccessだけなら needs-recovery',
  decideState([R(1, 'success')], new Map([[1, true]])), 'needs-recovery');

check('SKIPPED後に本物の成功があれば ok',
  decideState([R(1, 'success'), R(2, 'success')], new Map([[1, true], [2, false]])), 'ok');

check('失敗のみなら needs-recovery',
  decideState([R(1, 'failure')], new Map()), 'needs-recovery');

check('runが1本も無ければ needs-recovery',
  decideState([], new Map()), 'needs-recovery');

check('実行中のrunがあれば running（重ねて起動しない）',
  decideState([R(1, null, 'in_progress')], new Map()), 'running');

check('queuedも running 扱い',
  decideState([R(1, null, 'queued')], new Map()), 'running');

// TEST-C: FAIL-CLOSED
check('注釈が読めない(null)なら unverifiable（needs-recoveryに倒さない）',
  decideState([R(1, 'success')], new Map([[1, null]])), 'unverifiable');

check('判定不能と確実な成功が混在するなら ok を優先',
  decideState([R(1, 'success'), R(2, 'success')], new Map([[1, null], [2, false]])), 'ok');

// ── selectForDispatch（復旧が上限を焼き切らないための安全弁）────────────────
// TEST-D: 2026-08-19 本番dry-runで復旧対象が16本同時に立った。1tickで全部撃つと
// 戻ったばかりの週次トークンを復旧作業自体が焼き切る（自家中毒）。古い順に数本ずつ。
{
  const mk = (id, m) => ({ id, _missedForMinutes: m });
  const e = [mk('new', 100), mk('oldest', 900), mk('mid', 500)];
  const { dispatch, deferred } = selectForDispatch(e, 2);
  check('TEST-D 古い取りこぼしから返す', dispatch.map((x) => x.id), ['oldest', 'mid']);
  check('TEST-D 残りは次tickへ', deferred.map((x) => x.id), ['new']);
  check('TEST-D 入力を破壊しない', e.map((x) => x.id), ['new', 'oldest', 'mid']);
}
// TEST-E: 事業PDCAを学習系より先に返す（2026-08-19 本番実測で順番が逆だった）
{
  const e = [
    { id: 'research-team-learning', _missedForMinutes: 900 },
    { id: 'rivet-ui-learning', _missedForMinutes: 800 },
    { id: 'ad-pdca-daily', _missedForMinutes: 300 },
    { id: 'zerosys-ad-pdca', _missedForMinutes: 350 },
  ];
  const { dispatch } = selectForDispatch(e, 2);
  check('TEST-E 事業PDCAが先（古さより事業影響）', dispatch.map((x) => x.id),
    ['zerosys-ad-pdca', 'ad-pdca-daily']);
}
{
  const e = [
    { id: 'ad-pdca-daily', _missedForMinutes: 100 },
    { id: 'business-os-daily', _missedForMinutes: 500 },
  ];
  const { dispatch } = selectForDispatch(e, 2);
  check('TEST-E 同じtier内は古い順', dispatch.map((x) => x.id), ['business-os-daily', 'ad-pdca-daily']);
}
{
  const { dispatch, deferred } = selectForDispatch([], 3);
  check('TEST-D 対象0件でも壊れない', [dispatch.length, deferred.length], [0, 0]);
}
{
  const e = [{ id: 'a', _missedForMinutes: 10 }, { id: 'b', _missedForMinutes: 20 }];
  const { dispatch, deferred } = selectForDispatch(e, 10);
  check('TEST-D capが対象数より大きければ全部撃つ', [dispatch.length, deferred.length], [2, 0]);
}
{
  const e = [{ id: 'a', _missedForMinutes: 10 }];
  const { dispatch, deferred } = selectForDispatch(e, 0);
  check('TEST-D cap=0なら1本も撃たない', [dispatch.length, deferred.length], [0, 1]);
}

// ── 結果 ────────────────────────────────────────────────────────────────────
console.log(`\nloop-self-heal-e2e: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log('復旧対象ループ:', targets.join(', '));
