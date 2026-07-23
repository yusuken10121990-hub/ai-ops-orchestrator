#!/usr/bin/env node
// x-oauth.mjs
//
// dev-integration (2026-07-23)。X API v2向け最小OAuth2ヘルパー(OAuth2.0 user
// context, refresh_token grant)。
//
// 重要(2026-07-23 dev-integration調査): 2026-02-06付でXは新規開発者向けの
// 無料枠を廃止し、投稿もpay-per-use課金($0.015/投稿, リンク付きは$0.20/投稿)
// に統一された。つまりこの経路を有効化する行為そのものが「金銭が動く新規の
// 有料契約」に該当する。自律性ルール上、支払い方法の登録・課金の実行は
// AIが単独で行ってはならない(request_action.ps1のYESゲート対象)。
//
// 本ファイルはコードとしては完成させておくが、以下の二重ガードにより
// YESゲートを経ずに実際の課金が発生することを構造的に防止する:
//   1. X_BILLING_APPROVED=true が環境変数に無い限り x-post.mjs は即座に
//      エラー終了する(secretsが仮に設定されていても実行しない)。
//   2. sns-posting-api.yml ワークフローはX投稿ステップ自体をデフォルトで
//      含めない(コメントアウト。有効化にはワークフロー編集が要る=事故防止)。

const TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';

export function hasXCreds(env = process.env) {
  return Boolean(
    env.X_ACCESS_TOKEN
    || (env.X_CLIENT_ID && env.X_CLIENT_SECRET && env.X_REFRESH_TOKEN),
  );
}

export function isXBillingApproved(env = process.env) {
  return env.X_BILLING_APPROVED === 'true';
}

export async function getXAccessToken(env = process.env) {
  if (env.X_ACCESS_TOKEN) return env.X_ACCESS_TOKEN;
  if (!(env.X_CLIENT_ID && env.X_CLIENT_SECRET && env.X_REFRESH_TOKEN)) return null;
  const basicAuth = Buffer.from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: env.X_REFRESH_TOKEN,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`x-oauth refresh failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  return json.access_token;
}

export function buildXAuthUrl({ clientId, redirectUri, codeChallenge, state }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'tweet.read tweet.write users.read offline.access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `https://twitter.com/i/oauth2/authorize?${params.toString()}`;
}
