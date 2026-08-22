#!/usr/bin/env node
// automation-health-check.mjs
//
// P0 (2026-07-23, dev-devops設計「自動化(定期ループ)自体のヘルス監視」):
// system-health-cloud.yml(systems.json = Webサイト/アプリの死活)とは別に、
// "定期ループそのもの"(ローカルscheduled-tasks + このリポジトリのGitHub Actions
// workflows)が発火し続けているかをクラウド単独で判定する。LLM(Claude)は使わない
// 決定論スクリプト(health-check.mjs/health-summary.mjsと同方針)。
//
// 背景: 2026-07-20〜23、ローカルPCの`claude`CLIログアウトによりローカル実行の
// scheduled-tasks(約15本)が3日間無言で停止したが、これを検知する仕組みがどこにも
// 存在しなかった(監視ループ自体がローカル実行に依存していたため道連れで停止)。
// このスクリプトはクラウドcron単独で完結し、ローカルPCの起動状態に一切依存しない。
//
// データソース:
//   1. ai-ops-config/memory/automation-heartbeat.json
//      -- ローカルの owner-todo-dashboard-sync(毎時)が
//         mcp__scheduled-tasks__list_scheduled_tasks の結果を書き出したもの。
//         このファイル自体の generatedAt が「ローカルCLI/スケジューラの生死」の
//         直接証拠になる(このタスクが動けなければファイルが更新されず古くなる)。
//   2. GitHub Actions API (このリポジトリ自身の .github/workflows/*.yml)
//      -- クラウド実行済みのループ(dashboard-sync/system-health-cloud/seo-daily等)
//         の実行履歴。ハードコードせずAPIで動的列挙する。
//
// 出力: ai-ops-config/memory/automation-health-status.json (台帳。build-dashboard.mjs
// がここから「自動化ヘルス」セクションを動的生成する)。
//
// 終了コードは常に0(監視スクリプト自体の失敗でワークフローを落とすとステータス
// 書き込みが飛ぶため。異常はstatusフィールドで表現する)。

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './read-json.mjs';

const CONFIG_DIR = process.env.CONFIG_DIR || 'config';
const HEARTBEAT_JSON = process.env.HEARTBEAT_JSON || join(CONFIG_DIR, 'memory/automation-heartbeat.json');
const OUTPUT_JSON = process.env.OUTPUT_JSON || join(CONFIG_DIR, 'memory/automation-health-status.json');
const SCHEDULED_TASKS_DIR = process.env.SCHEDULED_TASKS_DIR || join(CONFIG_DIR, 'scheduled-tasks');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY || 'yusuken10121990-hub/ai-ops-orchestrator';

// オーナー指定の閾値(タスクの依頼文どおり): 30分毎系→2h、日次系→26h、週次系→8日。
// 間隔ベースのタスクは "想定間隔の4倍、最低2h" を採用(30分毎の例と整合)。
const HEARTBEAT_STALE_MINUTES = 150; // 毎時45分実行なので通常は<90分。ジッター込みで150分を停止判定閾値にする。
const NEVER_FIRED_GRACE_MINUTES = 24 * 60; // 新規タスクが一度も発火せず24h経過したら「未発火」警告。

