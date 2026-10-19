#!/usr/bin/env node
// maint-precheck-expiry-test.mjs — regression test for the "expiry" (TLS certificate)
// check added to maint-precheck.mjs + maint-fill-expiry.mjs after the 2026-10-19
// "expiry 44/44 skipped" monitoring hole (see those files' headers for the measured
// root cause).
//
// Covers, offline / deterministic (no real socket, no network):
//   1. daysUntil() computes a correct signed day count from a fixed "now".
//   2. classifyExpiry() thresholds match SKILL.md step 5 exactly: 残30日以下=P2、14日以下=P1。
//   3. maint-fill-expiry.fillMissingExpiry() fills checks.expiry only where it is
//      missing, never overwrites a value the SKILL already wrote, and raises an
//      openFindings P1/P2 entry for a near-expiry system (not for skipped/green).
//
// Run: node scripts/maint-precheck-expiry-test.mjs

import { daysUntil, classifyExpiry } from './maint-precheck.mjs';
import { fillMissingExpiry } from './maint-fill-expiry.mjs';

let pass = 0, fail = 0;
function check(name, ok, got) {
  if (ok) { pass++; console.log(`  OK   ${name} -> ${got}`); }
  else { fail++; console.log(`  NG   ${name} -> ${got}`); }
}

console.log('maint-precheck expiry の回帰テスト');

// 1. daysUntil
{
  const now = new Date('2026-10-19T00:00:00Z').getTime();
  const d = daysUntil('2026-11-18T00:00:00Z', now);
  check('daysUntil: 30日後は30', d === 30, `days=${d}`);
  const dPast = daysUntil('2026-10-01T00:00:00Z', now);
  check('daysUntil: 過去日は負数', dPast < 0, `days=${dPast}`);
}

// 2. classifyExpiry thresholds (SKILL.md step 5: 残30日以下=P2、14日以下=P1)
{
  check('classifyExpiry(31) = green', classifyExpiry(31).status === 'green', JSON.stringify(classifyExpiry(31)));
  check('classifyExpiry(30) = finding/P2 (境界含む)', classifyExpiry(30).status === 'finding' && classifyExpiry(30).severity === 'P2', JSON.stringify(classifyExpiry(30)));
  check('classifyExpiry(15) = finding/P2', classifyExpiry(15).status === 'finding' && classifyExpiry(15).severity === 'P2', JSON.stringify(classifyExpiry(15)));
  check('classifyExpiry(14) = finding/P1 (境界含む)', classifyExpiry(14).status === 'finding' && classifyExpiry(14).severity === 'P1', JSON.stringify(classifyExpiry(14)));
  check('classifyExpiry(0) = finding/P1', classifyExpiry(0).status === 'finding' && classifyExpiry(0).severity === 'P1', JSON.stringify(classifyExpiry(0)));
  check('classifyExpiry(NaN) = skipped', classifyExpiry(NaN).status === 'skipped', JSON.stringify(classifyExpiry(NaN)));
}

// 3. fillMissingExpiry
{
  const status = {
    systems: [
      { id: 'sys-missing-green', checks: { http_tls: 'dup-string' } },
      { id: 'sys-missing-nearexpiry', checks: {} },
      { id: 'sys-already-has-expiry', checks: { expiry: 'green(TLS残75日、2026-12-11)' } },
      { id: 'sys-no-precheck-data', checks: {} },
    ],
    openFindings: [],
  };
  const precheck = {
    systems: {
      'sys-missing-green': { expiry: { status: 'green', severity: null, daysRemaining: 75, notAfter: '2026-12-11T00:00:00Z', host: 'a.example', source: 'tls-handshake' } },
      'sys-missing-nearexpiry': { expiry: { status: 'finding', severity: 'P1', daysRemaining: 10, notAfter: '2026-10-29T00:00:00Z', host: 'b.example', source: 'tls-handshake' } },
      'sys-already-has-expiry': { expiry: { status: 'green', severity: null, daysRemaining: 999, notAfter: '2029-01-01T00:00:00Z', host: 'c.example', source: 'tls-handshake' } },
      // sys-no-precheck-data deliberately absent
    },
  };

  const { filled, alreadyPresent, total } = fillMissingExpiry(status, precheck);
  check('4システム中2件に欠落分を補完(3件目は既存値維持、4件目はprecheckデータなしでスキップ)', filled === 2 && alreadyPresent === 1 && total === 4, `filled=${filled} alreadyPresent=${alreadyPresent} total=${total}`);

  const green = status.systems.find((s) => s.id === 'sys-missing-green');
  check('green値が補完されている', /green/.test(green.checks.expiry) && /75日/.test(green.checks.expiry), green.checks.expiry);
  check('元のhttp_tls欄は消えていない(上書きでなく追加)', green.checks.http_tls === 'dup-string', green.checks.http_tls);

  const already = status.systems.find((s) => s.id === 'sys-already-has-expiry');
  check('既存のexpiry値はSKILLの出力を維持(上書きしない)', already.checks.expiry === 'green(TLS残75日、2026-12-11)', already.checks.expiry);

  const noPrecheck = status.systems.find((s) => s.id === 'sys-no-precheck-data');
  check('precheckに値が無いものはcheckを追加しない(推測で埋めない)', !('expiry' in noPrecheck.checks), JSON.stringify(noPrecheck.checks));

  const finding = status.openFindings.find((f) => f.id === 'sys-missing-nearexpiry');
  check('P1近接期限はopenFindingsに積まれる', !!finding && finding.sev === 'P1' && finding.area === 'expiry', JSON.stringify(finding));
  const noFindingForGreen = status.openFindings.some((f) => f.id === 'sys-missing-green');
  check('greenなシステムはopenFindingsに積まれない', !noFindingForGreen, noFindingForGreen);

  // idempotency: running again must not duplicate the openFindings entry or double-count
  const second = fillMissingExpiry(status, precheck);
  check('2回目実行は冪等(filled=0、openFindings重複なし)', second.filled === 0 && status.openFindings.filter((f) => f.id === 'sys-missing-nearexpiry').length === 1, JSON.stringify(second));
}

console.log(`\n合計: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
