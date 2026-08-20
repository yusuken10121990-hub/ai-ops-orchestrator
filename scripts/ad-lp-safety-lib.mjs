#!/usr/bin/env node
// ad-lp-safety-lib.mjs
//
// 共有ライブラリ: 広告/LP自動改善クローズドループの安全装置(フェーズ1・2026-07-25 dev-devops実装)。
// CTO必須4点(単一ライター/冪等キー+CAS/日次上限/計測断ゲート) + 停止条件エンジン
// (最小サンプル・統計的有意差・最大反復回数/クールダウン・振動検知)をここに集約し、
// ad-lp-applier.mjs / ad-circuit-breaker.mjs から呼び出す。
//
// 設計方針:
//   - 台帳(ledger)はJSON Lines(1行1レコード)の追記オンリー。.gitattributes の merge=union
//     (ai-business-ops/ai-ops-config に既存導入済み、decisions.md/playbook.md等と同じ思想)と
//     相性がよく、複数ワークフローが同時にpushしても行単位でunion mergeされて壊れない。
//   - 「現在の状態」(バージョン/日次件数/反復回数)は別ファイルに保存せず、台帳を毎回リプレイして
//     導出する(イベントソーシング)。CASの「食い違い」バグや別ファイルとの不整合を構造的に排除する。
//   - 本ライブラリはLLMを使わない決定論コード(ad-money-guard.mjsと同じ設計思想)。
//
// レコード種別(status): "proposed" | "applied" | "rejected" | "apply_failed" | "rolled_back"

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// ---------------- 基本ユーティリティ ----------------

export function nowIso() {
  return new Date().toISOString();
}

export function jstDateString(d = new Date()) {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10); // YYYY-MM-DD (JST暦日)
}

export function computeIdempotencyKey({ domain, target, field, afterValue }) {
  const h = createHash('sha256');
  h.update(JSON.stringify({ domain, target, field, afterValue }));
  return h.digest('hex').slice(0, 24);
}

// ---------------- 台帳 I/O ----------------

export function ensureDir(path) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return [];
  const raw = readFileSync(ledgerPath, 'utf8');
  const records = [];
  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (e) {
      // 破損行(並行書き込みの衝突片等)はスキップして継続する。台帳全体を壊さない。
      console.warn(`[ad-lp-safety-lib] skipping malformed ledger line: ${e.message}`);
    }
  }
  return records;
}

export function appendRecord(ledgerPath, record) {
  ensureDir(ledgerPath);
  const line = JSON.stringify(record) + '\n';
  appendFileSync(ledgerPath, line, { encoding: 'utf8' });
  return record;
}

export function makeRecord(partial) {
  return {
    id: partial.id || randomUUID(),
    at: nowIso(),
    ...partial,
  };
}

// ---------------- 状態の導出(イベントソーシング) ----------------

function targetKey(domain, target) {
  return `${domain}::${target}`;
}

/**
 * 台帳をリプレイして現在状態を導出する。
 * - targets: { "<domain>::<target>": { version, lastAppliedAt, lastAfterValue, appliedHistory:[{beforeValue,afterValue,appliedAt,recordId}] } }
 * - dailyCounts: { "<domain>|<YYYY-MM-DD JST>": count }  ("applied"のみ加算。proposed/rejected/failedは加算しない)
 * - appliedIdempotencyKeys: Set<string>
 * - recordsById: Map<string, record>
 */
export function deriveState(records) {
  const targets = {};
  const dailyCounts = {};
  const appliedIdempotencyKeys = new Set();
  const recordsById = new Map();

  for (const r of records) {
    if (r.id) recordsById.set(r.id, r);
    if (r.status !== 'applied') continue;

    const tk = targetKey(r.domain, r.target);
    if (!targets[tk]) {
      targets[tk] = { version: 0, lastAppliedAt: null, lastAfterValue: null, appliedHistory: [] };
    }
    const t = targets[tk];
    t.version += 1;
    t.lastAppliedAt = r.at;
    t.lastAfterValue = r.afterValue;
    t.appliedHistory.push({
      beforeValue: r.beforeValue,
      afterValue: r.afterValue,
      appliedAt: r.at,
      recordId: r.id,
    });

    if (r.idempotencyKey) appliedIdempotencyKeys.add(r.idempotencyKey);

    const dateJst = jstDateString(new Date(r.at));
    const dk = `${r.domain}|${dateJst}`;
    dailyCounts[dk] = (dailyCounts[dk] || 0) + 1;
  }

  return { targets, dailyCounts, appliedIdempotencyKeys, recordsById };
}

export function getTargetVersion(state, domain, target) {
  const t = state.targets[targetKey(domain, target)];
  return t ? t.version : 0;
}