// 監視対象の中でも「止まると業務影響が大きい」ものだけP1候補にする(GitHub Issue起票対象)。
// ハードコードだが、この一覧自体は「重大度の定義」であり監視対象一覧そのものはheartbeat.json/
// ワークフロー一覧から動的に読むため、ダッシュボード完全性ルール(台帳からの動的生成)には抵触しない。
//
// 2026-08-05ポストモーテム修正: 'qa-daily'は元々ローカルscheduled-taskとしてここ
// (CRITICAL_LOCAL_TASK_IDS)にcriticalマークされていたが、2026-07-23にGitHub Actions
// クラウドworkflow(.github/workflows/qa-daily.yml)へ移行された際、移行先の
// CRITICAL_CLOUD_WORKFLOW_FILESへcriticalマークが引き継がれなかった。結果、
// qa-daily(cloud)はheartbeatに現れずisSupersededByCloud判定で単なる「移設済み」
// 扱いとなり、8/4-8/5にClaude週次上限で2日連続failureしてもGitHub Issue起票(この
// 監視ループにおける唯一の能動的通知チャネル)が一度も発火しなかった(ダッシュボード上
// には☁️qa-daily failedとして表示はされていたが、59件中16警告に埋もれ、オーナーが
// 本番502で先に気づくまで誰も見なかった)。同じ「ローカル→クラウド移行でcritical
// マークが失われる」構造的リスクはservice-assurance-daily(決済突合)にも該当するため
// 合わせてクラウド側へ移す。move先を追加するだけで、ローカル側のIDは「万一クラウドから
// ローカルへ戻された場合の保険」として残す(isSupersededByCloudが二重発報を防ぐ)。
const CRITICAL_LOCAL_TASK_IDS = new Set([
  'owner-todo-dashboard-sync', // これが止まるとハートビート自体が止まる(全監視の生命線)
  'qa-daily',
  'service-assurance-daily',
  'system-health-monitor',
]);
const CRITICAL_CLOUD_WORKFLOW_FILES = new Set([
  'dashboard-sync', 'system-health-cloud', 'automation-health-cloud', 'backup-daily',
  'qa-daily', 'service-assurance-daily',
  // 2026-08-19追加: 8/18-8/19にClaude週次上限で business-os-daily と広告PDCA 3本が
  // 2日連続で実質未実行になったが、criticalに入っていなかったためこの監視からは
  // 1件もIssueが起票されなかった（#52/#53はbusiness-os-freshness、#49は自動化ヘルスの
  // 別経路）。事業のPDCAそのものを回すループなので、止まったら必ず気づける必要がある。
  'business-os-daily', 'ad-pdca-daily', 'zerosys-ad-pdca', 'zerosys-transport-ads-daily-pdca',
  // loop-self-heal は「上限で落ちた日次ループを取り戻す」復旧ループ。これが止まると
  // 復旧が誰もいなくなるので、監視する側を監視する意味でcriticalに入れる。
  'loop-self-heal',
]);

function nowMs() { return Date.now(); }

function jstLabel(d) {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('T', ' ').slice(0, 16) + ' JST';
}

function ageMinutes(iso, ref = nowMs()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (ref - t) / 60000;
}

// 5フィールドcron("min hour dom mon dow")を簡易分類する。
function classifyCron(cron) {
  if (!cron || typeof cron !== 'string') return { kind: 'unknown', thresholdMinutes: 24 * 60 };
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return { kind: 'unknown', thresholdMinutes: 24 * 60 };
  const [min, , , , dow] = parts;
  const intervalMatch = /^\*\/(\d+)$/.exec(min);
  if (intervalMatch) {
    const intervalMin = parseInt(intervalMatch[1], 10);
    return { kind: 'interval', intervalMinutes: intervalMin, thresholdMinutes: Math.max(intervalMin * 4, 120) };
  }
  if (dow !== '*') {
    return { kind: 'weekly', thresholdMinutes: 8 * 24 * 60 };
  }
  return { kind: 'daily', thresholdMinutes: 26 * 60 };
}

// SKILL.mdの初回コミット日時(git log)を「タスク新設日」の代理指標として使う
// (list_scheduled_tasksにはcreatedAt相当が無いため。dashboard-sync.ymlのfreshness
// チェックと同じ発想: git-log基準の日時を使う)。
function firstCommitAgeMinutes(relPath) {
  try {
    const out = execSync(`git log --diff-filter=A --follow --format=%ct -- "${relPath}"`, {
      cwd: CONFIG_DIR,
      encoding: 'utf8',
    }).trim();
    const lines = out.split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    const firstCommitUnix = parseInt(lines[lines.length - 1], 10) * 1000;
    if (Number.isNaN(firstCommitUnix)) return null;
    return (nowMs() - firstCommitUnix) / 60000;
  } catch {
    return null;
  }
}

