#!/usr/bin/env node
// sns-post-next.mjs
//
// dev-integration (2026-07-23)。sns-posting-stock-check(claude-in-chromeでの
// ネイティブ予約UI操作)のAPI版代替オーケストレータ。GitHub Actionsのcronが
// 8:00/12:00/19:00 JSTに1回ずつこのスクリプトを呼び、その枠のストックから
// 未使用の1件を選んでLinkedIn(+承認済みならX)へ即時投稿する。
//
// 設計メモ: ネイティブの「予約投稿」機能を使わない(cronの発火時刻そのものが
// 投稿時刻になるため、API側にスケジュールを持たせる必要がない=状態を持つのは
// 「どのDay/どの枠まで消化したか」を記録するtracker.jsonだけでよく、実装が
// シンプルになる)。
//
// 使い方: node sns-post-next.mjs <8:00|12:00|19:00> [--dry-run]
// 環境変数:
//   MARKETING_DIR (既定: ai-business/marketing)
//   TRACKER_JSON  (既定: config/memory/sns-api-post-tracker.json)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseStockFile, latestStockFile } from './sns-stock-parser.mjs';
import { postToLinkedIn } from './linkedin-post.mjs';
import { postToX } from './x-post.mjs';
import { hasXCreds, isXBillingApproved } from './x-oauth.mjs';
import { hasLinkedInCreds } from './linkedin-oauth.mjs';

const MARKETING_DIR = process.env.MARKETING_DIR || 'ai-business/marketing';
const TRACKER_JSON = process.env.TRACKER_JSON || 'config/memory/sns-api-post-tracker.json';

function loadTracker() {
  if (!existsSync(TRACKER_JSON)) return { history: [] };
  return JSON.parse(readFileSync(TRACKER_JSON, 'utf8'));
}

function saveTracker(tracker) {
  mkdirSync(path.dirname(TRACKER_JSON), { recursive: true });
  writeFileSync(TRACKER_JSON, JSON.stringify(tracker, null, 2));
}

async function main() {
  const slot = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!['8:00', '12:00', '19:00'].includes(slot)) {
    console.error('usage: node sns-post-next.mjs <8:00|12:00|19:00> [--dry-run]');
    process.exit(1);
  }

  if (!hasLinkedInCreds() && !hasXCreds()) {
    console.log('SKIP: no LinkedIn/X API credentials configured yet (owner-todos.md参照。現行のsns-posting-stock-check(claude-in-chrome)がプライマリ経路のまま継続)');
    return;
  }

  const stockFile = latestStockFile(MARKETING_DIR);
  if (!stockFile) {
    console.log(`SKIP: no sns_posts_batch_*_argument_style.md found under ${MARKETING_DIR}`);
    return;
  }
  const posts = parseStockFile(stockFile).filter((p) => p.slot === slot);
  const tracker = loadTracker();
  const usedKeys = new Set(tracker.history.map((h) => `${h.file}|${h.day}|${h.slot}`));

  const next = posts
    .sort((a, b) => a.day - b.day)
    .find((p) => !usedKeys.has(`${path.basename(stockFile)}|${p.day}|${p.slot}`));

  if (!next) {
    console.log(`SKIP: no unused ${slot} post left in ${path.basename(stockFile)} -- CMO needs to author a new batch (sns-posting-stock-check補充ロジックと同じ閾値判定を将来統合予定)`);
    return;
  }

  const results = {};
  if (hasLinkedInCreds()) {
    results.linkedin = await postToLinkedIn(next.text, { dryRun });
  }
  if (hasXCreds()) {
    results.x = await postToX(next.text, { dryRun });
  }

  console.log(`Post [Day${next.day} ${slot} ${next.service}]: ${next.text}`);
  console.log(JSON.stringify(results, null, 2));

  if (!dryRun) {
    tracker.history.push({
      file: path.basename(stockFile),
      day: next.day,
      slot: next.slot,
      service: next.service,
      posted_at: new Date().toISOString(),
      results,
    });
    saveTracker(tracker);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
