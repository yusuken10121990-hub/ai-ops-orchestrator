// ビルド成果物の自己検査: manifest の参照先が存在する／権限が最小限／worklet が単一ファイル／
// 配布物に秘密情報らしき文字列や innerHTML 系の描画が混入していない（SPEC §14, §16-1 #15）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const fail = (m) => {
  console.error(`check-dist: ${m}`);
  process.exit(1);
};

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
for (const f of [manifest.background.service_worker, manifest.options_page, 'copilot.html', 'offscreen.html', 'capture-worklet.js']) {
  if (!existsSync(join(dist, f))) fail(`missing ${f}`);
}
const allowedPerms = new Set(['tabCapture', 'offscreen', 'storage', 'activeTab']);
for (const p of manifest.permissions) if (!allowedPerms.has(p)) fail(`unexpected permission ${p}`);
for (const h of manifest.host_permissions) if (!/^http:\/\/(127\.0\.0\.1|localhost)\/\*$/.test(h)) fail(`unexpected host permission ${h}`);
if (JSON.stringify(manifest).includes('<all_urls>')) fail('<all_urls> is not allowed');

const worklet = readFileSync(join(dist, 'capture-worklet.js'), 'utf8');
if (/^\s*import\s/m.test(worklet)) fail('worklet must be a single file without imports');
if (!worklet.includes("registerProcessor('sales-copilot-capture'") && !worklet.includes('registerProcessor("sales-copilot-capture"'))
  fail('worklet does not register processor');

const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(dist);
const secret = /(sk-ant-[A-Za-z0-9_-]{10,}|DEEPGRAM_API_KEY\s*=\s*\S+|ANTHROPIC_API_KEY\s*=\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
for (const f of files) {
  if (!/\.(js|html|json|css)$/.test(f)) continue;
  const s = readFileSync(f, 'utf8');
  if (secret.test(s)) fail(`secret-like string in ${f}`);
}
// アプリコード（React 本体を除く）で dangerouslySetInnerHTML を使っていないこと
for (const f of files) {
  if (!f.endsWith('.js')) continue;
  const s = readFileSync(f, 'utf8');
  if (/dangerouslySetInnerHTML:\s*\{/.test(s)) fail(`dangerouslySetInnerHTML used in ${f}`);
}
console.log(`check-dist: OK (${files.length} files)`);