async function ghApi(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}`);
  return res.json();
}

async function checkCloudWorkflows() {
  const results = [];
  try {
    const data = await ghApi(`/repos/${REPO}/actions/workflows?per_page=100`);
    const workflows = data.workflows || [];
    for (const wf of workflows) {
      const fileMatch = /\/([^/]+)\.ya?ml$/.exec(wf.path || '');
      const fileId = fileMatch ? fileMatch[1] : wf.name;
      try {
        const runsData = await ghApi(`/repos/${REPO}/actions/workflows/${wf.id}/runs?per_page=1`);
        const runs = runsData.workflow_runs || [];
        if (runs.length === 0) {
          results.push({ id: fileId, name: wf.name, status: 'no-history', lastRunAt: null, url: wf.html_url });
          continue;
        }
        const latest = runs[0];
        const age = ageMinutes(latest.run_started_at);
        let status;
        if (latest.status !== 'completed') status = 'running';
        else if (latest.conclusion !== 'success') status = 'failed';
        else status = 'ok';
        // クラウドworkflowも各自のcron間隔があるはずだが、ここでは一律「26h超で古い」を
        // 汎用フォールバック閾値とする(ほぼ全部が日次〜30分毎で26hより短い間隔のため
        // 見逃しにはならない。厳密な個別閾値が要る場合はhealth-summary.mjs同様に
        // ワークフロー別テーブルを持たせる拡張余地あり)。
        if (status === 'ok' && age !== null && age > 26 * 60) status = 'stale';
        results.push({
          id: fileId,
          name: wf.name,
          status,
          lastRunAt: latest.run_started_at,
          ageMinutes: age,
          conclusion: latest.conclusion,
          url: latest.html_url,
        });
      } catch (e) {
        results.push({ id: fileId, name: wf.name, status: 'unknown', error: e.message });
      }
    }
  } catch (e) {
    results.push({ id: '_fetch_error', name: 'workflow-list', status: 'unknown', error: e.message });
  }
  return results;
}

// ローカルディレクトリはあるがheartbeat(実行中のローカルスケジューラ)に出てこないタスクIDが、
// 既にクラウドworkflowへ移設済み(=ローカル側は登録解除されただけで正常)かを緩い名寄せで判定する。
// 完全一致でなくてもよいように前方一致/包含で見る("team-learning-loop" のローカルIDに対し
// クラウド側workflow名が "team-learning" 等、命名が完全には揃っていないケースが実在するため)。
function isSupersededByCloud(localId, cloudWorkflows) {
  const norm = (s) => s.replace(/-daily$|-loop$/g, '');
  const a = norm(localId);
  return cloudWorkflows.some((w) => {
    const b = norm(w.id);
    return a === b || a.includes(b) || b.includes(a);
  });
}


/* ------------------------------------------------------------------ */
/* heartbeat スキーマの吸収                                            */
/* ------------------------------------------------------------------ */
// 2026-08-23 実測: ローカルPCが書く automation-heartbeat.json の tasks[] は
//   { name:"AIOps-BrowserTaskRunner-Headless", lastRunTime:"2026/08/22 19:47:36",
//     status:"ok", nextRunTime, lastResult }
// というWindowsタスクスケジューラ由来の形をしている。一方このスクリプトは
//   { taskId, cronExpression, lastRunAt, nextRunAt, enabled }
// を読んでいた。つまりBOMを直しても t.taskId は全件 undefined になり、
// 12件が id:undefined のゴミとして台帳へ入るだけだった（監視できていない）。
// 両方の形を受けられるようにここで正規化する。

/** "AIOps-BrowserTaskRunner-Headless" -> "browser-task-runner" */
export function windowsTaskNameToId(name) {
  if (typeof name !== 'string' || !name) return null;
  const core = name.replace(/^AIOps-/, '').replace(/-Headless$/, '').replace(/-/g, '');
  if (!core) return null;
  return core.replace(/(?<=[a-z0-9])(?=[A-Z])/g, '-').toLowerCase();
}

/**
 * "2026/08/22 19:47:36" (ローカルPC=JST表記、タイムゾーン情報なし) を ISO へ。
 * 判別できない形式は null を返す。推測で今の時刻を入れたりしない（FAIL-CLOSED）。
 */
export function parseWindowsLocalTime(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const pad = (v, n = 2) => String(v).padStart(n, '0');
  // オーナー環境はJST固定。ここを推測に頼らせないため明示する。
  const iso = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${mi}:${pad(se || '0')}+09:00`;
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

// Windowsタスクスケジューラが返す実行状態のうち「動いていない」と読むべきもの。
const WINDOWS_BAD_STATUSES = new Set(['not_run_or_terminated', 'nonzero_result', 'failed']);

/**
 * heartbeat.tasks を { taskId, cronExpression, lastRunAt, nextRunAt, enabled,
 * runnerReported } に揃える。
 * 変換できた taskId が scheduled-tasks/ に実在しない場合は「推測でIDを作らない」。
 * unmappedフラグを立てて生の名前のまま残す（FACT SAFETY: 未知値を既知Categoryへ
 * 勝手にマッピングしない）。
 */
