#!/usr/bin/env node
// gbp-fetch-reviews.mjs
//
// dev-integration (2026-07-23)。Google Business Profile API (My Business API v4
// reviews エンドポイント) で契約店舗の口コミを取得し、未返信のテキストレビューを
// memory/meo-review-queue.json に書き出す決定論スクリプト(LLM不使用、返信文の
// 生成はこのスクリプトの責務外。次の段=headless Claude(meo-review-api-reply
// SKILL)が読んで返信文を書く二段構成。理由: 「店舗のトーンに沿った個別返信」は
// 人間相当の判断が要り、機械的なテンプレ化を meo-review-daily の仕様が禁止して
// いるため、その方針をAPI化後も維持する)。
//
// 前提(現状は工9=Business Profile API審査待ちのため未稼働。審査通過後に
// 有効化する。エンドポイントは執筆時点でGoogleが案内する mybusiness.googleapis.com
// v4 reviews系を使用。Google側でAPI移行があった場合はこのファイルの
// REVIEWS_API_BASE を最新のものに差し替えること):
//   - clients/*.json の locations[] に "connect_mode": "api" と
//     "gbp_account_id" / "gbp_location_id" が入っていること
//     (現状は "existing_owner_session" のみ=claude-in-chrome運用。API審査
//     通過後、customer-success/dev-integrationがこの2フィールドを追記して
//     初めてこのスクリプトの対象になる=既存の全店舗は無変更で安全に共存)。
//
// 環境変数:
//   GBP_CLIENT_ID / GBP_CLIENT_SECRET / GBP_REFRESH_TOKEN (未設定なら即skip終了)
//   CLIENTS_DIR (既定: ai-business/campaigns/_internal/camp_c7faa7c45e/clients)
//   QUEUE_JSON  (既定: config/memory/meo-review-queue.json)

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { getGoogleAccessToken, hasGoogleCreds } from './google-oauth.mjs';

const REVIEWS_API_BASE = 'https://mybusiness.googleapis.com/v4';

const CLIENTS_DIR = process.env.CLIENTS_DIR
  || 'ai-business/campaigns/_internal/camp_c7faa7c45e/clients';
const QUEUE_JSON = process.env.QUEUE_JSON || 'config/memory/meo-review-queue.json';

function loadActiveApiClients() {
  if (!existsSync(CLIENTS_DIR)) return [];
  const files = readdirSync(CLIENTS_DIR).filter((f) => f.endsWith('.json'));
  const out = [];
  for (const f of files) {
    const full = path.join(CLIENTS_DIR, f);
    const client = JSON.parse(readFileSync(full, 'utf8'));
    if (client.status !== 'active') continue;
    const apiLocations = (client.locations || []).filter(
      (l) => l.connect_mode === 'api' && l.gbp_account_id && l.gbp_location_id,
    );
    if (apiLocations.length === 0) continue;
    out.push({ file: full, client, apiLocations });
  }
  return out;
}

async function fetchReviews(token, accountId, locationId) {
  const url = `${REVIEWS_API_BASE}/accounts/${accountId}/locations/${locationId}/reviews?pageSize=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const text = await res.text();
    // 失敗ゼロトレランス・ルール: HTTPエラー全文+method/pathを保存(切り詰め禁止)。
    throw new Error(`GET ${url} -> ${res.status} ${text}`);
  }
  const json = await res.json();
  return json.reviews || [];
}

function loadQueue() {
  if (!existsSync(QUEUE_JSON)) return { updated_at: null, clients: {} };
  return JSON.parse(readFileSync(QUEUE_JSON, 'utf8'));
}

async function main() {
  if (!hasGoogleCreds()) {
    console.log('SKIP: GBP_CLIENT_ID/GBP_CLIENT_SECRET/GBP_REFRESH_TOKEN not set (工9審査待ち想定。owner-todos.md参照)');
    return;
  }
  const token = await getGoogleAccessToken();
  const clients = loadActiveApiClients();
  if (clients.length === 0) {
    console.log('SKIP: no active client has connect_mode:"api" locations yet (現状は全店舗claude-in-chrome運用)');
    return;
  }

  const queue = loadQueue();
  let newCount = 0;

  for (const { client, apiLocations } of clients) {
    queue.clients[client.client_id] = queue.clients[client.client_id] || { reviews: [] };
    const existing = queue.clients[client.client_id].reviews;
    const existingIds = new Set(existing.map((r) => r.review_id));

    for (const loc of apiLocations) {
      let reviews;
      try {
        reviews = await fetchReviews(token, loc.gbp_account_id, loc.gbp_location_id);
      } catch (err) {
        console.error(`ERROR fetching reviews for ${client.client_id}/${loc.name}: ${err.message}`);
        continue;
      }
      for (const r of reviews) {
        const hasText = Boolean(r.comment && r.comment.trim().length > 0);
        const hasReply = Boolean(r.reviewReply && r.reviewReply.comment);
        if (!hasText || hasReply) continue; // 仕様: テキストのある未返信のみ対象
        if (existingIds.has(r.reviewId)) continue;
        existing.push({
          review_id: r.reviewId,
          location_name: loc.name,
          gbp_account_id: loc.gbp_account_id,
          gbp_location_id: loc.gbp_location_id,
          reviewer: r.reviewer?.displayName || '匿名',
          star_rating: r.starRating,
          text: r.comment,
          create_time: r.createTime,
          reply_text: null, // 次段(headless Claude)がここを埋める
          posted: false,
        });
        newCount += 1;
      }
    }
  }

  queue.updated_at = new Date().toISOString();
  mkdirSync(path.dirname(QUEUE_JSON), { recursive: true });
  writeFileSync(QUEUE_JSON, JSON.stringify(queue, null, 2));
  console.log(`OK: queue updated, ${newCount} new unreplied text review(s) across ${clients.length} client(s)`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
