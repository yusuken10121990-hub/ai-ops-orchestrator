#!/usr/bin/env node
// gbp-post-reply.mjs
//
// dev-integration (2026-07-23)。gbp-fetch-reviews.mjs が書いた
// memory/meo-review-queue.json のうち、reply_text が埋まっていて posted:false の
// エントリだけを実際にGBPへ投稿する決定論スクリプト。返信文そのものを考えるのは
// このスクリプトの責務外(meo-review-api-reply SKILL=headless Claudeが担当、
// 店舗トーン・禁止事項(誇大表現/断定保証/口コミ依頼の代行等)を守って書く)。
//
// 環境変数はgbp-fetch-reviews.mjsと共通。QUEUE_JSON / CLIENTS_DIR も同じ既定値。

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { getGoogleAccessToken, hasGoogleCreds } from './google-oauth.mjs';

const REVIEWS_API_BASE = 'https://mybusiness.googleapis.com/v4';
const QUEUE_JSON = process.env.QUEUE_JSON || 'config/memory/meo-review-queue.json';
const CLIENTS_DIR = process.env.CLIENTS_DIR
  || 'ai-business/campaigns/_internal/camp_c7faa7c45e/clients';

async function postReply(token, accountId, locationId, reviewId, comment) {
  const url = `${REVIEWS_API_BASE}/accounts/${accountId}/locations/${locationId}/reviews/${reviewId}/reply`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ comment }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${url} -> ${res.status} ${text}`);
  }
  return res.json();
}

function findClientFile(clientId) {
  if (!existsSync(CLIENTS_DIR)) return null;
  const files = readdirSync(CLIENTS_DIR).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const full = path.join(CLIENTS_DIR, f);
    const c = JSON.parse(readFileSync(full, 'utf8'));
    if (c.client_id === clientId) return full;
  }
  return null;
}

async function main() {
  if (!hasGoogleCreds()) {
    console.log('SKIP: GBP credentials not set');
    return;
  }
  if (!existsSync(QUEUE_JSON)) {
    console.log('SKIP: no queue file yet (run gbp-fetch-reviews.mjs first)');
    return;
  }
  const token = await getGoogleAccessToken();
  const queue = JSON.parse(readFileSync(QUEUE_JSON, 'utf8'));

  let posted = 0;
  let failed = 0;

  for (const [clientId, data] of Object.entries(queue.clients || {})) {
    for (const r of data.reviews) {
      if (r.posted || !r.reply_text) continue;
      try {
        await postReply(token, r.gbp_account_id, r.gbp_location_id, r.review_id, r.reply_text);
        r.posted = true;
        r.posted_at = new Date().toISOString();
        posted += 1;
      } catch (err) {
        // 失敗ゼロトレランス: エラー全文を保持しqueueに残す(切り詰め禁止)。次回リトライ対象。
        r.last_error = err.message;
        failed += 1;
        console.error(`ERROR posting reply for ${clientId}/${r.review_id}: ${err.message}`);
      }
    }
    // レジストリ側のreview_stateも軽く更新(既存SKILLと同じ項目名を踏襲)。
    const clientFile = findClientFile(clientId);
    if (clientFile) {
      const client = JSON.parse(readFileSync(clientFile, 'utf8'));
      client.review_state = client.review_state || {};
      client.review_state.last_checked_at = new Date().toISOString();
      client.review_state.last_check_result = `API経由: 今回 ${posted}件投稿 / ${failed}件失敗`;
      writeFileSync(clientFile, JSON.stringify(client, null, 2));
    }
  }

  writeFileSync(QUEUE_JSON, JSON.stringify(queue, null, 2));
  console.log(`OK: posted=${posted} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