// ---------------- ゲート判定(CTO必須4点) ----------------

/** 1. 冪等キー: 既に同一idempotencyKeyで適用済みならtrue(=重複、スキップすべき) */
export function isDuplicateApplied(state, idempotencyKey) {
  return state.appliedIdempotencyKeys.has(idempotencyKey);
}

/** 2. CAS: proposal作成時点のbaseVersionと現在のバージョンが一致しなければ競合 */
export function checkCas(state, domain, target, baseVersion) {
  const current = getTargetVersion(state, domain, target);
  return { ok: current === baseVersion, currentVersion: current, baseVersion };
}

/** 3. 日次上限(ドメイン単位、JST暦日) */
export function checkDailyCap(state, domain, cap, dateJst = jstDateString()) {
  const dk = `${domain}|${dateJst}`;
  const used = state.dailyCounts[dk] || 0;
  return { ok: used < cap, used, cap, dateJst };
}

/** 4. 計測断ゲート: ad-money-guard-status.json の tracking_dead(P1) が該当channelにあれば遮断 */
export function checkTrackingDead(moneyGuardStatus, channel) {
  if (!moneyGuardStatus || !Array.isArray(moneyGuardStatus.findings)) {
    return { ok: true, reason: 'ad-money-guard-status.json未取得のためチェックをスキップ(疎結合、ブロックしない)' };
  }
  const hit = moneyGuardStatus.findings.find(
    (f) => f.channel === channel && f.type === 'tracking_dead' && f.severity === 'P1'
  );
  if (hit) {
    return { ok: false, reason: `計測断検知(${hit.id}): ${hit.detail}` };
  }
  return { ok: true };
}

/** 5. サーキットブレーカー: ad-circuit-breaker-status.json のOPENチャンネルは遮断 */
export function checkCircuitBreaker(breakerStatus, channel) {
  if (!breakerStatus || !breakerStatus.channels || !breakerStatus.channels[channel]) {
    return { ok: true, reason: 'サーキットブレーカーstatus未取得のためチェックをスキップ(疎結合、ブロックしない)' };
  }
  const ch = breakerStatus.channels[channel];
  if (ch.state === 'OPEN') {
    return { ok: false, reason: `サーキットブレーカーOPEN: ${(ch.reasons || []).join('; ')}` };
  }
  return { ok: true };
}

// ---------------- 停止条件エンジン ----------------

/** 最小サンプルサイズ(クリック数等)に達しているか */
export function minSampleMet(sampleSize, minSample) {
  if (sampleSize == null) return { ok: true, reason: 'サンプルサイズ未指定のためスキップ' };
  return { ok: sampleSize >= minSample, sampleSize, minSample };
}

/**
 * 2群比率の統計的有意差(簡易z検定、正規近似)。
 * a/b = { conversions, trials }。alpha=有意水準(片側/両側は呼び出し側の解釈に委ねる、ここではp値のみ返す)。
 */
export function twoProportionZTest(a, b) {
  if (!a || !b || a.trials <= 0 || b.trials <= 0) {
    return { ok: false, significant: false, pValue: null, reason: '試行数不足' };
  }
  const p1 = a.conversions / a.trials;
  const p2 = b.conversions / b.trials;
  const pooled = (a.conversions + b.conversions) / (a.trials + b.trials);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.trials + 1 / b.trials));
  if (se === 0) return { ok: true, significant: false, pValue: 1, z: 0 };
  const z = (p1 - p2) / se;
  // 標準正規分布の両側p値(誤差関数の近似、Abramowitz-Stegun 7.1.26)
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { ok: true, z, pValue, p1, p2 };
}

function normalCdf(x) {
  // Abramowitz & Stegun近似(誤差<7.5e-8)
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const poly = t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - d * poly;
}

export function isSignificant(a, b, alpha) {
  const r = twoProportionZTest(a, b);
  if (!r.ok) return { ok: false, significant: false, reason: r.reason };
  return { ok: true, significant: r.pValue !== null && r.pValue < alpha, pValue: r.pValue };
}

/** 反復回数上限: 直近windowDays以内に同一targetへ適用された回数がmaxIterations以上なら停止 */
export function iterationCapReached(state, domain, target, maxIterations, windowDays) {
  const t = state.targets[targetKey(domain, target)];
  if (!t) return { ok: false, count: 0 };
  const cutoff = Date.now() - windowDays * 24 * 3600 * 1000;
  const recent = t.appliedHistory.filter((h) => new Date(h.appliedAt).getTime() >= cutoff);
  return { ok: recent.length >= maxIterations, count: recent.length, maxIterations, windowDays };
}

