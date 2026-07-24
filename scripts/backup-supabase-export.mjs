#!/usr/bin/env node
/**
 * backup-supabase-export.mjs
 *
 * PC完全オフライン化 pcoff-secrets-one-enter 仕上げ (2026-07-24, dev-devops実装):
 * backup.sh (GH Actions) の Supabase バックアップを、pg_dump+SUPABASE_DB_URL
 * (直接Postgres接続文字列、DBパスワードが必要でローカル/CLIソースが無く
 * オーナー手入力が必須だった)から、backup-blobs-export.mjsと全く同じ
 * research.zerosys.jp の backup-export.js Function 経由(OPS_DASHBOARD_KEY、
 * 既存secret・新規投入不要)に置き換える。
 *
 * 設計(認証情報を複製しない・SUPABASE_DB_URLを完全に不要化):
 * backup-export.js は Supabase Auth Admin API(users)とテーブル(credits/
 * credit_transactions)をservice_role権限で読み、JSONだけを返す
 * (SUPABASE_SERVICE_ROLE_KEY自体はNetlify Function内部にしか住まない)。
 * これはローカル日次バックアップ(ai-business/backup/local-backup.mjs)が
 * `netlify dev`経由で既に使っているのと同一API・同一エンドポイントで、
 * 本番公開URL経由では ?k=OPS_DASHBOARD_KEY 認証を使う(dashboard-sync.yml等
 * で既に ai-ops-orchestrator の secret として使われているため新規投入不要)。
 *
 * 2026-07-24実機確認: 本番backup-export.jsが
 * "Node.js detected but native WebSocket not found"で500していたバグを発見
 * (@supabase/supabase-jsがpackage.jsonの^2.45.0からnode_modules内で2.110.2まで
 * 無自覚に上がっており、Node<22のNetlify Function runtimeでRealtimeClientの
 * コンストラクタが素のWebSocket実装を要求するようになった回帰)。
 * sales-research-tool に "ws" 依存を追加してdeploy:prodで修正・meta/users/
 * table全target実測green確認済み(同じ getServiceClient() パターンを使う
 * credits.js側の将来の再ビルドでの同一クラッシュも合わせて予防)。
 *
 * auth.usersのパスワードハッシュ自体はAdmin APIの設計上返らない(意図的な
 * Supabase側の安全設計)。フルDR(ビット単位のPostgres復元)には不十分だが、
 * 「誰が・いくらクレジットを持っていたか」を復元できれば実務上のディザスタ
 * リカバリ目的は満たすと判断(pg_dump方式は無料プランでDBパスワードの手入力
 * が恒久的に必須になるトレードオフのため、この設計を採用)。
 *
 * Usage:
 *   OPS_DASHBOARD_KEY=... SUPABASE_EXPORT_JSON=/path/to/out.json node backup-supabase-export.mjs
 * 出力: SUPABASE_EXPORT_JSON に { generatedAt, meta, users, tables: { credits, credit_transactions } } を書く。
 * OPS_DASHBOARD_KEY未設定時は何も書かず終了コード0(skip)。
 */

const BASE_URL = process.env.BACKUP_EXPORT_BASE_URL || 'https://research.zerosys.jp/api/backup-export';
const KEY = process.env.OPS_DASHBOARD_KEY || '';
const OUT_PATH = process.env.SUPABASE_EXPORT_JSON || '';
const TABLES = ['credits', 'credit_transactions'];
// 安全弁(backup-blobs-export.mjsの安全弁と同じ思想): 想定外の増殖でGH Actions
// の実行時間/バックアップサイズが際限なく膨らむことを防ぐ。
const MAX_USERS = 50_000;
const MAX_ROWS_PER_TABLE = 500_000;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function exportUsers() {
  const users = [];
  let page = 1;
  const perPage = 500;
  for (;;) {
    const url = `${BASE_URL}?k=${encodeURIComponent(KEY)}&target=users&page=${page}&perPage=${perPage}`;
    const r = await fetchJson(url);
    users.push(...(r.users || []));
    if (!r.hasMore || users.length >= MAX_USERS) break;
    page += 1;
  }
  return users;
}

async function exportTable(name) {
  const rows = [];
  let offset = 0;
  const limit = 500;
  for (;;) {
    const url = `${BASE_URL}?k=${encodeURIComponent(KEY)}&target=table&name=${name}&offset=${offset}&limit=${limit}`;
    const r = await fetchJson(url);
    rows.push(...(r.rows || []));
    if (!r.hasMore || rows.length >= MAX_ROWS_PER_TABLE) break;
    offset += limit;
  }
  return rows;
}

async function main() {
  if (!KEY) {
    console.log('[backup-supabase-export] OPS_DASHBOARD_KEY not set, skipping (no file written).');
    return;
  }
  if (!OUT_PATH) {
    console.log('[backup-supabase-export] SUPABASE_EXPORT_JSON not set, skipping (no file written).');
    return;
  }

  let meta = null;
  try {
    meta = await fetchJson(`${BASE_URL}?k=${encodeURIComponent(KEY)}&target=meta`);
    console.log('[backup-supabase-export] meta:', JSON.stringify(meta).slice(0, 300));
  } catch (err) {
    console.error('[backup-supabase-export] meta FAILED:', err.message || err);
    // metaが取れない=Supabase未設定/認証失敗の可能性が高い。以降も失敗するはず
    // だが、部分成功を許すため続行はする(usersないしtablesが取れれば書き出す)。
  }

  let users = [];
  try {
    users = await exportUsers();
    console.log(`[backup-supabase-export] users: count=${users.length}`);
  } catch (err) {
    console.error('[backup-supabase-export] users FAILED:', err.message || err);
  }

  const tables = {};
  for (const name of TABLES) {
    try {
      tables[name] = await exportTable(name);
      console.log(`[backup-supabase-export] table ${name}: count=${tables[name].length}`);
    } catch (err) {
      console.error(`[backup-supabase-export] table ${name} FAILED:`, err.message || err);
      tables[name] = [];
    }
  }

  // meta/usersともに取得できず、かつ全テーブルが空 = 実質何も取れていない。
  // ファイルを書かずにskip扱いとする(空の暗号化ファイルを毎日アップロードし
  // 続ける無意味な状態を避ける)。
  const anyData = users.length > 0 || Object.values(tables).some((r) => r.length > 0) || meta;
  if (!anyData) {
    console.log('[backup-supabase-export] no data retrieved from any target, skipping (no file written).');
    return;
  }

  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), meta, users, tables }));
  console.log(`[backup-supabase-export] wrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('[backup-supabase-export] unhandled error:', err.message || err);
  // 秘密値をログに出さないためスタックトレースは出さない。file未生成のまま
  // 正常終了扱い(exit 0)にし、呼び出し元backup.shがファイル有無で判定する。
  process.exitCode = 0;
});
