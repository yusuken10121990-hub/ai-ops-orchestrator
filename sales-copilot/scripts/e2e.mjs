// pnpm test:e2e — ブラウザ自動化の結合テスト一式。
// 1) 拡張機能 dist が無い／ソースより古ければビルド
// 2) 実サーバー × 実拡張機能の結合テスト（scripts/e2e-integration.mjs）
// 3) モックサーバーでの拡張機能スモーク（apps/extension/scripts/e2e-smoke.mjs: 偽マイク→16kHz フレーム・XSS・ハートビート）
// 4) Meet ポップアップのワンタップ接続（apps/extension/scripts/e2e-meet-popup.mjs: 偽 Meet ページ × モックサーバー）
// 実 API（Deepgram / Anthropic）は呼ばない。
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EXT_DIR, ROOT, runPnpm } from './lib.mjs';

function newestMtime(dir) {
  let t = 0;
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === 'dist') continue;
    const p = join(dir, n);
    const st = statSync(p);
    t = Math.max(t, st.isDirectory() ? newestMtime(p) : st.mtimeMs);
  }
  return t;
}

function needsBuild() {
  const marker = join(EXT_DIR, 'dist', 'manifest.json');
  for (const f of ['capture-worklet.js', 'meet-page.js', 'meet-content.js']) if (!existsSync(join(EXT_DIR, 'dist', f))) return true;
  if (!existsSync(marker)) return true;
  const built = statSync(marker).mtimeMs;
  const sources = Math.max(
    newestMtime(join(EXT_DIR, 'src')),
    newestMtime(join(EXT_DIR, 'public')),
    newestMtime(join(ROOT, 'packages', 'contracts', 'src')),
  );
  return sources > built;
}

function runNode(script) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script], { cwd: ROOT, stdio: 'inherit' });
    c.on('exit', (code) => resolve(code ?? 1));
  });
}

if (needsBuild() || process.argv.includes('--build')) {
  console.log('[e2e] 拡張機能をビルドします（pnpm build）');
  if ((await runPnpm(['build'])) !== 0) process.exit(1);
} else {
  console.log('[e2e] 拡張機能 dist は最新です（ビルド省略。強制する場合は --build）');
}

console.log('\n[e2e] 1/3 実サーバー × 実拡張機能（OFFLINE）');
const a = await runNode(join(ROOT, 'scripts', 'e2e-integration.mjs'));
console.log('\n[e2e] 2/3 拡張機能スモーク（モックサーバー）');
const b = await runNode(join(EXT_DIR, 'scripts', 'e2e-smoke.mjs'));
console.log('\n[e2e] 3/3 Meet ポップアップのワンタップ接続（偽 Meet ページ × モックサーバー）');
const c = await runNode(join(EXT_DIR, 'scripts', 'e2e-meet-popup.mjs'));
const v = (x) => (x === 0 ? 'PASS' : 'FAIL');
console.log(`\n[e2e] integration: ${v(a)} / smoke: ${v(b)} / meet-popup: ${v(c)}`);
process.exit(a === 0 && b === 0 && c === 0 ? 0 : 1);