/** クールダウン: 直近適用からcooldownHours以内なら停止(変更を"寝かせる"期間) */
export function cooldownActive(state, domain, target, cooldownHours) {
  const t = state.targets[targetKey(domain, target)];
  if (!t || !t.lastAppliedAt) return { ok: false };
  const elapsedHours = (Date.now() - new Date(t.lastAppliedAt).getTime()) / 3600000;
  return { ok: elapsedHours < cooldownHours, elapsedHours, cooldownHours, lastAppliedAt: t.lastAppliedAt };
}

/**
 * 振動検知: 今回の提案afterValueが、直近lookback件の適用履歴のbeforeValueのいずれかと
 * 一致する場合、「前の状態に戻そうとしている」= 行ったり来たりの兆候として検知する。
 */
export function oscillationDetected(state, domain, target, proposedAfterValue, lookback) {
  const t = state.targets[targetKey(domain, target)];
  if (!t) return { ok: false };
  const recent = t.appliedHistory.slice(-lookback);
  const hit = recent.some((h) => h.beforeValue === proposedAfterValue);
  return { ok: hit, recentCount: recent.length };
}

/**
 * 停止条件エンジンをまとめて評価する。1つでもng(=stopすべき)があればallow:falseを返す。
 * opts: { domain, target, proposedAfterValue, sampleSize, abVariants:{a,b}, config }
 * config: { minSampleClicks, significanceAlpha, maxIterationsPerTarget, iterationWindowDays,
 *           cooldownHoursPerTarget, oscillationLookback }
 */
export function evaluateStopConditions(state, opts) {
  const { domain, target, proposedAfterValue, sampleSize, abVariants, config } = opts;
  const reasons = [];

  const sample = minSampleMet(sampleSize, config.minSampleClicks);
  if (!sample.ok) reasons.push(`最小サンプル未達(${sample.sampleSize}<${sample.minSample})`);

  if (abVariants && abVariants.a && abVariants.b) {
    const sig = isSignificant(abVariants.a, abVariants.b, config.significanceAlpha);
    if (sig.ok && !sig.significant) {
      reasons.push(`統計的有意差なし(p=${sig.pValue?.toFixed(3)}, alpha=${config.significanceAlpha})`);
    }
  }

  const iter = iterationCapReached(state, domain, target, config.maxIterationsPerTarget, config.iterationWindowDays);
  if (iter.ok) reasons.push(`反復回数上限到達(${iter.count}/${iter.maxIterations}件、直近${iter.windowDays}日)`);

  const cd = cooldownActive(state, domain, target, config.cooldownHoursPerTarget);
  if (cd.ok) reasons.push(`クールダウン中(前回適用から${cd.elapsedHours.toFixed(1)}h<${cd.cooldownHours}h)`);

  if (proposedAfterValue !== undefined) {
    const osc = oscillationDetected(state, domain, target, proposedAfterValue, config.oscillationLookback);
    if (osc.ok) reasons.push('振動検知(直近の変更を単純に元へ戻す提案、要人間レビュー)');
  }

  return { allow: reasons.length === 0, reasons };
}

// ---------------- 設定読み込み ----------------

export function loadJsonSafe(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.warn(`[ad-lp-safety-lib] failed to parse ${path}: ${e.message}`);
    return fallback;
  }
}

export const DEFAULT_SAFETY_CONFIG = {
  version: 1,
  domains: {
    meta_research: { dailyChangeCap: 3, monthlyHardCapJpy: 15000, cooldownHoursAfterBreach: 24 },
    google_ads_meo: { dailyChangeCap: 3, monthlyHardCapJpy: 40000, cooldownHoursAfterBreach: 24 },
    lp_research: { dailyChangeCap: 3 },
    lp_meo: { dailyChangeCap: 3 },
    lp_fuu: { dailyChangeCap: 3 },
  },
  stopConditions: {
    minSampleClicks: 30,
    significanceAlpha: 0.1,
    maxIterationsPerTarget: 5,
    iterationWindowDays: 14,
    cooldownHoursPerTarget: 24,
    oscillationLookback: 4,
  },
};

export function loadSafetyConfig(path) {
  const loaded = loadJsonSafe(path, null);
  if (!loaded) return DEFAULT_SAFETY_CONFIG;
  // 浅いマージ(domains/stopConditionsが部分指定でもデフォルトで補完)
  return {
    version: loaded.version || 1,
    domains: { ...DEFAULT_SAFETY_CONFIG.domains, ...(loaded.domains || {}) },
    stopConditions: { ...DEFAULT_SAFETY_CONFIG.stopConditions, ...(loaded.stopConditions || {}) },
  };
}
