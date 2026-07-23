#!/usr/bin/env node
// learning-heartbeat-check.mjs
//
// P0 (2026-07-23, dev-devops「日次学習ルールを仕組みで強制する」対応):
// 全エージェント(.claude/agents/*.md、94体)が実際に日次学習ノート(learnings/配下)を
// 更新し続けているかを機械判定する決定論スクリプト(LLM不使用。automation-health-check.mjs
// と同方針)。ロスター(agents/*.md)と学習ノートのマッピングは ai-business-ops の
// campaigns/agent-roster.mjs (AGENT_LEARNING_FILE) を単一の正とし、ここではそれを
// import して使う(ダッシュボード側と二重管理しない)。
//
// 背景: オーナー監査で「94体中12体が自分の学習ノートで毎日学習を満たせていない」と判明。
// 原因は学習ループ(team-learning-loop等)のスロット表が一部エージェントを一度も
// 個体名で呼んでいなかったこと、および共有ノートへの誤ったマッピング(実体が無いのに
// 「書いていることになっている」)だった。「約束」ではなく機械判定+自動リカバリで
// 二度と抜け漏れが起きない状態にする。
//
// 出力: <CONFIG_DIR>/memory/learning-heartbeat.json
//   { generatedAt, thresholdHours, agents:[{id,notePath,lastLearningAt,hoursSince,status,dept}],
//     summary:{total,green,amber,red,none,stale} }
// stale = status が red(48h超) または none(ノート未接続/未生成)。
// このJSONを使って、呼び出し側(learning-enforcer.yml)がstaleなエージェントへ
// Agent委任で追いキャッチアップ学習を実行させる(このスクリプト自体はLLMを呼ばない)。
//
// 終了コードは常に0(検知スクリプトの失敗でワークフローが落ちてもstatus書き込みが
// 飛ぶだけで実害が大きいため、異常はJSONのfield/GitHub Actions outputで表現する)。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const CONFIG_DIR = process.env.CONFIG_DIR || 'config';
const AI_BUSINESS_OPS_DIR = process.env.AI_BUSINESS_OPS_DIR || 'ai-business-ops';
const AGENTS_DIR = process.env.AGENTS_DIR || join(CONFIG_DIR, 'agents');
const LEARNINGS_DIR = process.env.LEARNINGS_DIR || join(CONFIG_DIR, 'memory/learnings');
const OUTPUT_JSON = process.env.OUTPUT_JSON || join(CONFIG_DIR, 'memory/learning-heartbeat.json');
const STALE_THRESHOLD_HOURS = Number(process.env.STALE_THRESHOLD_HOURS || 36); // 日次学習ルール+ジッター許容
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;

function jstLabel(d) {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('T', ' ').slice(0, 16) + ' JST';
}

async function main() {
  const rosterModPath = join(AI_BUSINESS_OPS_DIR, 'campaigns', 'agent-roster.mjs');
  if (!existsSync(rosterModPath)) {
    console.error(`[learning-heartbeat] agent-roster.mjs not found at ${rosterModPath} (ai-business-ops未checkout?)`);
    writeStatus({ generatedAt: new Date().toISOString(), error: 'agent-roster.mjs not found', agents: [], summary: {} });
    process.exit(0);
  }
  const { parseAgentFiles, agentFreshness, deptFor, resolveLearningPath } = await import('file://' + resolveAbs(rosterModPath));

  if (!existsSync(AGENTS_DIR)) {
    console.error(`[learning-heartbeat] agents dir not found: ${AGENTS_DIR}`);
    writeStatus({ generatedAt: new Date().toISOString(), error: 'agents dir not found', agents: [], summary: {} });
    process.exit(0);
  }

  const now = new Date();
  const roster = parseAgentFiles(AGENTS_DIR);
  const results = [];
  let green = 0, amber = 0, red = 0, none = 0;

  for (const a of roster) {
    const fr = agentFreshness(LEARNINGS_DIR, a.id, now);
    let status;
    if (fr.dot === '⚪') { status = 'none'; none++; }
    else if (fr.dot === '🟢') { status = 'green'; green++; }
    else if (fr.dot === '🟠') { status = 'amber'; amber++; }
    else { status = 'red'; red++; }
    results.push({
      id: a.id,
      dept: deptFor(a.id),
      notePath: resolveLearningPath(LEARNINGS_DIR, a.id),
      lastLearningAt: fr.mtime ? fr.mtime.toISOString() : null,
      lastLearningAtJst: fr.mtime ? jstLabel(fr.mtime) : null,
      hoursSince: fr.hoursSince == null ? null : Math.round(fr.hoursSince * 10) / 10,
      status,
    });
  }

  const stale = results.filter(r => r.status === 'none' || r.status === 'red' || (r.status === 'amber' && r.hoursSince > STALE_THRESHOLD_HOURS));
  const summary = {
    total: results.length,
    green, amber, red, none,
    stale: stale.length,
    thresholdHours: STALE_THRESHOLD_HOURS,
  };

  const out = {
    generatedAt: now.toISOString(),
    generatedAtJst: jstLabel(now),
    thresholdHours: STALE_THRESHOLD_HOURS,
    agents: results.sort((x, y) => (y.hoursSince ?? 1e9) - (x.hoursSince ?? 1e9)),
    staleIds: stale.map(s => s.id).sort(),
    summary,
  };
  writeStatus(out);

  console.log(`[learning-heartbeat] total=${summary.total} green=${green} amber=${amber} red=${red} none=${none} stale=${stale.length}`);
  if (stale.length) console.log(`[learning-heartbeat] stale agents: ${stale.map(s => s.id).join(', ')}`);

  if (GITHUB_OUTPUT) {
    const lines = [
      `stale_count=${stale.length}`,
      `stale_ids=${stale.map(s => s.id).join(',')}`,
    ];
    writeFileSync(GITHUB_OUTPUT, lines.join('\n') + '\n', { flag: 'a' });
  }
}

function resolveAbs(p) {
  // Windows/Linux両対応の絶対パス化(相対のままだとfile://解決に失敗するため)。
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/')) return p.replace(/\\/g, '/');
  return process.cwd().replace(/\\/g, '/') + '/' + p.replace(/\\/g, '/');
}

function writeStatus(obj) {
  const dir = dirname(OUTPUT_JSON);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(OUTPUT_JSON, JSON.stringify(obj, null, 2) + '\n');
}

main().catch(e => {
  console.error('[learning-heartbeat] fatal:', e);
  try { writeStatus({ generatedAt: new Date().toISOString(), error: String(e), agents: [], summary: {} }); } catch {}
  process.exit(0);
});
