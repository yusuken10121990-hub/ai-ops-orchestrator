#!/usr/bin/env node
// ad-lp-applier.mjs
//
// 広告/LP自動改善クローズドループの「単一ライター(applier)」(2026-07-25 dev-devops実装、
// オーナー承認済み「フェーズ1: 安全装置MVP」CTO必須点①)。
//
// 分析エージェント(ad-cro-director / uiux-cro-analyst / lp-cro-analyst / copywriter /
// heatmap-analyst / abtest-designer)は変更提案(findings)を出すだけで、共有ファイル
// (ad-lp-apply-queue.md / decisions.md / 広告アカウント / LP本体)へ直接コミットしない。
// 提案は `propose` サブコマンドで台帳(JSON Lines・追記オンリー)へ登録し、実際の適用は
// 必ず本スクリプトの `apply` サブコマンド(ad-lp-apply-daily専任、1日1回のみ実行)を経由する。
// これにより「複数エージェントが同時に共有台帳へ書き込む」という2026-07-23の事故パターン
// (decisions.md/playbook.mdへの並行コミットで未解決マージが混入)を、広告/LP自動適用の
// 経路については構造的に再発させない(新しい並行ワークフローを増やさず、既存の日次1本の
// ワークフローに一本化することで単一ライターを担保する)。
//
// サブコマンド:
//   propose  --domain --target --field --before --after --reason --proposedBy
//            [--sample-size N] [--rollback-command "..."] [--apply-command "..."]
//            [--file-patch '{"path":"...","find":"...","replace":"..."}']
//            [--priority N] [--variant-a '{"conversions":1,"trials":10}'] [--variant-b '...']
//     台帳へ status:"proposed" レコードを追記。idempotencyKey・baseVersion(現在バージョン)を
//     自動計算して埋め込む。標準出力にproposal idを返す。
//
//   apply    [--domain X] [--limit N] [--dry-run]
//     未処理("proposed"かつまだapplied/rejectedになっていない)提案を優先度順に処理する。
//     各提案ごとに毎回「台帳を読み直して」CAS/日次上限/計測断/サーキットブレーカー/停止条件を
//     再判定してから実行するため、同一プロセス内での複数件処理でも古い状態を見ない。
//
//   rollback --id <recordId>
//     "applied"レコードを1件、rollbackCommand(あれば実行) or filePatchの逆適用で元に戻し、
//     status:"rolled_back" レコードを追記する。
//
//   status   [--domain X]
//     現在の台帳状態(バージョン/日次件数/直近レコード)を人間可読で表示するだけ(副作用なし)。
//
// 環境変数(ad-money-guard.mjsと同じ命名規約):
//   AI_BUSINESS_DIR   既定 'C:/Users/user/ai-business' (ledgerの置き場所)
//   CONFIG_DIR        既定 'config' (ad-lp-safety-config.json / ad-money-guard-status.json /
//                                    ad-circuit-breaker-status.json の置き場所)

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  loadLedger,
  appendRecord,
  makeRecord,
  deriveState,
  computeIdempotencyKey,
  isDuplicateApplied,
  checkCas,
  checkDailyCap,
  checkTrackingDead,
  checkCircuitBreaker,
  evaluateStopConditions,
  loadSafetyConfig,
  loadJsonSafe,
  jstDateString,
  ensureDir,
} from './ad-lp-safety-lib.mjs';

const AI_BUSINESS_DIR = process.env.AI_BUSINESS_DIR || 'C:/Users/user/ai-business';
const CONFIG_DIR = process.env.CONFIG_DIR || 'config';

const LEDGER_PATH = process.env.AD_LP_LEDGER_PATH || join(AI_BUSINESS_DIR, 'marketing/automation/ad-lp-applier-ledger.jsonl');
const SAFETY_CONFIG_PATH = process.env.AD_LP_SAFETY_CONFIG_PATH || join(CONFIG_DIR, 'memory/ad-lp-safety-config.json');
const MONEY_GUARD_STATUS_PATH = process.env.AD_MONEY_GUARD_STATUS_PATH || join(CONFIG_DIR, 'memory/ad-money-guard-status.json');
const CIRCUIT_BREAKER_STATUS_PATH = process.env.AD_CIRCUIT_BREAKER_STATUS_PATH || join(CONFIG_DIR, 'memory/ad-circuit-breaker-status.json');