export function normalizeHeartbeatTasks(heartbeat, knownTaskIds = new Set()) {
  const raw = (heartbeat && Array.isArray(heartbeat.tasks)) ? heartbeat.tasks : [];
  return raw.map((t) => {
    if (t && typeof t.taskId === 'string' && t.taskId) {
      return { ...t, runnerReported: t.runnerReported ?? t.status ?? null, unmapped: false };
    }
    const derived = windowsTaskNameToId(t?.name);
    const known = derived !== null && knownTaskIds.has(derived);
    return {
      taskId: known ? derived : (t?.name ?? null),
      cronExpression: t?.cronExpression ?? null,
      lastRunAt: parseWindowsLocalTime(t?.lastRunTime) ?? t?.lastRunAt ?? null,
      nextRunAt: parseWindowsLocalTime(t?.nextRunTime) ?? t?.nextRunAt ?? null,
      enabled: t?.enabled,
      runnerReported: t?.status ?? null,
      // scheduled-tasks/ に実体が無い＝Windows専用の保守タスク等。
      // 存在しないIDへ紐付けたことにしない。
      unmapped: !known,
    };
  });
}

export function checkLocalTasks(heartbeat, cloudWorkflows = []) {
  const dirTaskIds = existsSync(SCHEDULED_TASKS_DIR)
    ? readdirSync(SCHEDULED_TASKS_DIR).filter((n) => statSync(join(SCHEDULED_TASKS_DIR, n)).isDirectory())
    : [];
  // heartbeatはローカルPC(Windows)由来の別スキーマで来る。ここで吸収する。
  const tasks = normalizeHeartbeatTasks(heartbeat, new Set(dirTaskIds));
  const heartbeatIds = new Set(tasks.map((t) => t.taskId));

  const results = [];
  for (const t of tasks) {
    // クラウドworkflowへ移設済みのタスクは、ローカルが止まっていて当然。
    // ここを見ないと「移設済みなのにstalled」という逆向きの偽警告が出る。
    if (!t.unmapped && isSupersededByCloud(t.taskId, cloudWorkflows)) {
      results.push({
        id: t.taskId,
        source: 'local',
        status: 'superseded-by-cloud',
        critical: false,
        runnerReported: t.runnerReported ?? null,
        note: '同名/類似名のクラウドworkflowが存在するため、ローカル側の停止は移設済みによる正常な状態と判断',
      });
      continue;
    }
    // heartbeat側はcronを持ってこない（Windowsタスクスケジューラ由来のため）。
    // classifyCron(null) の既定24hをそのまま使うと、07:00実行の日次タスクを
    // 翌07:30に見た瞬間 24.5h > 24h で毎日必ず 'stalled' になる（実測で確認）。
    // オーナー指定の「日次系→26h」に合わせ、cadence不明時は26hの猶予にする。
    // 本当に落ちている場合は runnerReported 側で即座に拾えるので緩めても盲目にならない。
    const cls = t.cronExpression
      ? classifyCron(t.cronExpression)
      : { kind: 'unknown-cadence', thresholdMinutes: 26 * 60 };
    const lastRunAgeMin = ageMinutes(t.lastRunAt);
    let status;
    if (t.enabled === false) {
      status = 'disabled';
    } else if (WINDOWS_BAD_STATUSES.has(String(t.runnerReported))) {
      // ランナー本人が「動いていない」と明示している。
      // 明示Factは推論より上位なので、鮮度計算で上書きしない。
      status = 'stalled';
    } else if (!t.lastRunAt) {
      // 一度も発火していない: SKILL.mdの初回コミットからの経過で「新規で猶予期間内」か
      // 「本当に発火していない異常」かを切り分ける。
      const skillRel = `scheduled-tasks/${t.taskId}/SKILL.md`;
      const createdAgeMin = firstCommitAgeMinutes(skillRel);
      if (createdAgeMin !== null && createdAgeMin > NEVER_FIRED_GRACE_MINUTES) {
        status = 'never-fired';
      } else {
        status = 'new-pending-first-run';
      }
    } else if (lastRunAgeMin !== null && lastRunAgeMin > cls.thresholdMinutes) {
      status = 'stalled';
    } else {
      status = 'ok';
    }
    results.push({
      id: t.taskId,
      source: 'local',
      cronExpression: t.cronExpression,
      classification: cls.kind,
      thresholdMinutes: cls.thresholdMinutes,
      lastRunAt: t.lastRunAt || null,
      ageMinutes: lastRunAgeMin,
      nextRunAt: t.nextRunAt || null,
      enabled: t.enabled !== false,
      status,
      runnerReported: t.runnerReported ?? null,
      unmapped: t.unmapped === true ? true : undefined,
      critical: CRITICAL_LOCAL_TASK_IDS.has(t.taskId),
    });
  }

  // scheduled-tasksディレクトリに存在するが、まだハートビートに一度も現れていないタスク
  // (SKILL新設直後、ローカルのスケジューラにまだ登録認識されていない可能性)。
  for (const dirId of dirTaskIds) {
    if (!heartbeatIds.has(dirId)) {
      if (isSupersededByCloud(dirId, cloudWorkflows)) {
        // クラウドworkflowへ移設済みでローカル登録が外れているだけ(正常)。アラーム対象にしない。
        results.push({
          id: dirId,
          source: 'local',
          status: 'superseded-by-cloud',
          critical: false,
          note: '同名/類似名のクラウドworkflowが存在するため、ローカル未登録は移設済みによる正常な状態と判断',
        });
        continue;
      }
      const createdAgeMin = firstCommitAgeMinutes(`scheduled-tasks/${dirId}/SKILL.md`);
      results.push({
        id: dirId,
        source: 'local',
        cronExpression: null,
        classification: 'unknown',
        thresholdMinutes: null,
        lastRunAt: null,
        ageMinutes: null,
        nextRunAt: null,
        enabled: null,
        status: (createdAgeMin !== null && createdAgeMin > NEVER_FIRED_GRACE_MINUTES) ? 'never-fired' : 'new-pending-first-run',
        critical: CRITICAL_LOCAL_TASK_IDS.has(dirId),
        note: 'scheduled-tasks/配下にSKILL.mdはあるが、まだheartbeatのtask一覧に出現していない',
      });
    }
  }
  return results;
}

