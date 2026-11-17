// 自動起動の見張り役（スタートアップのショートカット → start-hidden.ps1 → これ）。端末なしで動く。
// - サーバー（apps/server, tsx）を子プロセスとして起動し、ログは本人用フォルダの logs\server.log（ローテーションあり）へ。
// - 異常終了したら少し待って再起動（10 分に 5 回落ちたら諦める）。
// - 二重起動しない（pid ファイル・既に /health が応える場合は何もしない）。
// - 会話本文・トークン・キーはここでは扱わない（自分のログには起動/終了と終了コードだけ）。
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nextRestartDelay, PID_FILE, RUNNER_LOG, SERVER_LOG } from './autostart-lib.mjs';
import { ROOT, SERVER_DIR, tsxCli } from './lib.mjs';
import { userDataDirFor } from './user-data-dir.mjs';

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* .env が無い */
}

const dataDir = userDataDirFor();
const pidFile = join(dataDir, PID_FILE);
const runnerLog = join(dataDir, RUNNER_LOG);
mkdirSync(dirname(runnerLog), { recursive: true, mode: 0o700 });

function log(msg) {
  try {
    if (existsSync(runnerLog) && statSync(runnerLog).size > 1024 * 1024) renameSync(runnerLog, `${runnerLog}.1`);
    appendFileSync(runnerLog, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch {
    /* ログを書けなくても動かす */
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

async function serverAlreadyUp() {
  const port = Number(process.env.PORT) || 8787;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

// --- 二重起動の防止
try {
  const old = Number(readFileSync(pidFile, 'utf8').trim());
  if (Number.isInteger(old) && old > 0 && old !== process.pid && alive(old)) {
    log(`already running (pid ${old}); exit`);
    process.exit(0);
  }
} catch {
  /* pid ファイルなし */
}
if (await serverAlreadyUp()) {
  log('server already answers /health (started elsewhere); exit');
  process.exit(0);
}
writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
const cleanup = () => {
  try {
    if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) rmSync(pidFile, { force: true });
  } catch {
    /* ignore */
  }
};

const crashes = [];
let child = null;
let stopping = false;

function startChild() {
  const env = { ...process.env, LOG_FILE: process.env.LOG_FILE || SERVER_LOG };
  child = spawn(process.execPath, [tsxCli(), 'src/index.ts'], { cwd: SERVER_DIR, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  log(`server started (pid ${child.pid})`);
  let errTail = '';
  child.stderr.on('data', (d) => {
    // 起動失敗の理由（設定エラー等。キーは含まれない）だけを短く残す
    errTail = (errTail + d.toString('utf8')).slice(-400);
  });
  child.on('exit', (code, sig) => {
    child = null;
    if (stopping) return;
    log(`server exited (code ${code ?? '-'} signal ${sig ?? '-'})${errTail ? ` stderr: ${errTail.replace(/\s+/g, ' ').trim()}` : ''}`);
    const now = Date.now();
    crashes.push(now);
    const delay = nextRestartDelay(crashes, now);
    if (delay === null) {
      log('server keeps failing; giving up until next logon (see logs/server.log)');
      cleanup();
      process.exit(1);
    }
    setTimeout(startChild, delay);
  });
}

const shutdown = () => {
  stopping = true;
  child?.kill();
  cleanup();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', cleanup);
log(`autostart runner (pid ${process.pid})`);
startChild();
