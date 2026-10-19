// 2026-10-19: security-daily.mjs shipped with its Japanese regex literals turned into
// Shift_JIS mojibake (UTF-8 re-saved through a cp932 shell), which silently broke the
// "管理"/"ログイン" checks. Fail fast if any script/workflow contains that pattern again.
// Detects the tell-tale cp932-decoded UTF-8 lead sequences (e.g. 繝 縺 邂 譁) plus the
// half-width katakana / "・" debris they leave behind.
import fs from 'node:fs';
import path from 'node:path';

const roots = ['scripts', '.github/workflows'];
const MOJIBAKE = /[繝縺邂譁蜿驕螳髢蛻][｡-ﾟ・]|[｡-ﾟ]{2,}/;
const bad = [];
for (const r of roots) {
  if (!fs.existsSync(r)) continue;
  for (const f of fs.readdirSync(r)) {
    if (!/\.(mjs|js|sh|yml|yaml|ps1)$/.test(f)) continue;
    const p = path.join(r, f);
    fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => { if (MOJIBAKE.test(l)) bad.push(`${p}:${i + 1}`); });
  }
}
if (bad.length) {
  console.error(`[check-no-mojibake] ${bad.length} suspicious line(s):\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.log('[check-no-mojibake] ok');
