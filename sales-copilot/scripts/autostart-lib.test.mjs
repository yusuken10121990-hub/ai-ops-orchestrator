import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTOSTART_NAME, isAscii, LINK_FILE, linkSpec, nextRestartDelay, startupDirFor } from './autostart-lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));

describe('autostart', () => {
  it('all .ps1 files are ASCII-only (Windows PowerShell 5.1 misreads BOM-less UTF-8)', () => {
    const files = readdirSync(join(here, 'autostart')).filter((n) => n.endsWith('.ps1'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) expect(isAscii(readFileSync(join(here, 'autostart', f), 'utf8')), f).toBe(true);
  });

  it('uses only its own name (never AIOps-* tasks) and the per-user Startup folder', () => {
    expect(AUTOSTART_NAME).toBe('ZEROSYS-SalesCopilot-Server');
    expect(LINK_FILE).toBe('ZEROSYS-SalesCopilot-Server.lnk');
    expect(AUTOSTART_NAME.startsWith('AIOps-')).toBe(false);
    expect(startupDirFor({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })).toBe('C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup');
    expect(startupDirFor({})).toBeNull();
    // タスクスケジューラ（schtasks / Register-ScheduledTask）には触れない
    for (const f of ['autostart.mjs', 'autostart-run.mjs']) expect(readFileSync(join(here, f), 'utf8')).not.toMatch(/schtasks|ScheduledTask/i);
    for (const f of readdirSync(join(here, 'autostart'))) expect(readFileSync(join(here, 'autostart', f), 'utf8')).not.toMatch(/schtasks|ScheduledTask/i);
  });

  it('shortcut runs hidden PowerShell → node runner with cwd = sales-copilot; paths with spaces/non-ASCII are quoted args', () => {
    const root = 'C:\\Users\\山田 太郎\\repo\\sales-copilot';
    const s = linkSpec({ root, nodePath: 'C:\\Program Files\\nodejs\\node.exe', systemRoot: 'C:\\Windows' });
    expect(s.target).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(s.workDir).toBe(root);
    expect(s.argv).toContain('Hidden');
    expect(s.argv).toContain(`${root}\\scripts\\autostart-run.mjs`);
    expect(s.args).toContain(`-File "${root}\\scripts\\autostart\\start-hidden.ps1"`);
    expect(s.args).toContain('-Node "C:\\Program Files\\nodejs\\node.exe"');
    expect(s.args).toContain(`-WorkDir "${root}"`);
    expect(s.windowStyle).toBe(7);
  });

  it('restarts a crashed server with backoff and gives up after 5 crashes in 10 minutes', () => {
    const now = 1_000_000_000;
    expect(nextRestartDelay([now], now)).toBe(2000);
    expect(nextRestartDelay([now - 1000, now], now)).toBe(4000);
    expect(nextRestartDelay([now - 4000, now - 3000, now - 2000, now - 1000, now], now)).toBeNull();
    // 古い失敗は数えない（長く動いた後の 1 回はすぐ再起動）
    expect(nextRestartDelay([now - 3_600_000, now - 3_500_000, now], now)).toBe(2000);
  });
});
