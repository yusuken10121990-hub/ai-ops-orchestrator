#!/usr/bin/env node
// publish-public-feed.mjs
//
// 監視チーム再設計Phase1-①(2026-07-20, design-monitoring-team-20260720.md)。
//
// 背景: 哨戒B(Netlify Scheduled Function, sales-research-tool リポジトリの
// sentinel-scheduled.mjs)は systems.json の status:live 全システムをHTTP+markerで
// 独立監視する設計だが、systems.json の実体(ai-ops-config)は非公開リポジトリで
// あることが実装時に判明した(raw.githubusercontent.com は private repo を
// 認証なしでは返さない)。哨戒B側に新規secret(GITHUB_TOKEN等)を投入するのは
// 「金銭実行経路のプリフライト」節に準ずる原則(新規secretはできる限り避ける)に反する
// ため避け、代わりに「非公開データを保有する側(このワークフロー、既にai-ops-configへの
// 認証済みチェックアウトを持つ)が、公開しても問題ない安全なサブセットだけを
// 既存の公開リポジトリ(ai-ops-orchestrator)へ書き出す」方式にした。これは
// heartbeat.json公開(Phase1-③、ops-dashboard側で同種の手法を予定)と同じ考え方。
//
// 安全なサブセットのみ抽出する: id/name/url/kind/healthPath/marker/deploy/status。
// repo(ローカルWindowsパス)・_note・_deploy_note等の内部情報は一切含めない。
//
// 出力: <repo root>/public-feed/systems-live.json
//   → 哨戒Bは https://raw.githubusercontent.com/yusuken10121990-hub/ai-ops-orchestrator/main/public-feed/systems-live.json
//     を認証なしでfetchする(ai-ops-orchestratorはpublicリポジトリ)。
//
// 使い方: SYSTEMS_JSON=config/memory/systems.json node scripts/publish-public-feed.mjs
// 終了コードは常に0(このスクリプトの失敗でワークフロー全体を止めない。哨戒B側は
// フィード取得失敗を検知してskipするだけで済むよう既に実装済み)。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { readJson } from './read-json.mjs';

const SYSTEMS_JSON = process.env.SYSTEMS_JSON || 'config/memory/systems.json';
const OUT_PATH = process.env.PUBLIC_FEED_OUT || 'public-feed/systems-live.json';

const SAFE_FIELDS = ['id', 'name', 'url', 'kind', 'healthPath', 'marker', 'deploy', 'status'];

// systems.json に無いRailwayプロジェクト(照合は ops-auto-repair-detector.mjs と同じ規則)。
// トークン無し・API失敗時は空を返す(フィード全体は止めない)。
async function unregisteredRailwayProjects(systems) {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) return [];
  let projects = [];
  try {
    const r = await fetch('https://backboard.railway.com/graphql/v2', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{ projects { edges { node { id name createdAt } } } }' }) });
    const j = await r.json();
    if (!r.ok || j.errors?.length) { console.error(`[publish-public-feed] railway api error: ${r.status} ${JSON.stringify(j.errors || '').slice(0, 200)}`); return []; }
    projects = (j.data?.projects?.edges || []).map((e) => e.node);
  } catch (e) { console.error(`[publish-public-feed] railway fetch failed: ${e.message}`); return []; }
  const ignorePath = process.env.LEDGER_IGNORE_JSON || 'config/memory/ledger-ignore.json';
  const ignored = new Set((existsSync(ignorePath) ? readJson(ignorePath).railway || [] : []).map((x) => String(x).toLowerCase()));
  const blobs = systems.map((s) => JSON.stringify(s).toLowerCase());
  return projects.filter((p) => {
    const n = String(p.name || '').toLowerCase();
    if (!n || ignored.has(n) || ignored.has(String(p.id))) return false;
    const hit = systems.some((s) => { const i = s.id.toLowerCase(); return i === n || i.startsWith(n + '-') || n.startsWith(i + '-'); })
      || blobs.some((b) => b.includes(String(p.id)) || b.includes(`project ${n}`) || b.includes(`${n}-production`) || b.includes(`project:${n}`) || b.includes(`"${n}"`));
    return !hit;
  });
}

async function main() {
  if (!existsSync(SYSTEMS_JSON)) {
    console.error(`[publish-public-feed] SYSTEMS_JSON not found at ${SYSTEMS_JSON}, skip`);
    return;
  }
  const catalog = readJson(SYSTEMS_JSON); // BOM耐性(2026-08-23 automation-heartbeat事故の一般化)
  const all = catalog.systems || [];
  const live = all
    .filter((s) => s.status === 'live')
    .map((s) => {
      const out = {};
      for (const f of SAFE_FIELDS) out[f] = s[f] ?? (f === 'healthPath' || f === 'marker' ? '' : s[f]);
      return out;
    });

  const payload = {
    generated_at: new Date().toISOString(),
    note: 'systems.json(非公開)のうちstatus:liveの監視に必要な安全なフィールドのみを公開したサブセット。哨戒B(Netlify Scheduled Function)が認証なしで参照する。',
    systems: live,
  };

  // 2026-09-30 営業台帳(Apps Script)用: 受託先(client)が入っている開発中/稼働中システムの一覧。
  // 営業台帳がこれを15分ごとに読み、新しい受託システムを案件として自動追加する。
  // 2026-10-21 オーナー指示「クライアントのシステムは全部・新規も含めて営業台帳へ」。
  // client の入れ忘れや台帳登録漏れで載らない事故が続いたため、既定を反転した:
  // 社内用(internal:true)と明示したもの以外の開発中/稼働中システムは全部載せる(会社名が空なら営業台帳側で「未入力」)。
  // さらに台帳に登録すらされていないRailwayプロジェクトも、クラウドから直接拾って載せる。
  const clients = all
    .filter((s) => (s.status === 'building' || s.status === 'live') && s.internal !== true)
    .map((s) => ({ id: s.id, name: s.name, client: s.client || '', url: s.url || '', status: s.status, addedAt: s.addedAt || '', source: 'ledger' }));
  for (const p of await unregisteredRailwayProjects(all)) {
    clients.push({ id: `railway-${p.name}`, name: p.name, client: '', url: '', status: 'live', addedAt: (p.createdAt || '').slice(0, 10), source: 'railway' });
  }
  const CLIENTS_OUT = process.env.PUBLIC_CLIENTS_OUT || 'public-feed/systems-clients.json';
  mkdirSync(CLIENTS_OUT.slice(0, CLIENTS_OUT.lastIndexOf('/')), { recursive: true });
  writeFileSync(CLIENTS_OUT, JSON.stringify({ generated_at: new Date().toISOString(), note: '受託システムの一覧(営業台帳の自動追加用・公開して問題ない項目のみ)', systems: clients }, null, 2) + '\n', 'utf8');
  console.log(`[publish-public-feed] wrote ${CLIENTS_OUT} (${clients.length} client systems)`);

  mkdirSync(OUT_PATH.includes('/') ? OUT_PATH.slice(0, OUT_PATH.lastIndexOf('/')) : '.', { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`[publish-public-feed] wrote ${OUT_PATH} (${live.length} live systems)`);
}

await main();