// ---------------- CLI 引数パース(簡易・依存ライブラリ無し) ----------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function backupFile(path) {
  const ts = jstDateString().replace(/-/g, '');
  const bak = `${path}.bak-${ts}`;
  if (!existsSync(bak)) copyFileSync(path, bak);
  return bak;
}

// ---------------- propose ----------------

function cmdPropose(args) {
  const required = ['domain', 'target', 'field', 'after', 'reason', 'proposedBy'];
  for (const k of required) {
    if (!args[k]) {
      console.error(`[ad-lp-applier] propose: --${k} is required`);
      process.exit(1);
    }
  }

  const records = loadLedger(LEDGER_PATH);
  const state = deriveState(records);
  const baseVersion = state.targets[`${args.domain}::${args.target}`]?.version || 0;

  const idempotencyKey = computeIdempotencyKey({
    domain: args.domain,
    target: args.target,
    field: args.field,
    afterValue: args.after,
  });

  let filePatch = null;
  if (args['file-patch']) {
    try {
      filePatch = JSON.parse(args['file-patch']);
    } catch (e) {
      console.error(`[ad-lp-applier] --file-patch is not valid JSON: ${e.message}`);
      process.exit(1);
    }
  }

  let variantA = null;
  let variantB = null;
  if (args['variant-a']) variantA = JSON.parse(args['variant-a']);
  if (args['variant-b']) variantB = JSON.parse(args['variant-b']);

  const record = makeRecord({
    status: 'proposed',
    domain: args.domain,
    target: args.target,
    field: args.field,
    beforeValue: args.before ?? null,
    afterValue: args.after,
    reason: args.reason,
    proposedBy: args.proposedBy,
    idempotencyKey,
    baseVersion,
    priority: args.priority ? Number(args.priority) : 5,
    sampleSize: args['sample-size'] ? Number(args['sample-size']) : null,
    abVariants: variantA && variantB ? { a: variantA, b: variantB } : null,
    rollbackCommand: args['rollback-command'] || null,
    applyCommand: args['apply-command'] || null,
    filePatch,
  });

  appendRecord(LEDGER_PATH, record);
  console.log(`[ad-lp-applier] proposed id=${record.id} idempotencyKey=${idempotencyKey} baseVersion=${baseVersion}`);
  console.log(JSON.stringify({ id: record.id, idempotencyKey, baseVersion }));
}

// ---------------- apply ----------------

function isAlreadyResolved(records, proposalId) {
  // 同じproposal idを参照する applied/rejected/apply_failed レコードが既にあれば「処理済み」
  return records.some((r) => r.proposalId === proposalId && r.status !== 'proposed');
}

function executeFilePatch(patch) {
  if (!existsSync(patch.path)) {
    throw new Error(`filePatch target not found: ${patch.path}`);
  }
  backupFile(patch.path);
  const content = readFileSync(patch.path, 'utf8');
  if (!content.includes(patch.find)) {
    throw new Error(`filePatch.find string not present in ${patch.path} (target may have changed since proposal; re-propose)`);
  }
  const updated = content.replace(patch.find, patch.replace);
  writeFileSync(patch.path, updated, 'utf8');
  return { path: patch.path };
}

function executeApplyCommand(cmd) {
  const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  return out.slice(-4000); // 出力は末尾4000文字まで保持(台帳肥大化防止)
}

function channelForDomain(domain) {
  // ad-money-guard.mjs / ad-circuit-breaker.mjs のchannel命名(meta_research, google_ads_meo)
  // とドメイン命名(lp_research等、LP側は計測断/サーキットブレーカーの対象外なのでnull)を対応付ける。
  if (domain === 'meta_research' || domain === 'google_ads_meo') return domain;
  return null; // LPコピー等、広告チャネルに紐付かないドメインはこのゲートの対象外
}

