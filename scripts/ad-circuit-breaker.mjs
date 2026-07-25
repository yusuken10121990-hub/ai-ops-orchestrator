#!/usr/bin/env node
// ad-circuit-breaker.mjs
//
// 予算ハードキャップ＋パフォーマンス・サーキットブレーカー(2026-07-25 dev-devops実装、
// オーナー承認済み「フェーズ1: 安全装置MVP」CTO必須点⑤+CEO予算ガード)。
//
// ad-money-guard.mjs(決定論・LLM不使用、支出対実成果/計測断の"検知"担当)の下流に位置する
// "遮断"担当。以下いずれかを満たすチャネルはOPEN(遮断)にし、ad-lp-applier.mjsのapply処理
// (可逆なLP/広告文/KW/除外/リンク先の自動適用)と、フェーズ2の検知→自動改善ループの新規
// 起動(ad-cro-director等の並列委任)の両方をブロックする:
//   (a) 当月累計spendが月間ハードキャップ(ad-lp-safety-config.jsonのdomains.*.monthlyHardCapJpy)を超過
//   (b) ad-money-guard-status.jsonに当該channelのP1所見(tracking_dead/spend_no_result)がある
//
// 重要な非対称性(意図的): 本スクリプトは「広告アカウントの予算/入札を変更する」ことは一切
// しない(それは自律性ルールにより金銭操作=YESゲート専管のまま)。OPENにするのは「このAI組織
// 自身の自動適用・自動改善起動という"内側のスイッチ"」だけ。広告の一時停止(PAUSED化)自体は
// 既存のad-stop-rules.md/ad-pdca-dailyの損切りロジック(可逆・YES不要)が別途担当しており、
// 本スクリプトはそれを代替・変更しない。
//
// 環境変数: ad-money-guard.mjs / ad-lp-applier.mjs と同じ命名規約
//   CONFIG_DIR         既定 'config'
//   OPS_DASHBOARD_KEY  research.zerosys.jp の運用ダッシュボードAPIキー(月次Meta spend集計用)
//
// 出力: <CONFIG_DIR>/memory/ad-circuit-breaker-status.json (今回の判定結果)
//       <CONFIG_DIR>/memory/ad-circuit-breaker-state.json  (月次累計spendの永続化)
//
// 終了コードは常に0(ad-money-guard.mjsと同じ方針。異常はstatusフィールドで表現する)。

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadSafetyConfig, loadJsonSafe, jstDateString, ensureDir } from './ad-lp-safety-lib.mjs';

const CONFIG_DIR = process.env.CONFIG_DIR || 'config';
const SAFETY_CONFIG_PATH = process.env.AD_LP_SAFETY_CONFIG_PATH || join(CONFIG_DIR, 'memory/ad-lp-safety-config.json');
const MONEY_GUARD_STATUS_PATH = process.env.AD_MONEY_GUARD_STATUS_PATH || join(CONFIG_DIR, 'memory/ad-money-guard-status.json');
const STATE_PATH = process.env.AD_CIRCUIT_BREAKER_STATE_PATH || join(CONFIG_DIR, 'memory/ad-circuit-breaker-state.json');
const STATUS_PATH = process.env.AD_CIRCUIT_BREAKER_STATUS_PATH || join(CONFIG_DIR, 'memory/ad-circuit-breaker-status.json');

const OPS_DASHBOARD_URL = 'https://research.zerosys.jp/api/ops-dashboard-data';
const OPS_DASHBOARD_KEY = process.env.OPS_DASHBOARD_KEY || '';

function nowIso() {
  return new Date().toISOString();
}
function jstLabel(d = new Date()) {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('T', ' ').slice(0, 16) + ' JST';
}
function jstMonthKey(d = new Date()) {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 7); // YYYY-MM
}

function loadState() {
  const fallback = { version: 1, channels: {} };
  const loaded = loadJsonSafe(STATE_PATH, fallback);
  return loaded;
}

function getChannelState(state, key) {
  if (!state.channels[key]) {
    state.channels[key] = {
      monthKey: null,
      monthlySpendJpy: 0,
      lastAccumulatedDate: null,
      breaker: { state: 'CLOSED', reasons: [], openedAt: null, cooldownUntil: null },
    };
  }
  return state.channels[key];
}

