// pnpm autostart:install / autostart:uninstall / autostart:status
// Windows ログオン時にローカルサーバーを裏で起動する（本人のスタートアップフォルダにショートカットを 1 つ置くだけ）。
// - 管理者権限は不要。タスクスケジューラは使わない（AIOps-* 等のタスクには一切触れない）。
// - 触るファイルは %APPDATA%\...\Startup\ZEROSYS-SalesCopilot-Server.lnk と、本人用フォルダの pid/ログだけ。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LINK_FILE, linkSpec, PID_FILE, RUNNER_LOG, SERVER_LOG, startupDirFor } from './autostart-lib.mjs';
import { ROOT } from './lib.mjs';
import { userDataDirFor } from './user-data-dir.mjs';

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* .env が無い */
}

const cmd = process.argv[2];
const port = Number(process.env.PORT) || 8787;
const dataDir = userDataDirFor();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function waitHealth(want, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await health()) === want) return true;
    await sleep(500);
  }
  return false;
}

function ps(file, args) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'scripts', 'autostart', file), ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function readPid() {
  try {
    const n = Number(readFileSync(join(dataDir, PID_FILE), 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function stopRunner() {
  const pid = readPid();
  if (pid === null) return false;
  // 見張り役とサーバー（子）をまとめて止める
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
  rmSync(join(dataDir, PID_FILE), { force: true });
  return true;
}

function linkPath() {
  const dir = startupDirFor(process.env);
  if (!dir) {
    console.error('APPDATA が見つかりません（Windows の通常のログオンで実行してください）');
    process.exit(1);
  }
  return join(dir, LINK_FILE);
}

if (process.platform !== 'win32') {
  console.error('自動起動は Windows 用です。この PC では pnpm start で起動してください。');
  process.exit(1);
}

if (cmd === 'install') {
  const link = linkPath();
  const spec = linkSpec({ root: ROOT, nodePath: process.execPath, systemRoot: process.env.SystemRoot });
  const r = ps('install-link.ps1', ['-LinkPath', link, '-Target', spec.target, '-Arguments', spec.args, '-WorkDir', spec.workDir, '-Description', spec.description, '-WindowStyle', String(spec.windowStyle)]);
  if (!r.ok || !existsSync(link)) {
    console.error(`自動起動を登録できませんでした。\n${r.out}`);
    process.exit(1);
  }
  console.log('✔ 自動起動を登録しました（次回から PC にサインインすると裏で起動します）');
  if (await health()) {
    console.log('✔ サーバーは既に起動しています（今の起動はそのまま。手で起動した端末を閉じると止まるので、閉じた後は PC 再起動か pnpm autostart:install をもう一度）');
  } else {
    // 今すぐ裏で起動（再起動を待たない）
    spawn(spec.target, spec.argv, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    if (await waitHealth(true, 30_000)) console.log(`✔ サーバーを裏で起動しました（http://127.0.0.1:${port}）`);
    else console.log(`… 起動を確認できませんでした。ログ: ${join(dataDir, RUNNER_LOG)} / ${join(dataDir, SERVER_LOG)}`);
  }
  console.log('\n初めて使う・ペアリングが切れた時だけ: pnpm pair でコードを出して、拡張機能の設定画面に入力');
} else if (cmd === 'uninstall') {
  const link = linkPath();
  rmSync(link, { force: true });
  const stopped = stopRunner();
  if (existsSync(link)) {
    console.error(`ショートカットを消せませんでした: ${link}`);
    process.exit(1);
  }
  console.log('✔ 自動起動を外しました（ペアリング記録は残します。もう一度入れれば再ペアリング不要）');
  if (stopped) console.log((await waitHealth(false, 10_000)) ? '✔ 裏で動いていたサーバーを止めました' : '… サーバーがまだ応答しています（手で起動したものかもしれません）');
} else if (cmd === 'status') {
  const link = linkPath();
  console.log(`自動起動: ${existsSync(link) ? '登録あり' : '登録なし'}`);
  console.log(`サーバー: ${(await health()) ? `起動中（http://127.0.0.1:${port}）` : '止まっています'}`);
  console.log(`ログ: ${join(dataDir, SERVER_LOG)}`);
} else {
  console.error('使い方: pnpm autostart:install | pnpm autostart:uninstall | pnpm autostart:status');
  process.exit(1);
}