async function upsertGithubIssue({ title, bodyLines, stale }) {
  if (!GITHUB_TOKEN) return;
  try {
    const list = await ghApi(
      `/repos/${REPO}/issues?state=open&per_page=50&labels=automation-health`
    ).catch(() => ({ items: [] }));
    const issues = Array.isArray(list) ? list : [];
    const existing = issues.find((i) => i.title === title);

    if (stale) {
      if (!existing) {
        await fetch(`https://api.github.com/repos/${REPO}/issues`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({ title, body: bodyLines.join('\n'), labels: ['automation-health'] }),
        });
        console.log(`[automation-health] filed issue: ${title}`);
      } else {
        console.log(`[automation-health] existing open issue #${existing.number}, skip duplicate`);
      }
    } else if (existing) {
      await fetch(`https://api.github.com/repos/${REPO}/issues/${existing.number}/comments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ body: '復旧を検知したため自動クローズします。' }),
      });
      await fetch(`https://api.github.com/repos/${REPO}/issues/${existing.number}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ state: 'closed' }),
      });
      console.log(`[automation-health] closed recovered issue #${existing.number}`);
    }
  } catch (e) {
    console.log(`[automation-health] issue upsert failed (non-fatal): ${e.message}`);
  }
}

async function main() {
  const generatedAt = new Date();

  let heartbeat = null;
  let heartbeatError = null;
  if (existsSync(HEARTBEAT_JSON)) {
    try {
      // BOM耐性必須: この heartbeat はローカルWindows側が書くためBOM付きになる。
      // 2026-08-23、素のJSON.parseがBOMで落ち、localRunner監視が盲目になり
      // ローカルタスク9件が偽の 'never-fired' になっていた。
      heartbeat = readJson(HEARTBEAT_JSON);
    } catch (e) {
      heartbeatError = e.message;
    }
  } else {
    heartbeatError = 'file-not-found';
  }

  const hbAge = heartbeat ? ageMinutes(heartbeat.generatedAt, generatedAt.getTime()) : null;
  let localRunnerStatus;
  if (!heartbeat) localRunnerStatus = 'unknown';
  else if (hbAge === null) localRunnerStatus = 'unknown';
  else if (hbAge > HEARTBEAT_STALE_MINUTES) localRunnerStatus = 'stale';
  else localRunnerStatus = 'ok';

  const localRunner = {
    status: localRunnerStatus,
    lastHeartbeatAt: heartbeat?.generatedAt || null,
    ageMinutes: hbAge,
    thresholdMinutes: HEARTBEAT_STALE_MINUTES,
    error: heartbeatError,
  };

  const cloudWorkflows = await checkCloudWorkflows();
  const localTasks = checkLocalTasks(heartbeat, cloudWorkflows);

  // 注意(2026-07-23): 'never-fired'/'new-pending-first-run' はlastRunAtがそもそも
  // 記録されていないケースであり、既知の表示不整合(qa-daily SKILL.md 3.8/3.86に記載の
  // 「nextRunAtは前進するがlastRunAtが記録されない」不具合)による偽陽性の可能性がある。
  // 確度が高いのは実際にlastRunAtが記録済みで、かつ閾値を超えて更新されていない'stalled'
  // のみなので、GitHub Issue起票(通知)は'stalled'のみをトリガーにする。'never-fired'は
  // ダッシュボードに参考情報として出すに留め、誤報でオーナーを疲弊させない。
  const criticalLocalStalled = localTasks.filter((t) => t.critical && t.status === 'stalled');
  const criticalCloudFailed = cloudWorkflows.filter(
    (w) => CRITICAL_CLOUD_WORKFLOW_FILES.has(w.id) && (w.status === 'failed' || w.status === 'stale' || w.status === 'no-history')
  );
  const allWarnLocal = localTasks.filter((t) => t.status === 'stalled' || t.status === 'never-fired');

  const isCritical = localRunner.status === 'stale' || criticalLocalStalled.length > 0 || criticalCloudFailed.length > 0;

  const status = {
    generatedAt: generatedAt.toISOString(),
    generatedAtJst: jstLabel(generatedAt),
    localRunner,
    localTasks,
    cloudWorkflows,
    knownLimitations: [
      "status='never-fired'/'new-pending-first-run'はlastRunAt欠落による判定で、既知の表示不整合(nextRunAtは前進するがlastRunAtが記録されないバグ、qa-daily SKILL.md 3.8/3.86参照)により誤検知しうる。確度が高いのはstatus='stalled'(実際に記録されたlastRunAtが閾値超過)のみ。",
      "cloudWorkflowsのstatus='failed'は『直近1回の実行結果』のみで原因(Claude週次上限到達か、コード側バグか)までは区別しない。原因切り分けは `gh run view <id> --log-failed` を人間/エージェントが実施する。qa-daily失敗時のAPI層フォールバックはsystems.jsonのapiProbes(health-check.mjs、system-health-cloud.yml、LLM不使用・30分毎)が独立に担保する(2026-08-05追加)。",
    ],
    summary: {
      localTaskCount: localTasks.length,
      localTaskWarnCount: allWarnLocal.length,
      cloudWorkflowCount: cloudWorkflows.length,
      cloudWorkflowFailCount: cloudWorkflows.filter((w) => w.status === 'failed' || w.status === 'stale' || w.status === 'no-history').length,
      criticalNow: isCritical,
    },
  };

  writeFileSync(OUTPUT_JSON, JSON.stringify(status, null, 2) + '\n');
  console.log(`[automation-health] wrote ${OUTPUT_JSON}`);
  console.log(`localRunner=${localRunner.status}(age=${hbAge?.toFixed(1)}min) localTasks: ok=${localTasks.filter(t=>t.status==='ok').length} warn=${allWarnLocal.length} cloudWorkflows: ok=${cloudWorkflows.filter(w=>w.status==='ok').length}/${cloudWorkflows.length}`);

  const title = '[自動化ヘルス] ローカルscheduled-tasks または重要クラウドループが停滞しています';
  const bodyLines = [
    `検知時刻(JST): ${status.generatedAtJst}`,
    '',
    `- ローカルランナー(heartbeat): ${localRunner.status} (最終更新から${localRunner.ageMinutes?.toFixed(0) ?? '?'}分, 閾値${localRunner.thresholdMinutes}分)`,
    ...(localRunner.status === 'stale' ? ['  -> オーナーTODO `claude-cli-local-relogin` を確認してください(端末で `claude setup-token` を再実行)。'] : []),
    ...criticalLocalStalled.map((t) => `- ローカルタスク停滞: ${t.id} (最終実行から${t.ageMinutes?.toFixed(0) ?? '不明'}分, 閾値${t.thresholdMinutes}分, status=${t.status})`),
    ...criticalCloudFailed.map((w) => `- クラウドworkflow異常: ${w.id} (status=${w.status}, ${w.url || ''})`),
    '',
    '復旧を検知すると次回実行時に自動クローズされます。',
  ];
  await upsertGithubIssue({ title, bodyLines, stale: isCritical });
}

// 直接実行されたときだけ走らせる。
// import しただけで main() が動くと、adapter関数の単体テストが
// 本番台帳を書きに行って失敗する（2026-08-23 の回帰テスト追加時に判明）。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[automation-health] fatal (non-blocking, exiting 0):', e);
  });
}
