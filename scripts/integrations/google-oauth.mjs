#!/usr/bin/env node
// google-oauth.mjs
//
// dev-integration (2026-07-23, PCオフ移行タスクの一環)。Google Business Profile
// API(GBP口コミ返信の工9)向けの最小OAuth2ヘルパー。standard refresh_token grant
// のみサポート(初回のauthorization codeやり取りはこのスクリプトの範囲外=
// owner-todos.mdのワンタイム手順で取得する。理由: OAuth同意画面の「許可」クリック
// はアカウント所有者本人の判断が必要な操作であり、AIが自動で完了させてはならない
// という組織ルール上の境界のため)。
//
// 使い方(他スクリプトからimport):
//   import { getGoogleAccessToken } from './google-oauth.mjs';
//   const token = await getGoogleAccessToken();
//
// 必要な環境変数:
//   GBP_CLIENT_ID / GBP_CLIENT_SECRET / GBP_REFRESH_TOKEN
//
// いずれか欠けている場合は null を返す(呼び出し側は「未設定=このステップを
// スキップ」として扱う。video-narration-learning.ymlと同じ安全側スキップ設計)。

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function hasGoogleCreds(env = process.env) {
  return Boolean(env.GBP_CLIENT_ID && env.GBP_CLIENT_SECRET && env.GBP_REFRESH_TOKEN);
}

export async function getGoogleAccessToken(env = process.env) {
  if (!hasGoogleCreds(env)) return null;
  const body = new URLSearchParams({
    client_id: env.GBP_CLIENT_ID,
    client_secret: env.GBP_CLIENT_SECRET,
    refresh_token: env.GBP_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    // 失敗ゼロトレランス・ルール: エラーは全文保存(切り詰め禁止)。
    const text = await res.text();
    throw new Error(`google-oauth refresh failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  return json.access_token;
}

// 初回のOAuth同意URL生成(owner-todos.md用。実行はしない、URLを表示するだけ)。
export function buildGoogleAuthUrl({ clientId, redirectUri }) {
  const scope = [
    'https://www.googleapis.com/auth/business.manage',
  ].join(' ');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // CLI直接実行時: アクセストークン取得テスト(値そのものは表示しない=秘密保護)。
  const token = await getGoogleAccessToken();
  console.log(token ? 'OK: access token obtained (value hidden)' : 'SKIP: GBP_CLIENT_ID/SECRET/REFRESH_TOKEN not set');
}
