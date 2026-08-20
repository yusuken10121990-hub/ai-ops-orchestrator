#!/usr/bin/env node
/**
 * run-loop-contract-e2e.mjs — 共有ループ入口（run-loop.sh）の契約を静的に固定する回帰。
 *
 * 実測事故（2026-08-20）:
 *   CLI起動確認を足すつもりで run-loop.sh に `. scripts/ensure-claude-cli.sh` を
 *   **相対パスで**追加した。run-loop.sh は途中で `cd "${HOME_CLAUDE}"` するため、
 *   source に到達した時点の CWD はリポジトリルートではない。結果:
 *     scripts/run-loop.sh: line 161: scripts/ensure-claude-cli.sh: No such file or directory
 *   このファイルは 38 本の workflow が共有しているため、**全ループが即死**した
 *   （zerosys-ad-pdca 08:32Z / creative-studio-apply-runner 08:36Z を実測）。
 *
 * 教訓（一般化）: 共有入口スクリプトで `cd` をまたぐ参照は必ず絶対パスにする。
 * 「動くはず」ではなく、相対 source が混入したらテストで落とす。
 *
 * ネットワーク不要・冪等。Usage: node scripts/run-loop-contract-e2e.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const failures = [];
const check = (name, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass += 1; return; }
  failures.push(`${name}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
};

const runLoopPath = path.join(ROOT, 'scripts', 'run-loop.sh');
check('run-loop.sh が存在する', fs.existsSync(runLoopPath), true);
const src = fs.readFileSync(runLoopPath, 'utf8');
const lines = src.split('\n');

/** コメントを除いた実行行だけを見る。 */
const codeLines = lines
  .map((l, i) => ({ no: i + 1, text: l }))
  .filter(({ text }) => !/^\s*#/.test(text) && text.trim() !== '');

// ── 1. cd をまたぐ相対 source が無いこと ───────────────────────────────────
const sourceLines = codeLines.filter(({ text }) => /^\s*(\.|source)\s+\S/.test(text));
check('source している行が1つ以上ある（テスト自体の空振り防止）', sourceLines.length > 0, true);

for (const { no, text } of sourceLines) {
  const m = text.match(/^\s*(?:\.|source)\s+"?([^"\s]+)"?/);
  const target = m ? m[1] : '';
  // 絶対パス（/ 始まり）か、変数展開で始まるものだけを許す。
  const isAbsolute = /^(\/|\$\{?[A-Za-z_])/.test(target);
  check(`L${no}: source の参照先が絶対（相対パスは cd で壊れる）: ${target}`, isAbsolute, true);
}

// ── 2. 参照先スクリプトが実在すること ──────────────────────────────────────
for (const { no, text } of sourceLines) {
  const m = text.match(/\$\{RUN_LOOP_DIR\}\/([A-Za-z0-9._-]+)/);
  if (!m) continue;
  check(`L${no}: 参照先 scripts/${m[1]} が実在する`, fs.existsSync(path.join(ROOT, 'scripts', m[1])), true);
}

// ── 3. RUN_LOOP_DIR が最初の cd より前で確定していること ───────────────────
const defIdx = codeLines.findIndex(({ text }) => /^\s*RUN_LOOP_DIR=/.test(text));
const firstCdIdx = codeLines.findIndex(({ text }) => /^\s*cd\s/.test(text));
check('RUN_LOOP_DIR が定義されている', defIdx >= 0, true);
check(
  'RUN_LOOP_DIR は最初の cd より前に確定する',
  defIdx >= 0 && (firstCdIdx < 0 || defIdx < firstCdIdx),
  true,
);
check(
  'RUN_LOOP_DIR は絶対パスへ解決している（BASH_SOURCE基準）',
  /RUN_LOOP_DIR="\$\(cd "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)" && pwd\)"/.test(src),
  true,
);

// ── 4. run-loop.sh を通らない経路も同じ保護を受けること ───────────────────
// learning-enforcer は run-loop.sh を経由しない。実装経路で保護対象を判定すると
// 経路を1本増やした瞬間に保護が外れる（2026-08-20 の loop-self-heal 事故と同型）。
const enforcer = path.join(ROOT, '.github', 'workflows', 'learning-enforcer.yml');
if (fs.existsSync(enforcer)) {
  const y = fs.readFileSync(enforcer, 'utf8');
  const sources = y.match(/^\s*\.\s+\S*ensure-claude-cli\.sh/gm) || [];
  check('learning-enforcer も CLI プローブを source する', sources.length > 0, true);
  for (const s of sources) {
    check(`learning-enforcer の source が絶対パス: ${s.trim()}`, /\$\{?GITHUB_WORKSPACE\}?|^\s*\.\s+\//.test(s), true);
  }
}

console.log(`\nrun-loop-contract-e2e: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
