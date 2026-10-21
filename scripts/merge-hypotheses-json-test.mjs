#!/usr/bin/env node
// merge-hypotheses-json-test.mjs — merge-hypotheses-json.mjs の回帰テスト
//
// 守っている性質:
//   1. 両側がそれぞれ別の仮説を新規追加しても、両方が残ること(データ損失なし)
//   2. 同じ hypothesis_id を両側が revision 更新したとき、revision が高い方を
//      採ること(どちらを ours/theirs にしても結果は変わらない)
//   3. revision が無い/同じときは timestamp で決め、それも無ければ ours を
//      採る(キー自体は必ず残る)
//   4. hypothesis_id が無く id にフォールバックするエントリも正しく union
//      されること
//   5. 想定外の形(items/hypotheses 配列を持たない)は混ぜずに失敗すること
//   6. 出力が妥当な JSON であること、片側にしか無いエントリが欠落しないこと
//
// 実行: node scripts/merge-hypotheses-json-test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const MERGER = path.join(here, 'merge-hypotheses-json.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-hyp-'));

function write(name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function run(a, b, out) {
  const o = path.join(dir, out);
  try {
    execFileSync(process.execPath, [MERGER, a, b, o], { stdio: 'pipe' });
  } catch (e) {
    return { failed: true, status: e.status };
  }
  return { failed: false, result: JSON.parse(fs.readFileSync(o, 'utf8')) };
}

let pass = 0, fail = 0;
function check(name, ok, got) {
  if (ok) { pass++; console.log(`  OK   ${name} -> ${got}`); }
  else { fail++; console.log(`  NG   ${name} -> ${got}`); }
}

console.log('merge-hypotheses-json の回帰テスト');

// ---- Case 1: 分岐したシナリオ本体 ----
// ours: 新規 A を追加 + C を revision 2 に更新
// theirs: 新規 B を追加 + C を revision 3 に更新(ours と異なる内容)
const base = {
  _comment: '台帳',
  schema: 'strategy_hypothesis',
  updated_at: '2026-10-21T10:00:00Z',
  items: [
    { hypothesis_id: 'hyp_C', status: 'PROPOSED', revision: 1, proposed_at: '2026-10-01T00:00:00Z' },
  ],
};

const ours1 = {
  ...base,
  updated_at: '2026-10-21T20:00:00Z',
  items: [
    { hypothesis_id: 'hyp_C', status: 'ACTIVE_UPDATED_BY_OURS', revision: 2, proposed_at: '2026-10-01T00:00:00Z' },
    { hypothesis_id: 'hyp_A', status: 'PROPOSED', revision: 1, proposed_at: '2026-10-21T19:00:00Z' },
  ],
};
const theirs1 = {
  ...base,
  updated_at: '2026-10-21T21:00:00Z',
  items: [
    { hypothesis_id: 'hyp_C', status: 'ACTIVE_UPDATED_BY_THEIRS', revision: 3, proposed_at: '2026-10-01T00:00:00Z' },
    { hypothesis_id: 'hyp_B', status: 'PROPOSED', revision: 1, proposed_at: '2026-10-21T19:30:00Z' },
  ],
};

{
  const oursPath = write('ours1.json', ours1);
  const theirsPath = write('theirs1.json', theirs1);
  const r = run(oursPath, theirsPath, 'out1.json');
  if (r.failed) {
    check('Case1: 正常に統合される', false, 'exit != 0 (想定外の失敗)');
  } else {
    const ids = r.result.items.map((e) => e.hypothesis_id).sort();
    check('Case1: A/B/C が全て残る(データ損失なし)', JSON.stringify(ids) === JSON.stringify(['hyp_A', 'hyp_B', 'hyp_C']), ids.join(','));
    const c = r.result.items.find((e) => e.hypothesis_id === 'hyp_C');
    check('Case1: C は revision が高い方(theirs, revision=3)を採る', c && c.revision === 3 && c.status === 'ACTIVE_UPDATED_BY_THEIRS', JSON.stringify(c));
    let valid = true;
    try { JSON.parse(fs.readFileSync(path.join(dir, 'out1.json'), 'utf8')); } catch { valid = false; }
    check('Case1: 出力は妥当なJSON', valid, valid ? 'parse OK' : 'parse NG');
  }
}

// ---- Case 2: ours/theirs を入れ替えても同じ結果になる ----
{
  const oursPath = write('ours2.json', theirs1); // 入れ替え
  const theirsPath = write('theirs2.json', ours1);
  const r = run(oursPath, theirsPath, 'out2.json');
  if (r.failed) {
    check('Case2: 順序入れ替えでも統合される', false, 'exit != 0');
  } else {
    const c = r.result.items.find((e) => e.hypothesis_id === 'hyp_C');
    check('Case2: 順序を入れ替えても C は revision=3 を採る', c && c.revision === 3, JSON.stringify(c));
    const ids = r.result.items.map((e) => e.hypothesis_id).sort();
    check('Case2: 順序入れ替えでもA/B/Cが全て残る', JSON.stringify(ids) === JSON.stringify(['hyp_A', 'hyp_B', 'hyp_C']), ids.join(','));
  }
}

// ---- Case 3: revisionが同じ/無い場合はtimestampで決め、それも無ければoursを採る ----
{
  const oursD = { ...base, items: [{ hypothesis_id: 'hyp_D', status: 'OLD', revised_at: '2026-10-20T00:00:00Z' }] };
  const theirsD = { ...base, items: [{ hypothesis_id: 'hyp_D', status: 'NEW', revised_at: '2026-10-21T00:00:00Z' }] };
  const oursPath = write('oursD.json', oursD);
  const theirsPath = write('theirsD.json', theirsD);
  const r = run(oursPath, theirsPath, 'outD.json');
  const d = !r.failed && r.result.items.find((e) => e.hypothesis_id === 'hyp_D');
  check('Case3: revisionが無いときはtimestampが新しい方(theirs)を採る', d && d.status === 'NEW', JSON.stringify(d));

  const oursE = { ...base, items: [{ hypothesis_id: 'hyp_E', status: 'OURS_NO_TS' }] };
  const theirsE = { ...base, items: [{ hypothesis_id: 'hyp_E', status: 'THEIRS_NO_TS' }] };
  const oursPathE = write('oursE.json', oursE);
  const theirsPathE = write('theirsE.json', theirsE);
  const rE = run(oursPathE, theirsPathE, 'outE.json');
  const e = !rE.failed && rE.result.items.find((x) => x.hypothesis_id === 'hyp_E');
  check('Case3: revision/timestampどちらも決められないときはoursを採る(キーは残る)', e && e.status === 'OURS_NO_TS', JSON.stringify(e));
}

// ---- Case 4: hypothesis_id が無く id にフォールバックするエントリ ----
{
  const oursF = { ...base, items: [{ id: 'legacy-key-1', status: 'OURS', proposed_at: '2026-10-10' }] };
  const theirsF = { ...base, items: [{ id: 'legacy-key-2', status: 'THEIRS', proposed_at: '2026-10-11' }] };
  const oursPath = write('oursF.json', oursF);
  const theirsPath = write('theirsF.json', theirsF);
  const r = run(oursPath, theirsPath, 'outF.json');
  const ids = !r.failed && r.result.items.map((e) => e.id).sort();
  check('Case4: hypothesis_idが無くidにフォールバックしても両方残る', !r.failed && JSON.stringify(ids) === JSON.stringify(['legacy-key-1', 'legacy-key-2']), r.failed ? 'failed' : ids.join(','));
}

// ---- Case 5: hypotheses配列(itemsと別キー)も同様にunionされる ----
{
  const oursG = { ...base, items: [], hypotheses: [{ hypothesis_id: 'hyp_G1', status: 'OURS', revision: 1 }] };
  const theirsG = { ...base, items: [], hypotheses: [{ hypothesis_id: 'hyp_G2', status: 'THEIRS', revision: 1 }] };
  const oursPath = write('oursG.json', oursG);
  const theirsPath = write('theirsG.json', theirsG);
  const r = run(oursPath, theirsPath, 'outG.json');
  const ids = !r.failed && r.result.hypotheses.map((e) => e.hypothesis_id).sort();
  check('Case5: hypotheses配列もunionされる', !r.failed && JSON.stringify(ids) === JSON.stringify(['hyp_G1', 'hyp_G2']), r.failed ? 'failed' : ids.join(','));
}

// ---- Case 6: 想定外の形は混ぜずに失敗する ----
{
  const malformedPath = write('malformed.json', { foo: 1, bar: [1, 2, 3] });
  const oursPath = write('oursH.json', base);
  const r1 = run(oursPath, malformedPath, 'outH1.json');
  check('Case6a: theirsが想定外の形だと失敗する(exit != 0)', r1.failed === true, r1.failed ? `exit ${r1.status}` : '誤って統合した');

  const r2 = run(malformedPath, oursPath, 'outH2.json');
  check('Case6b: oursが想定外の形だと失敗する(exit != 0)', r2.failed === true, r2.failed ? `exit ${r2.status}` : '誤って統合した');

  const arrayAtTop = write('arrayTop.json', [1, 2, 3]);
  const r3 = run(oursPath, arrayAtTop, 'outH3.json');
  check('Case6c: トップレベルが配列だと失敗する(exit != 0)', r3.failed === true, r3.failed ? `exit ${r3.status}` : '誤って統合した');
}

// ---- Case 7: hypothesis_id/id の両方を欠くエントリがあると失敗する(推測で混ぜない) ----
{
  const oursI = { ...base, items: [{ status: 'NO_KEY_AT_ALL' }] };
  const theirsI = { ...base, items: [{ hypothesis_id: 'hyp_I', status: 'OK', revision: 1 }] };
  const oursPath = write('oursI.json', oursI);
  const theirsPath = write('theirsI.json', theirsI);
  const r = run(oursPath, theirsPath, 'outI.json');
  check('Case7: 安定キーを持たないエントリがあると失敗する', r.failed === true, r.failed ? `exit ${r.status}` : '誤って統合した');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n合計: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
