// pnpm pair — 動いているサーバーに新しいペアリングコード（6桁・10分・1回限り）を出させて表示する。
//
// 自動起動（端末なし）のサーバーはコードを画面に出せないため、この経路を使う。
// - サーバーは起動ごとにランダムな秘密を作り、本人用フォルダの local-admin.json（本人だけが読める権限）に置く。
// - このスクリプトはその秘密を読み、127.0.0.1 の POST /local/pairing-code に付けて送る。
// - ブラウザ（Web ページ・拡張機能）はこのファイルを読めず、Origin 付きの要求はサーバーが拒否する。
// コードはこの端末に表示するだけで、ログ・ファイルには書かない。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_ADMIN_FILE, userDataDirFor } from './user-data-dir.mjs';
import { ROOT } from './lib.mjs';

try {
  process.loadEnvFile(join(ROOT, '.env')); // USER_DATA_DIR を .env で変えている場合のため（既存の環境変数は上書きしない）
} catch {
  /* .env が無い */
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const fail = (msg) => {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
};

const file = join(userDataDirFor(), LOCAL_ADMIN_FILE);
let admin;
try {
  admin = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  fail('サーバーが起動していません → 自動起動を入れていれば PC を再起動、入れていなければ pnpm start で起動してから、もう一度 pnpm pair');
}
if (typeof admin?.secret !== 'string' || !Number.isInteger(admin?.port)) fail('サーバーの情報を読めません → サーバーを再起動してから、もう一度 pnpm pair');
const host = LOOPBACK.has(admin.host) ? (admin.host === '::1' ? '[::1]' : admin.host) : '127.0.0.1';

let res;
try {
  res = await fetch(`http://${host}:${admin.port}/local/pairing-code`, {
    method: 'POST',
    headers: { 'x-zerosys-local-secret': admin.secret },
    signal: AbortSignal.timeout(5000),
  });
} catch {
  fail('サーバーにつながりません（止まっている可能性があります） → PC を再起動するか pnpm start で起動してから、もう一度 pnpm pair');
}
if (res.status === 401) fail('サーバーが入れ替わりました → もう一度 pnpm pair');
if (!res.ok) fail(`コードを出せませんでした（HTTP ${res.status}） → サーバーを再起動してから、もう一度 pnpm pair`);
const body = await res.json().catch(() => null);
if (!body || !/^\d{6}$/.test(body.pairingCode ?? '')) fail('サーバーの応答を確認できません → サーバーを再起動してから、もう一度 pnpm pair');
const mins = Math.max(1, Math.round((body.expiresAt - Date.now()) / 60000));
process.stdout.write(
  `\n  ペアリングコード: ${body.pairingCode}  （${mins}分有効・1回限り）\n  → 拡張機能の設定画面「ペアリングコード」に入力して「ペアリング」\n\n`,
);