async function fetchOpsDashboardData() {
  if (!OPS_DASHBOARD_KEY) {
    return { ok: false, reason: 'OPS_DASHBOARD_KEY未設定のためMeta月次spend集計はスキップ' };
  }
  try {
    const url = `${OPS_DASHBOARD_URL}?k=${encodeURIComponent(OPS_DASHBOARD_KEY)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * 当月累計spendへ「本日分」を1回だけ加算する(ad-money-guard.mjsと同じ二重カウント防止設計:
 * 同一JST暦日内に複数ワークフローが実行されても、lastAccumulatedDateガードで1回のみ加算)。
 * 月が変わったら(monthKey不一致)累計をリセットする。
 */
function accumulateMonthlySpend(chState, todayJst, monthKey, spendToday) {
  if (chState.monthKey !== monthKey) {
    chState.monthKey = monthKey;
    chState.monthlySpendJpy = 0;
    chState.lastAccumulatedDate = null;
  }
  if (chState.lastAccumulatedDate !== todayJst) {
    chState.monthlySpendJpy += spendToday;
    chState.lastAccumulatedDate = todayJst;
  }
}

function evaluateChannel(key, domainCfg, moneyGuardStatus, chState, cooldownHours) {
  const reasons = [];

  const hardCap = domainCfg.monthlyHardCapJpy;
  if (hardCap != null && chState.monthlySpendJpy > hardCap) {
    reasons.push(`budget_hard_cap: 当月累計spend¥${chState.monthlySpendJpy.toLocaleString('ja-JP')}が月間ハードキャップ¥${hardCap.toLocaleString('ja-JP')}を超過`);
  }

  const p1 = (moneyGuardStatus?.findings || []).filter((f) => f.channel === key && f.severity === 'P1');
  for (const f of p1) {
    reasons.push(`performance_p1(${f.type}): ${f.detail}`);
  }

  const wasOpen = chState.breaker.state === 'OPEN';
  const nowOpen = reasons.length > 0;

  if (nowOpen) {
    if (!wasOpen) chState.breaker.openedAt = nowIso();
    chState.breaker.state = 'OPEN';
    chState.breaker.reasons = reasons;
    chState.breaker.cooldownUntil = new Date(Date.now() + cooldownHours * 3600 * 1000).toISOString();
  } else if (wasOpen) {
    // 原因が解消していても、乱高下を避けるためクールダウン(前回openedAtからcooldownHours)を
    // 過ぎるまではCLOSEしない。
    const cooldownUntil = chState.breaker.cooldownUntil ? new Date(chState.breaker.cooldownUntil) : null;
    if (cooldownUntil && Date.now() < cooldownUntil.getTime()) {
      chState.breaker.reasons = [`クールダウン中(復旧待ち、${chState.breaker.cooldownUntil}まで)`];
    } else {
      chState.breaker.state = 'CLOSED';
      chState.breaker.reasons = [];
      chState.breaker.openedAt = null;
      chState.breaker.cooldownUntil = null;
    }
  }

  return { ...chState.breaker, monthlySpendJpy: chState.monthlySpendJpy, monthlyHardCapJpy: hardCap ?? null };
}

async function main() {
  const generatedAt = new Date();
  const todayJst = jstDateString(generatedAt);
  const monthKey = jstMonthKey(generatedAt);

  const safetyConfig = loadSafetyConfig(SAFETY_CONFIG_PATH);
  const moneyGuardStatus = loadJsonSafe(MONEY_GUARD_STATUS_PATH, null);
  const state = loadState();

  const opsResult = await fetchOpsDashboardData();
  const metaSpendToday = opsResult.ok ? Number(opsResult.data?.meta?.campaign?.today?.spend || 0) : 0;

  // 現状はMeta(meta_research)のみ日次spendをops-dashboard-data APIから自動取得できる。
  // google_ads_meoは既存のGoogle Adsレポートファイルが「直近7日」粒度で日次分解しづらいため、
  // v1では月次ハードキャップ判定を「取得できるデータが無ければ判定保留(info)」として安全側に倒す
  // (誤ってOPENにする=自動化を止めすぎる分にはリスクが小さいが、逆に判定不能をCLOSED確定する
  // ことはしない)。次回拡張候補としてplaybookへ記録。
  const channelSpendToday = {
    meta_research: metaSpendToday,
  };

  const channels = {};
  for (const [key, domainCfg] of Object.entries(safetyConfig.domains)) {
    if (key !== 'meta_research' && key !== 'google_ads_meo') continue; // 予算/計測が紐づくのは広告チャネルのみ
    const chState = getChannelState(state, key);

    if (key in channelSpendToday) {
      accumulateMonthlySpend(chState, todayJst, monthKey, channelSpendToday[key]);
    } else if (chState.monthKey !== monthKey) {
      // データ未取得でも月替わりはリセットする(スキップしたまま前月の累計を持ち越さない)
      chState.monthKey = monthKey;
      chState.monthlySpendJpy = 0;
      chState.lastAccumulatedDate = null;
    }

    channels[key] = evaluateChannel(key, domainCfg, moneyGuardStatus, chState, domainCfg.cooldownHoursAfterBreach ?? 24);
  }

  const status = {
    generatedAt: generatedAt.toISOString(),
    generatedAtJst: jstLabel(generatedAt),
    sources: {
      opsDashboard: opsResult.ok ? { ok: true } : { ok: false, reason: opsResult.reason },
      moneyGuardStatus: moneyGuardStatus ? { ok: true } : { ok: false, reason: 'ad-money-guard-status.json未取得' },
    },
    channels,
  };

  ensureDir(STATUS_PATH);
  writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');

  console.log(`[ad-circuit-breaker] wrote ${STATUS_PATH} / ${STATE_PATH}`);
  for (const [key, ch] of Object.entries(channels)) {
    console.log(`  ${key}: ${ch.state} (spend=¥${ch.monthlySpendJpy}/${ch.monthlyHardCapJpy ?? '?'}) ${ch.reasons.join('; ')}`);
  }
}

main().catch((e) => {
  console.error('[ad-circuit-breaker] fatal (non-blocking, exiting 0):', e);
});
