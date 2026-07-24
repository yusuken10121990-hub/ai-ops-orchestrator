#!/usr/bin/env node
/**
 * backup-blobs-export.mjs
 *
 * PC完全オフライン化 Batch4 (2026-07-24, dev-integration実装): backup.sh (GH Actions,
 * PCオフでも動くクラウド日次バックアップ) に Netlify Blobs (jobs/enrich-cache/
 * pending-research) のエクスポートを追加する。prior plan P1繰越 (ai-business/backup/
 * local-backup.mjs=PC側は既にBlobsをカバー済みだが、backup.sh=クラウド側は未カバー
 * だったギャップの解消)。
 *
 * 設計(認証情報を複製しない・新規secret不要):
 * research.zerosys.jp には既に backup-export.js という Netlify Function が
 * デプロイ済みで、Supabase/Netlify Blobsの鍵の値をFunction内部だけで使い、
 * 呼び出し側にはJSONだけを返す(local-backup.mjsが `netlify dev` 経由で叩いている
 * のと同じAPI)。本番公開URL経由では ops-dashboard-data.js と同型の
 * `?k=OPS_DASHBOARD_KEY` 認証を使う。OPS_DASHBOARD_KEY は
 * dashboard-sync.yml/health-summary.yml/qa-daily.yml/service-assurance-daily.yml
 * で既に ai-ops-orchestrator の secret として使われているため、**新規secretの
 * オーナー投入は不要**。未設定の場合(何らかの理由でsecretが失われた場合含む)は
 * 安全にskipする(backup.shが呼び出し元でファイル有無を見て status を決める)。
 *
 * Usage:
 *   OPS_DASHBOARD_KEY=... BLOBS_EXPORT_JSON=/path/to/out.json node backup-blobs-export.mjs
 * 出力: BLOBS_EXPORT_JSON に { generatedAt, stores: { jobs: {...}, ... }, counts: {...} } を書く。
 * OPS_DASHBOARD_KEY未設定時は何も書かず終了コード0(skip)。
 */

const BASE_URL = process.env.BACKUP_EXPORT_BASE_URL || 'https://research.zerosys.jp/api/backup-export';
const KEY = process.env.OPS_DASHBOARD_KEY || '';
const OUT_PATH = process.env.BLOBS_EXPORT_JSON || '';
const STORES = ['jobs', 'enrich-cache', 'pending-research'];
const CONCURRENCY = 6;
// 安全弁: 1ストアあたりの取得キー数上限(local-backup.mjsの安全弁と同じ思想。
// jobs storeは11段パイプラインの全出力を含み巨大なため、想定外の増殖で
// GH Actionsの実行時間/releaseサイズが際限なく膨らむことを防ぐ)。
const MAX_KEYS_PER_STORE = 20000;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  return res.json();
}

async function exportStore(store) {
  const keys = [];
  let cursor;
  for (;;) {
    const qs = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const url = `${BASE_URL}?k=${encodeURIComponent(KEY)}&target=blob-keys&store=${store}${qs}`;
    const r = await fetchJson(url);
    keys.push(...(r.keys || []));
    cursor = r.cursor;
    if (!cursor || keys.length >= MAX_KEYS_PER_STORE) break;
  }

  const values = {};
  const errors = [];
  let idx = 0;
  async function worker() {
    while (idx < keys.length) {
      const myIdx = idx++;
      const key = keys[myIdx];
      try {
        const url = `${BASE_URL}?k=${encodeURIComponent(KEY)}&target=blob-value&store=${store}&key=${encodeURIComponent(key)}`;
        const r = await fetchJson(url);
        values[key] = r.value;
      } catch (err) {
        errors.push({ key, error: err.message || String(err) });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(keys.length, 1)) }, worker));
  return { keyCount: keys.length, errorCount: errors.length, values, errors };
}

async function main() {
  if (!KEY) {
    console.log('[backup-blobs-export] OPS_DASHBOARD_KEY not set, skipping (no file written).');
    return;
  }
  if (!OUT_PATH) {
    console.log('[backup-blobs-export] BLOBS_EXPORT_JSON not set, skipping (no file written).');
    return;
  }

  const stores = {};
  const counts = {};
  for (const store of STORES) {
    console.log(`[backup-blobs-export] ${store}: fetching key list...`);
    try {
      const result = await exportStore(store);
      stores[store] = result.values;
      counts[store] = { keys: result.keyCount, errors: result.errorCount };
      console.log(`[backup-blobs-export] ${store}: keys=${result.keyCount} errors=${result.errorCount}`);
    } catch (err) {
      console.error(`[backup-blobs-export] ${store}: FAILED (${err.message || err})`);
      counts[store] = { keys: 0, errors: 1, fatal: err.message || String(err) };
      stores[store] = {};
    }
  }

  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), stores, counts }));
  console.log(`[backup-blobs-export] wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('[backup-blobs-export] unhandled error:', err.message || err);
  // 秘密値をログに出さないためスタックトレースは出さない。file未生成のまま
  // 正常終了扱い(exit 0)にし、呼び出し元backup.shがファイル有無で判定する
  // (DBダンプ系の失敗が他の対象の失敗を道連れにしない設計と揃える)。
  process.exitCode = 0;
});
