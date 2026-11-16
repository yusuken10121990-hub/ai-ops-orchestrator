// pnpm dev: ローカルサーバー（tsx watch）と拡張機能の監視ビルドを同時に起動する。
// 端末をそのまま渡す（stdio: inherit）ので、サーバーのペアリングコードがこの端末に表示される。
// サーバーはコード変更で再起動し、そのたびに新しいペアリングコードが出る（トークンはメモリのみ＝再ペアリングが必要）。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { EXT_DIR, SERVER_DIR, tsxCli } from './lib.mjs';

const children = [
  spawn(process.execPath, [tsxCli(), 'watch', '--clear-screen=false', 'src/index.ts'], { cwd: SERVER_DIR, stdio: 'inherit' }),
  spawn(process.execPath, [join(EXT_DIR, 'scripts', 'dev.mjs')], { cwd: EXT_DIR, stdio: 'inherit' }),
];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500).unref();
};
for (const c of children) c.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
