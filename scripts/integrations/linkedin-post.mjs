#!/usr/bin/env node
// linkedin-post.mjs
//
// dev-integration (2026-07-23)。LinkedIn Posts API (REST, w_member_social) で
// 個人プロフィール「株式会社アイウィル」名義に投稿する決定論スクリプト。
// sns-posting-stock-check(claude-in-chromeでのネイティブ予約投稿UI操作)の
// API版代替。ネイティブの「予約」機能は使わず、cron起動時刻そのものが
// 投稿タイミングになる設計(GitHub Actionsのcronで8:00/12:00/19:00 JSTに
// 実行するため、API側でスケジュールを持つ必要がない=実装が単純)。
//
// 必要な環境変数:
//   LINKEDIN_ACCESS_TOKEN (または LINKEDIN_CLIENT_ID/SECRET/REFRESH_TOKEN)
//   LINKEDIN_PERSON_URN (未設定ならaccess tokenから自動取得を試みる)
//
// 使い方: node linkedin-post.mjs "投稿本文" [--dry-run]

import { getLinkedInAccessToken, hasLinkedInCreds, fetchPersonUrn } from './linkedin-oauth.mjs';

const POSTS_API = 'https://api.linkedin.com/rest/posts';
const LINKEDIN_VERSION = '202601'; // 実行時点で最新のLinkedIn-Versionヘッダ値に更新すること

export async function postToLinkedIn(text, { dryRun = false } = {}) {
  if (!hasLinkedInCreds()) {
    return { skipped: true, reason: 'LinkedIn credentials not set' };
  }
  const token = await getLinkedInAccessToken();
  const authorUrn = process.env.LINKEDIN_PERSON_URN || await fetchPersonUrn(token);

  const payload = {
    author: authorUrn,
    commentary: text,
    visibility: 'PUBLIC',
    distribution: {
      feedDistribution: 'MAIN_FEED',
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  if (dryRun) {
    console.log('[dry-run] would POST', JSON.stringify(payload));
    return { skipped: false, dryRun: true };
  }

  const res = await fetch(POSTS_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'LinkedIn-Version': LINKEDIN_VERSION,
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errText = await res.text();
    // 失敗ゼロトレランス: HTTPエラー全文+method/pathを保存(切り詰め禁止)。
    throw new Error(`POST ${POSTS_API} -> ${res.status} ${errText}`);
  }

  const postUrn = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id');
  return { skipped: false, postUrn };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!text) {
    console.error('usage: node linkedin-post.mjs "text" [--dry-run]');
    process.exit(1);
  }
  const result = await postToLinkedIn(text, { dryRun });
  console.log(JSON.stringify(result));
  if (result.skipped) process.exit(0);
}