function cmdApply(args) {
  const domainFilter = args.domain || null;
  const limit = args.limit ? Number(args.limit) : Infinity; // 実際の上限は日次上限ゲートが担う
  const dryRun = !!args['dry-run'];

  const safetyConfig = loadSafetyConfig(SAFETY_CONFIG_PATH);
  const moneyGuardStatus = loadJsonSafe(MONEY_GUARD_STATUS_PATH, null);
  const breakerStatus = loadJsonSafe(CIRCUIT_BREAKER_STATUS_PATH, null);

  const summary = { applied: [], rejected: [], failed: [] };
  let processed = 0;

  // 1提案ずつ、毎回台帳を読み直してから判定する(同一実行内での連続処理でも常に最新状態を見る)。
  for (;;) {
    if (processed >= limit) break;

    const records = loadLedger(LEDGER_PATH);
    const state = deriveState(records);

    const pending = records
      .filter((r) => r.status === 'proposed' && !isAlreadyResolved(records, r.id))
      .filter((r) => !domainFilter || r.domain === domainFilter)
      .sort((a, b) => (a.priority ?? 5) - (b.priority ?? 5) || new Date(a.at) - new Date(b.at));

    if (pending.length === 0) break;
    const p = pending[0];
    processed++;

    const domainCfg = safetyConfig.domains[p.domain] || { dailyChangeCap: 3 };
    const channel = channelForDomain(p.domain);

    const reasons = [];

    if (isDuplicateApplied(state, p.idempotencyKey)) reasons.push('冪等キー重複(既に同一変更が適用済み)');

    const cas = checkCas(state, p.domain, p.target, p.baseVersion ?? 0);
    if (!cas.ok) reasons.push(`CAS競合(baseVersion=${cas.baseVersion} != current=${cas.currentVersion}、対象が他の変更で先に更新済み。再計算して再提案してください)`);

    const cap = checkDailyCap(state, p.domain, domainCfg.dailyChangeCap);
    if (!cap.ok) reasons.push(`日次上限到達(${p.domain}: ${cap.used}/${cap.cap}件、本日分は明日以降へ持ち越し)`);

    if (channel) {
      const td = checkTrackingDead(moneyGuardStatus, channel);
      if (!td.ok) reasons.push(`計測断ゲート: ${td.reason}`);
      const cb = checkCircuitBreaker(breakerStatus, channel);
      if (!cb.ok) reasons.push(`サーキットブレーカー: ${cb.reason}`);
    }

    const stop = evaluateStopConditions(state, {
      domain: p.domain,
      target: p.target,
      proposedAfterValue: p.afterValue,
      sampleSize: p.sampleSize,
      abVariants: p.abVariants,
      config: safetyConfig.stopConditions,
    });
    if (!stop.allow) reasons.push(...stop.reasons.map((r) => `停止条件: ${r}`));

    if (reasons.length > 0) {
      const rejectRecord = makeRecord({
        status: 'rejected',
        proposalId: p.id,
        domain: p.domain,
        target: p.target,
        idempotencyKey: p.idempotencyKey,
        reasons,
      });
      if (!dryRun) appendRecord(LEDGER_PATH, rejectRecord);
      summary.rejected.push({ id: p.id, domain: p.domain, target: p.target, reasons });
      continue;
    }

    if (dryRun) {
      summary.applied.push({ id: p.id, domain: p.domain, target: p.target, dryRun: true });
      continue;
    }

    try {
      let execResult = null;
      if (p.filePatch) {
        execResult = executeFilePatch(p.filePatch);
      } else if (p.applyCommand) {
        execResult = { output: executeApplyCommand(p.applyCommand) };
      } else {
        throw new Error('proposal has neither filePatch nor applyCommand — nothing to execute');
      }

      const appliedRecord = makeRecord({
        status: 'applied',
        proposalId: p.id,
        domain: p.domain,
        target: p.target,
        field: p.field,
        beforeValue: p.beforeValue,
        afterValue: p.afterValue,
        idempotencyKey: p.idempotencyKey,
        reason: p.reason,
        proposedBy: p.proposedBy,
        rollbackCommand: p.rollbackCommand,
        filePatch: p.filePatch || null,
        execResult,
      });
      appendRecord(LEDGER_PATH, appliedRecord);
      summary.applied.push({ id: p.id, domain: p.domain, target: p.target, appliedRecordId: appliedRecord.id });
    } catch (e) {
      const failRecord = makeRecord({
        status: 'apply_failed',
        proposalId: p.id,
        domain: p.domain,
        target: p.target,
        idempotencyKey: p.idempotencyKey,
        error: e.message,
      });
      appendRecord(LEDGER_PATH, failRecord);
      summary.failed.push({ id: p.id, domain: p.domain, target: p.target, error: e.message });
    }
  }

  console.log(`[ad-lp-applier] apply done. applied=${summary.applied.length} rejected=${summary.rejected.length} failed=${summary.failed.length}${dryRun ? ' (dry-run)' : ''}`);
  for (const a of summary.applied) console.log(`  APPLIED  ${a.domain}/${a.target} (proposal ${a.id})`);
  for (const r of summary.rejected) console.log(`  REJECTED ${r.domain}/${r.target}: ${r.reasons.join(' | ')}`);
  for (const f of summary.failed) console.log(`  FAILED   ${f.domain}/${f.target}: ${f.error}`);
  console.log(JSON.stringify(summary));
}

