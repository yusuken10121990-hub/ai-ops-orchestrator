#!/usr/bin/env node
// health-check.mjs
//
// P0-1 (2026-07-18, CTO設計「保守運用組織の24/7/365拡張」): 死活監視のクラウド化。
// LLM(Claude)を一切使わない決定論スクリプト。理由: 30分毎の単純なHTTP監視に
// トークンを使うのはコスト/信頼性(モデルのブレ)の両面で無駄。health-summary.mjs
// と同じ「Claude不使用でNode/shellのみ」の方針を踏襲する。
//
// P1-② (2026-07-20, 監視チーム再設計「誤検知対策」design-monitoring-team-20260720.md):
//   1. リトライ間隔を2秒→20-30秒(ランダム)に拡大。ok判定は初回成功で確定、ng判定は
//      「初回失敗→20-30秒後の2回目も失敗」の場合のみ(瞬断を拾わない)。
//   2. プロバイダ一斉失敗ヒューリスティック: systems.jsonのdeploy値(railway-up/
//      railway-gitは"railway"に集約)でグルーピングし、同一プロバイダで2件以上ng
//      かつ他の全プロバイダが全okの場合、そのプロバイダ側の一時的な問題(プローブ
//      からの経路障害等)を疑い、30秒待って3回目の確認を行う。3回目も失敗した
//      システムのみ status:"ng" のまま suspect:"provider-wide" を付与する
//      (誤検知ではなく「個別障害ではなさそう」という注記。アラート抑制は§4の
//      ポリシー側で行う想定でここでは判定のみ)。
//
// やること:
//   1. ai-ops-config(private, checkout済み)の memory/systems.json から
//      status:"live" を全件読み、localhost系(kind:gate含む)は監視対象外として除外。
//   2. healthPath があるものは HTTP(S) fetch(15s timeout, 失敗/非2xx/marker不一致は
//      1回だけリトライ)。healthPath が空("")のものはHTTPでなく GitHub Actions の
//      実行履歴で「死活」を代替判定する(例: ai-ops-orchestrator自体はHTTPで
//      叩けるエンドポイントを持たないため。_deploy_note の "GitHub: owner/repo"
//      から репо slugを抽出して直近runの有無で判定。抽出できなければ skipped)。
//   3. 結果を memory/health-status.json(ai-ops-config)に書く。既存ファイルを
//      読み込み、システムごとの last_remediate_at(P0-2が使う夜間一次対応の
//      1時間クールダウン用タイムスタンプ)は保持したままマージする
//      (このスクリプトは remediate 実行主体ではないので、その欄は上書きしない)。
//   4. P1判定(ホワイトリスト対象のみ・fuu/jobqueue-gate/ads-ops-backend)に
//      該当したら safe-remediate.sh を1システムにつき1時間1回まで呼び出す
//      (呼び出し自体は system-health-cloud.yml のワークフロー側が行う。この
//      スクリプトは判定結果を SHOULD_REMEDIATE=<id> 行としてstdoutに出し、
//      呼び出し可否(1時間クールダウン)もこのスクリプトが判定してから知らせる)。
//
// 使い方:
//   SYSTEMS_JSON=config/memory/systems.json \
//   HEALTH_STATUS_JSON=config/memory/health-status.json \
//   node scripts/health-check.mjs
//
// 終了コードは常に0(監視スクリプトが落ちてワークフロー全体を失敗させると
// health-status.jsonへの書き込み自体が飛ぶため。個々の失敗はstatus:"ng"で表現)。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SYSTEMS_JSON = process.env.SYSTEMS_JSON || 'config/memory/systems.json';
const HEALTH_STATUS_JSON = process.env.HEALTH_STATUS_JSON || 'config/memory/health-status.json';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // optional, raises GH API rate limit
const REMEDIATE_COOLDOWN_MS = 60 * 60 * 1000; // 1時間1回まで(P0-2要件)
const FETCH_TIMEOUT_MS = 15000;
const PROVIDER_WIDE_RECHECK_WAIT_MS = 30000; // 3回目確認前の待機(30秒)

// 20-30秒のランダム間隔(2連続失敗のみngにするための再確認待ち)
function retryWaitMs() {
  return 20000 + Math.floor(Math.random() * 10000);
}

// systems.jsonのdeploy値からプロバイダを抽出(railway-up/railway-gitは同一プロバイダとして集約)
function mapProvider(deploy) {
  if (!deploy) return 'unknown';
  if (deploy.startsWith('railway')) return 'railway';
  return deploy;
}

// P0-2: 夜間自動一次対応の対象(Railway系のみ・safe-remediate.shのwhitelistと一致させること)
const REMEDIATE_WHITELIST = new Set(['fuu', 'jobqueue-gate', 'ads-ops-backend']);

function jstNow() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' JST';
}

