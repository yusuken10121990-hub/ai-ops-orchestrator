#!/usr/bin/env node
// linkedin-oauth.mjs
//
// dev-integration (2026-07-23)。LinkedIn REST API向けの最小OAuth2ヘルパー。
// 「Share on LinkedIn」プロダクト(w_member_social)は無料・セルフサーブだが、
// 前提としてアプリに紐づく LinkedIn Page(会社ページ)が必要で、本アカウント
// (「株式会社アイウィル」個人プロフィール)は投稿数不足でページ作成不可
// (2026-07-23 dev-integration実測: linkedin.com/company/setup/new/ で
// 「会社・団体ページを作成するにはつながりの数が不足しています」)。
// このスクリプト自体はページ/アプリ作成後すぐ使えるよう先行実装しておく
// (つながり数が閾値を超えた時点でowner-todos.mdの手順に従いアプリ作成→
// このスクリプトが即稼働する設計)。
//
// 必要な環境変数:
//   LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET / LINKEDIN_REFRESH_TOKEN
//   (LINKEDIN_ACCESS_TOKENが直接設定されていればそちらを優先=refresh token
//    アクセスが未承認のアプリでも60日有効なaccess tokenを直接運用できる)

const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';

export function hasLinkedInCreds(env = process.env) {
  return Boolean(
    env.LINKEDIN_ACCESS_TOKEN
    || (env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET && env.LINKEDIN_REFRESH_TOKEN),
  );
}

export async function getLinkedInAccessToken(env = process.env) {
  if (env.LINKEDIN_ACCESS_TOKEN) return env.LINKEDIN_ACCESS_TOKEN;
  if (!(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET && env.LINKEDIN_REFRESH_TOKEN)) {
    return null;
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: env.LINKEDIN_REFRESH_TOKEN,
    client_id: env.LINKEDIN_CLIENT_ID,
    client_secret: env.LINKEDIN_CLIENT_SECRET,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`linkedin-oauth refresh failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  return json.access_token;
}

// 投稿には author urn (urn:li:person:{id}) が要る。/v2/userinfo (OpenID Connect,
// Sign In with LinkedInプロダクト同時追加が必要) から一度だけ取得しsecret化する。
export async function fetchPersonUrn(accessToken) {
  const res = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fetchPersonUrn failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  return `urn:li:person:${json.sub}`;
}

export function buildLinkedInAuthUrl({ clientId, redirectUri }) {
  const scope = ['openid', 'profile', 'w_member_social'].join(' ');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = await getLinkedInAccessToken();
  console.log(token ? 'OK: access token obtained (value hidden)' : 'SKIP: LinkedIn credentials not set');
}