// ---------------- rollback ----------------

function cmdRollback(args) {
  if (!args.id) {
    console.error('[ad-lp-applier] rollback: --id is required');
    process.exit(1);
  }
  const records = loadLedger(LEDGER_PATH);
  const target = records.find((r) => r.id === args.id && r.status === 'applied');
  if (!target) {
    console.error(`[ad-lp-applier] rollback: no applied record found with id=${args.id}`);
    process.exit(1);
  }
  const alreadyRolledBack = records.some((r) => r.rollbackOf === args.id);
  if (alreadyRolledBack) {
    console.log(`[ad-lp-applier] id=${args.id} is already rolled back. no-op.`);
    return;
  }

  let execResult = null;
  try {
    if (target.rollbackCommand) {
      execResult = { output: executeApplyCommand(target.rollbackCommand) };
    } else if (target.filePatch) {
      // filePatchの逆適用: find/replaceを入れ替えて再適用する
      const reverse = { path: target.filePatch.path, find: target.filePatch.replace, replace: target.filePatch.find };
      execResult = executeFilePatch(reverse);
    } else {
      throw new Error('record has neither rollbackCommand nor filePatch — cannot auto-rollback. Manual intervention required.');
    }

    const rollbackRecord = makeRecord({
      status: 'rolled_back',
      rollbackOf: args.id,
      domain: target.domain,
      target: target.target,
      execResult,
    });
    appendRecord(LEDGER_PATH, rollbackRecord);
    console.log(`[ad-lp-applier] rolled back id=${args.id} -> new record ${rollbackRecord.id}`);
  } catch (e) {
    console.error(`[ad-lp-applier] rollback FAILED for id=${args.id}: ${e.message}`);
    process.exit(1);
  }
}

// ---------------- status ----------------

function cmdStatus(args) {
  const records = loadLedger(LEDGER_PATH);
  const state = deriveState(records);
  const domainFilter = args.domain || null;

  console.log(`[ad-lp-applier] ledger=${LEDGER_PATH} records=${records.length}`);
  console.log('-- targets --');
  for (const [key, t] of Object.entries(state.targets)) {
    if (domainFilter && !key.startsWith(`${domainFilter}::`)) continue;
    console.log(`  ${key}: version=${t.version} lastAppliedAt=${t.lastAppliedAt} appliedCount=${t.appliedHistory.length}`);
  }
  console.log('-- daily counts --');
  for (const [key, count] of Object.entries(state.dailyCounts)) {
    console.log(`  ${key}: ${count}`);
  }
  const pending = records.filter((r) => r.status === 'proposed' && !isAlreadyResolved(records, r.id));
  console.log(`-- pending proposals: ${pending.length} --`);
  for (const p of pending.slice(0, 20)) {
    console.log(`  ${p.id} ${p.domain}/${p.target} priority=${p.priority} by=${p.proposedBy}: ${p.reason}`);
  }
}

// ---------------- main ----------------

function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  ensureDir(LEDGER_PATH);

  switch (cmd) {
    case 'propose':
      return cmdPropose(args);
    case 'apply':
      return cmdApply(args);
    case 'rollback':
      return cmdRollback(args);
    case 'status':
      return cmdStatus(args);
    default:
      console.error('usage: ad-lp-applier.mjs <propose|apply|rollback|status> [options]');
      process.exit(1);
  }
}

main();
