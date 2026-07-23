#!/usr/bin/env node
// x-post.mjs
//
// dev-integration (2026-07-23)。X API v2 (POST /2/tweets) 投稿スクリプト。
// **課金ガード付き**: X_BILLING_APPROVED=true が明示的に設定されていない限り、
// 他の全secretsが揃っていても投稿を実行せず終了する(1投稿$0.015〜$0.20が
// 実際に課金されるため。決済連携の実装は可逆・YES不要だが、実際の課金実行
// テストは本番課金を避けサンドボックス/dry-runで行うという自分の役割定義に
// 従い、このガードをコード自体に埋め込んでいる)。
//
// X_BILLING_APPROVED=trueにできるのはオーナーがrequest_action.ps1のYESゲート
// で「X API有料枠を契約する」ことを承認した後のみ(owner-todos.md参照)。
//
// 使い方: node x-post.mjs "投稿本文" [--dry-run]

import { getXAccessToken, hasXCreds, isXBillingApproved } from './x-oauth.mjs';

const TWEETS_API = 'https://api.twitter.com/2/tweets';

export async function postToX(text, { dryRun = false } = {}) {
  if (!hasXCreds()) {
    return { skipped: true, reason: 'X credentials not set' };
  }
  if (!isXBillingApproved() && !dryRun) {
    return {
      skipped: true,
      reason: 'X_BILLING_APPROVED != "true" -- 課金ガードにより投稿を実行しません(owner-todos.md参照、YESゲート承認後にオーナーがこの値を設定する)',
    };
  }
  const token = await getXAccessToken();

  if (dryRun) {
    console.log('[dry-run] would POST', JSON.stringify({ text }));
    return { skipped: false, dryRun: true };
  }

  const res = await fetch(TWEETS_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`POST ${TWEETS_API} -> ${res.status} ${errText}`);
  }
  const json = await res.json();
  return { skipped: false, id: json.data?.id };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = process.argv[2];
  const dryRun = process.argv.includes('--dry-run');
  if (!text) {
    console.error('usage: node x-post.mjs "text" [--dry-run]');
    process.exit(1);
  }
  const result = await postToX(text, { dryRun });
  console.log(JSON.stringify(result));
}
