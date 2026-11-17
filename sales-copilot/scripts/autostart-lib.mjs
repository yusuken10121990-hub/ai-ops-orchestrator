// 自動起動（Windows ログオン時にサーバーを裏で起動）の純粋な部品。副作用なし（テスト対象）。
import { join, win32 } from 'node:path';

export const AUTOSTART_NAME = 'ZEROSYS-SalesCopilot-Server';
export const LINK_FILE = `${AUTOSTART_NAME}.lnk`;
export const PID_FILE = 'autostart.pid';
export const SERVER_LOG = join('logs', 'server.log');
export const RUNNER_LOG = join('logs', 'autostart.log');

/** 本人のスタートアップフォルダ（%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup）。管理者権限は不要。 */
export function startupDirFor(env) {
  const appData = env.APPDATA?.trim();
  if (!appData) return null;
  return win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/**
 * スタートアップのショートカットの中身。PowerShell を最小化＋Hidden で起動し、start-hidden.ps1 が
 * node（autostart-run.mjs）をウィンドウ無しで起動する。パスは引数で渡すので .ps1 自体は ASCII のまま。
 */
export function linkSpec({ root, nodePath, systemRoot }) {
  const ps = win32.join(systemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const launcher = win32.join(root, 'scripts', 'autostart', 'start-hidden.ps1');
  const runner = win32.join(root, 'scripts', 'autostart-run.mjs');
  const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', launcher, '-Node', nodePath, '-Runner', runner, '-WorkDir', root];
  return {
    target: ps,
    /** 直接起動する用（node の spawn）。 */
    argv,
    /** ショートカットに書く用（空白を含むパスは "" で囲む）。 */
    args: argv.map((a) => (a.startsWith('-') ? a : `"${a}"`)).join(' '),
    workDir: root,
    description: 'ZEROSYS Sales Copilot local server (127.0.0.1 only)',
    /** 7 = 最小化（Hidden にできるまでの一瞬もタスクバーに出にくくする）。 */
    windowStyle: 7,
  };
}

/**
 * 異常終了したときの再起動の間隔。直近 10 分に 5 回落ちていたら諦める（null）。
 * 正常に長く動いたあとの 1 回の失敗はすぐ（2 秒）再起動する。
 */
export function nextRestartDelay(crashTimes, now, { windowMs = 10 * 60 * 1000, max = 5 } = {}) {
  const recent = crashTimes.filter((t) => now - t < windowMs);
  if (recent.length >= max) return null;
  return Math.min(60_000, 2000 * 2 ** Math.max(0, recent.length - 1));
}

/** 文字列が ASCII だけか（Windows PowerShell 5.1 は BOM なし UTF-8 の .ps1 を誤読するため、.ps1 は ASCII に限る）。 */
export function isAscii(s) {
  return /^[\x00-\x7F]*$/.test(s);
}
