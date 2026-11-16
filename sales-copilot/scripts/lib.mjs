// ルートスクリプト共通の小物（Windows でも動くよう、pnpm.cmd ではなく node で直接起動する）。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_DIR = join(ROOT, 'apps', 'server');
export const EXT_DIR = join(ROOT, 'apps', 'extension');

/** apps/server の依存として入っている tsx の CLI。 */
export function tsxCli() {
  return createRequire(join(SERVER_DIR, 'package.json')).resolve('tsx/cli');
}

/** pnpm を実行（Windows は pnpm.cmd のためシェル経由）。終了コードを返す。 */
export function runPnpm(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32', ...opts });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}