function isLocalhost(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function targetUrl(sys) {
  if (!sys.healthPath) return sys.url;
  try {
    // healthPath は同一オリジンの絶対パスとして解決する(相対URL解決を利用)
    return new URL(sys.healthPath, sys.url).href;
  } catch {
    return sys.url;
  }
}

async function httpCheckOnce(url, marker) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const http = res.status;
    let markerOk = true;
    if (marker) {
      const body = await res.text().catch(() => '');
      markerOk = body.includes(marker);
    }
    const ok = http >= 200 && http < 300 && markerOk;
    return { ok, http, markerOk };
  } catch (e) {
    return { ok: false, http: null, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function httpCheckWithRetry(url, marker) {
  let result = await httpCheckOnce(url, marker);
  if (!result.ok) {
    // 誤検知対策①: 瞬断を拾わないよう20-30秒空けてから2回目を確認。
    // 2回目も失敗した場合のみ最終的にngとなる(初回成功はここに来ない=即ok確定)。
    await new Promise((r) => setTimeout(r, retryWaitMs()));
    result = await httpCheckOnce(url, marker);
  }
  return result;
}

function extractGhRepoSlug(sys) {
  const note = sys._deploy_note || '';
  const m = note.match(/GitHub:\s*([\w.-]+\/[\w.-]+)/);
  return m ? m[1] : null;
}

// 2026-07-21 fix: 哨戒B(sentinel-b)誤検知対策。
// 従来は「healthPathが空」を一律ghActionsCheckに流していたため、healthPathが空だが
// HTTPで叩ける哨戒Bのsentinel-status(JSON)まで誤ってGitHub Actions実行履歴判定に
// 回してしまい、対象repoがsales-research-tool(private/gh-actionsを使っていない)のため
// gh-api-404 -> status:"skipped" になりダッシュボードで異常表示される誤検知が発生した。
// 恒久対策: systems.jsonにhealthMethodフィールドを明示させ、"sentinel-json"の場合は
// そのURLをGETしてJSON本文のwired/age_minutesで生死判定する専用チェックに分岐する。
async function sentinelJsonCheck(sys) {
  const staleMinutes = typeof sys.healthStaleMinutes === 'number' ? sys.healthStaleMinutes : 20;
  try {
    const res = await fetch(sys.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      return { status: 'ng', reason: `http-${res.status}` };
    }
    const body = await res.json();
    if (body.wired !== true) {
      return { status: 'ng', reason: 'wired-false-or-missing' };
    }
    if (typeof body.age_minutes !== 'number') {
      return { status: 'ng', reason: 'age_minutes-missing' };
    }
    if (body.age_minutes > staleMinutes) {
      return { status: 'ng', reason: `age_minutes=${body.age_minutes}(しきい値${staleMinutes}分超)` };
    }
    return { status: 'ok', age_minutes: body.age_minutes, checked_count: body.checked_count };
  } catch (e) {
    return { status: 'ng', reason: `error:${e.message}` };
  }
}

async function ghActionsCheck(sys) {
  const slug = extractGhRepoSlug(sys);
  if (!slug) {
    return { status: 'skipped', reason: 'no-gh-repo-slug-in-_deploy_note' };
  }
  try {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    const res = await fetch(`https://api.github.com/repos/${slug}/actions/runs?per_page=5`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { status: 'skipped', reason: `gh-api-${res.status}` };
    const data = await res.json();
    const runs = data.workflow_runs || [];
    if (runs.length === 0) return { status: 'skipped', reason: 'no-run-history' };
    const anyRecentSuccess = runs.some((r) => r.conclusion === 'success');
    const latest = runs[0];
    const ranAgoH = (Date.now() - new Date(latest.run_started_at).getTime()) / 3600000;
    if (ranAgoH > 48) {
      return { status: 'ng', reason: `latest run ${ranAgoH.toFixed(1)}h ago(48h超)`, url: latest.html_url };
    }
    return { status: anyRecentSuccess ? 'ok' : 'ng', url: latest.html_url };
  } catch (e) {
    return { status: 'skipped', reason: `error:${e.message}` };
  }
}

async function main() {
  if (!existsSync(SYSTEMS_JSON)) {
    console.error(`ERROR: SYSTEMS_JSON not found at ${SYSTEMS_JSON}`);
    return;
  }
  const catalog = JSON.parse(readFileSync(SYSTEMS_JSON, 'utf8'));
  const all = catalog.systems || [];

  let prev = {};
  if (existsSync(HEALTH_STATUS_JSON)) {
    try {
      prev = JSON.parse(readFileSync(HEALTH_STATUS_JSON, 'utf8')).systems || {};
    } catch {
      prev = {};
    }
  }

  const targets = all.filter((s) => s.status === 'live' && !isLocalhost(s.url));

  const out = {};
  const remediateCandidates = [];

  for (const sys of targets) {
    const prevEntry = prev[sys.id] || {};
    let entry;

    if (sys.healthMethod === 'sentinel-json') {
      // 2026-07-21 fix: 哨戒B等、healthPathは空だがHTTPでJSON取得しage_minutes/wiredで
      // 判定すべきシステム専用の分岐(誤ってgh-actions判定に落ちないよう明示的に先に処理する)
      const r = await sentinelJsonCheck(sys);
      entry = {
        status: r.status,
        method: 'sentinel-json',
        reason: r.reason,
        age_minutes: r.age_minutes,
        checked_count: r.checked_count,
        url: sys.url,
        checked_at: jstNow(),
      };
    } else if (!sys.healthPath) {
      // HTTPで叩けないシステム(gh-actions駆動のバックエンド等)はGH Actions実行履歴で代替判定
      const r = await ghActionsCheck(sys);
      entry = {
        status: r.status,
        method: 'gh-actions',
        reason: r.reason,
        url: r.url || sys.url,
        checked_at: jstNow(),
      };
    } else {
      const url = targetUrl(sys);
      const result = await httpCheckWithRetry(url, sys.marker);
      entry = {
        status: result.ok ? 'ok' : 'ng',
        method: 'http',
        http: result.http ?? null,
        url,
        checked_at: jstNow(),
      };
      if (sys.marker) entry.marker = sys.marker;
      if (result.error) entry.error = result.error;
      if (sys.marker && result.http != null && result.http >= 200 && result.http < 300 && !result.markerOk) {
        entry.reason = 'marker-missing';
      }
    }

    // last_remediate_at は safe-remediate側だけが更新する欄。健全性チェック側では保持のみ。
    if (prevEntry.last_remediate_at) entry.last_remediate_at = prevEntry.last_remediate_at;

    out[sys.id] = entry;

    // P0-2: P1判定(ホワイトリスト対象のみ) = ng かつ (http>=500 または marker欠落)
    if (
      REMEDIATE_WHITELIST.has(sys.id) &&
      entry.status === 'ng' &&
      ((entry.http != null && entry.http >= 500) || entry.reason === 'marker-missing')
    ) {
      const lastAt = entry.last_remediate_at ? new Date(entry.last_remediate_at).getTime() : 0;
      const cooldownOk = Date.now() - lastAt > REMEDIATE_COOLDOWN_MS;
      if (cooldownOk) {
        remediateCandidates.push(sys.id);
      } else {
        console.log(`[health-check] ${sys.id}: P1条件に該当だがクールダウン中のためskip`);
      }
    }
  }

  // 誤検知対策②: プロバイダ一斉失敗ヒューリスティック
  // (method:'http'のシステムのみ対象。gh-actions判定のものは除く)
  const providerGroups = {};
  for (const sys of targets) {
    if (!sys.healthPath) continue;
    const provider = mapProvider(sys.deploy);
    providerGroups[provider] = providerGroups[provider] || { ids: [] };
    providerGroups[provider].ids.push(sys.id);
  }
  const providerNames = Object.keys(providerGroups);
  const suspectIds = [];
  if (providerNames.length > 1) {
    for (const provider of providerNames) {
      const ngIdsInProvider = providerGroups[provider].ids.filter((id) => out[id].status === 'ng');
      if (ngIdsInProvider.length < 2) continue;
      const othersAllOk = providerNames
        .filter((p) => p !== provider)
        .every((p) => providerGroups[p].ids.every((id) => out[id].status !== 'ng'));
      if (othersAllOk) suspectIds.push(...ngIdsInProvider);
    }
  }
  if (suspectIds.length > 0) {
    console.log(
      `[health-check] provider-wide suspect検知(${suspectIds.join(',')}): ${PROVIDER_WIDE_RECHECK_WAIT_MS / 1000}秒後に3回目確認`
    );
    await new Promise((r) => setTimeout(r, PROVIDER_WIDE_RECHECK_WAIT_MS));
    for (const id of suspectIds) {
      const sys = targets.find((s) => s.id === id);
      if (!sys) continue;
      const url = targetUrl(sys);
      const recheck = await httpCheckOnce(url, sys.marker);
      if (recheck.ok) {
        out[id].status = 'ok';
        out[id].note = 'recovered-on-3rd-check(provider-wide-suspect)';
        delete out[id].reason;
      } else {
        out[id].suspect = 'provider-wide';
      }
    }
  }

  const anyNg = Object.values(out).some((e) => e.status === 'ng');
  const result = {
    checked_at: jstNow(),
    overall: anyNg ? 'degraded' : 'ok',
    systems: out,
  };

  mkdirSync(dirname(HEALTH_STATUS_JSON), { recursive: true });
  writeFileSync(HEALTH_STATUS_JSON, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`[health-check] wrote ${HEALTH_STATUS_JSON} (${targets.length} systems checked, overall=${result.overall})`);

  // ワークフロー側がP0-2のremediateステップで拾えるよう、機械可読な行を出力する
  for (const id of remediateCandidates) {
    console.log(`SHOULD_REMEDIATE=${id}`);
  }
}

main().catch((e) => {
  console.error('[health-check] unexpected error (non-fatal, no write):', e);
});
