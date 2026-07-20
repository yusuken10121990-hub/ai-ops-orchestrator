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

const SYSTEMS_JSON = process.env.SYSTEMS_JSON || 'config/memory/systems.json';
const OUT_PATH = process.env.PUBLIC_FEED_OUT || 'public-feed/systems-live.json';

const SAFE_FIELDS = ['id', 'name', 'url', 'kind', 'healthPath', 'marker', 'deploy', 'status'];

function main() {
  if (!existsSync(SYSTEMS_JSON)) {
    console.error(`[publish-public-feed] SYSTEMS_JSON not found at ${SYSTEMS_JSON}, skip`);
    return;
  }
  const catalog = JSON.parse(readFileSync(SYSTEMS_JSON, 'utf8'));
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

  mkdirSync(OUT_PATH.includes('/') ? OUT_PATH.slice(0, OUT_PATH.lastIndexOf('/')) : '.', { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`[publish-public-feed] wrote ${OUT_PATH} (${live.length} live systems)`);
}

main();
