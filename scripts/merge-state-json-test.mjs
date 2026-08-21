#!/usr/bin/env node
// merge-state-json-test.mjs — merge-state-json.mjs の回帰テスト
//
// 守っている性質:
//   1. 累積カウンタ(streakDays)の加算を、衝突解決で失わないこと
//   2. どちらを ours/theirs にしても同じ結果になること（順序に依存しない）
//   3. 想定外の形は混ぜずに失敗すること（推測で統合しない）
//
// 実行: node scripts/merge-state-json-test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const MERGER = path.join(here, 'merge-state-json.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-state-'));

const state = (streakDays, date, checkedAt) => ({
  version: 1,
  channels: {
    meta_research: {
      streakDays, lastEvaluatedDate: date,
      lastSnapshot: { date, spendToday: 1500, researchCountToday: 0, checkedAt },
    },
  },
});

function write(name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function merge(a, b, out) {
  const o = path.join(dir, out);
  try { execFileSync(process.execPath, [MERGER, a, b, o], { stdio: 'pipe' }); }
  catch { return { failed: true }; }
  return JSON.parse(fs.readFileSync(o, 'utf8')).channels.meta_research;
}

let pass = 0, fail = 0;
function check(name, ok, got) {
  if (ok) { pass++; console.log(`  OK   ${name} -> ${got}`); }
  else { fail++; console.log(`  NG   ${name} -> ${got}`); }
}

const newer = write('newer.json', state(3, '2026-08-21', '2026-08-21T03:40:00Z'));
const older = write('older.json', state(2, '2026-08-20', '2026-08-20T03:40:00Z'));
const sameDayLower = write('same.json', state(2, '2026-08-21', '2026-08-21T01:00:00Z'));
const malformed = write('bad.json', { foo: 1 });

console.log('merge-state-json の回帰テスト');

let r = merge(newer, older, 'o1.json');
check('日付が違うとき新しい側を採る（加算を失わない）', r.streakDays === 3, `streakDays=${r.streakDays}`);

r = merge(older, newer, 'o2.json');
check('順序を入れ替えても同じ結果', r.streakDays === 3, `streakDays=${r.streakDays}`);

r = merge(newer, sameDayLower, 'o3.json');
check('同じ日で値が違うとき大きい側を採る', r.streakDays === 3, `streakDays=${r.streakDays}`);

r = merge(sameDayLower, newer, 'o4.json');
check('同じ日・逆順でも大きい側', r.streakDays === 3, `streakDays=${r.streakDays}`);

r = merge(newer, malformed, 'o5.json');
check('想定外の形は混ぜずに失敗する', r.failed === true, r.failed ? 'exit 1' : '誤って統合した');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n合計: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
