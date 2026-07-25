#!/usr/bin/env node
// ad-money-guard.mjs
//
// P1(2026-07-25、オーナー依頼「広告費が実成果にまったく結びついていない/計測が死んでいる
// 異常を一度も検知していなかった」への恒久対策): 広告PDCA日次ループ(ad-pdca-daily.yml /
// ad-lp-apply-daily.yml)はLLM(cmo/ad-lp-analyst)の分析任せで、"支出対実成果"と"計測の
// 生死"を毎日必ずチェックする決定論的な仕組みが存在しなかった。automation-health-check.mjs
// と同じ設計思想(LLM不使用・台帳/APIを読み判定・状態はJSONへ・終了コードは常に0・重大なもの
// はGitHub Issue起票)を踏襲し、金銭は一切動かさない読み取り専用の異常検知だけを行う。
//
// データソース:
//   1. https://research.zerosys.jp/api/ops-dashboard-data?k=<OPS_DASHBOARD_KEY>
//      (netlify/functions/ops-dashboard-data.js、本番稼働中の既存API。Meta広告の
//      spend/clicks/purchasesとStripe実決済(ground truth、商品別分類済み)の
//      当日/通算を1発で返す。このAPIをそのまま再利用し、Stripe鍵は再実装しない)。
//   2. ai-business/google-ads/data/ 配下の最新の report_all_campaigns_*.json
//      (優先) または pull_7357396296_*.json (フォールバック)。どちらもGoogle Ads
//      「口コミ返信代行_検索_launch」(campaign id 23917624926, CID 7357396296)の
//      直近7日 spend/clicks/conversions を含む。ファイルが無ければ「Google Ads分は
//      未取得のためスキップ」として継続する(新規に重い収集処理は実装しない)。
//
// 判定閾値の根拠: C:\Users\user\.claude\memory\ad-stop-rules.md の既存原則
// (「累計クリック100件未満はCV評価保留」「累計クリック30件未満は有意差判定しない」)と
// playbook.mdの基盤(初CV評価/クリック閾値)に矛盾しないよう、100クリック未満は
// P1判定せず「観察中(observing)」に留める。既存原則の上書きはしない。
//
// 出力: config/memory/ad-money-guard-status.json (今回の判定結果、ダッシュボード用)
//       config/memory/ad-money-guard-state.json  (連続日数カウンタの永続化)
//
// 終了コードは常に0(このスクリプト自体の失敗でワークフローを落とすとstatus書き込みが
// 飛ぶため。異常はstatusフィールドで表現する)。

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_DIR = process.env.CONFIG_DIR || 'config';
const STATE_PATH = process.env.AD_MONEY_GUARD_STATE_PATH || join(CONFIG_DIR, 'memory/ad-money-guard-state.json');
const STATUS_PATH = process.env.AD_MONEY_GUARD_STATUS_PATH || join(CONFIG_DIR, 'memory/ad-money-guard-status.json');

const OPS_DASHBOARD_URL = 'https://research.zerosys.jp/api/ops-dashboard-data';
const OPS_DASHBOARD_KEY = process.env.OPS_DASHBOARD_KEY || '';

// ai-pdca-daily.yml/ad-lp-apply-daily.yml のCI上はAI_BUSINESS_DIR($GITHUB_WORKSPACE/ai-business)
// が checkout-ai-business.sh によりエクスポートされる。ローカルPC実行時はオーナーPCの実パスを既定値にする。
const AI_BUSINESS_DIR = process.env.AI_BUSINESS_DIR || 'C:/Users/user/ai-business';
const GOOGLE_ADS_DATA_DIR = process.env.GOOGLE_ADS_DATA_DIR || join(AI_BUSINESS_DIR, 'google-ads/data');
const GADS_CAMPAIGN_ID = 23917624926; // 「口コミ返信代行_検索_launch」(OMAKASE MEO主力検索広告、CID 7357396296)

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY || 'yusuken10121990-hub/ai-ops-orchestrator';

// ---- 閾値(ad-stop-rules.md/playbook.mdと矛盾しないよう選定) ----
// 「累計クリック100件未満は評価保留」(ad-stop-rules.md 3節「我慢して続ける条件」)をそのまま踏襲。
const CLICK_EVAL_MIN = 100;
// spend_no_result(支出あり×Stripe実成果0)の連続日数しきい値。ad-stop-rules.mdの損切り基準(3日+
// クリック100件AND条件)より意図的に短い2日にしている: これは「広告を止める」判断ではなく「異常を
// 検知してオーナー/エージェントに知らせる」早期警戒であり、自動停止・入札変更などの金銭操作は一切
// 行わないため、既存の損切り基準より早めに警報を出しても実害(誤った自動アクション)が無い。
const SPEND_NO_RESULT_STREAK_DAYS_FOR_P1 = 2;

function nowIso() { return new Date().toISOString(); }

function jstDateString(d = new Date()) {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().slice(0, 10); // YYYY-MM-DD (JST暦日)
}

function jstLabel(d = new Date()) {
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('T', ' ').slice(0, 16) + ' JST';
}

// ---------------- state ----------------

function loadState() {
  if (existsSync(STATE_PATH)) {
    try {
      return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    } catch (e) {
      console.warn(`[ad-money-guard] state file parse failed, resetting: ${e.message}`);
    }
  }
  return { version: 1, channels: {} };
}

function getChannelState(state, key) {
  if (!state.channels[key]) {
    state.channels[key] = { streakDays: 0, lastEvaluatedDate: null, lastSnapshot: null };
  }
  return state.channels[key];
}

// ---------------- ops-dashboard-data (Meta + Stripe ground truth) ----------------

async function fetchOpsDashboardData() {
  if (!OPS_DASHBOARD_KEY) {
    return { ok: false, skipped: true, reason: 'OPS_DASHBOARD_KEY 未設定のためMeta/Stripeチェックはスキップ' };
  }
  try {
    const url = `${OPS_DASHBOARD_URL}?k=${encodeURIComponent(OPS_DASHBOARD_KEY)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      return { ok: false, skipped: false, reason: `HTTP ${res.status}` };
    }
    const data = await res.json();
    if (data.meta?.error && data.stripe?.error) {
      return { ok: false, skipped: false, reason: `meta: ${data.meta.error}; stripe: ${data.stripe.error}` };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, skipped: false, reason: e.message };
  }
}

// ---------------- Google Ads 週次レポートファイル(既存収集スクリプトの出力を読むだけ、新規収集はしない) ----------------

function findLatestGoogleAdsFile(dir, prefix) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
  if (!files.length) return null;
  files.sort(); // ファイル名にYYYYMMDDが含まれるため文字列ソート=日付昇順
  return join(dir, files[files.length - 1]);
}

function loadGoogleAdsWeeklyMetrics() {
  // 1. report_all_campaigns_*.json (優先。metrics_7d/metrics_allが整理済み)
  const reportPath = findLatestGoogleAdsFile(GOOGLE_ADS_DATA_DIR, 'report_all_campaigns_');
  if (reportPath) {
    try {
      const json = JSON.parse(readFileSync(reportPath, 'utf8'));
      const camp = (json.campaigns || []).find((c) => Number(c.id) === GADS_CAMPAIGN_ID);
      if (camp && camp.metrics_7d) {
        return {
          ok: true,
          source: reportPath,
          periodFrom: json.meta?.period_7d?.from || null,
          periodTo: json.meta?.period_7d?.to || null,
          clicks: Number(camp.metrics_7d.clicks || 0),
          costJpy: Number(camp.metrics_7d.cost_jpy || 0),
          conversions: Number(camp.metrics_7d.conversions || 0),
        };
      }
    } catch (e) {
      console.warn(`[ad-money-guard] report_all_campaigns parse failed (${reportPath}): ${e.message}`);
    }
  }

  // 2. pull_7357396296_*.json (フォールバック。フラット構造でcampaigns[].clicks/cost_jpy/conversionsを直接持つ)
  const pullPath = findLatestGoogleAdsFile(GOOGLE_ADS_DATA_DIR, 'pull_7357396296_');
  if (pullPath) {
    try {
      const json = JSON.parse(readFileSync(pullPath, 'utf8'));
      const camp = (json.campaigns || []).find((c) => Number(c.id) === GADS_CAMPAIGN_ID);
      if (camp) {
        return {
          ok: true,
          source: pullPath,
          periodFrom: json.meta?.period?.from || null,
          periodTo: json.meta?.period?.to || null,
          clicks: Number(camp.clicks || 0),
          costJpy: Number(camp.cost_jpy || 0),
          conversions: Number(camp.conversions || 0),
        };
      }
    } catch (e) {
      console.warn(`[ad-money-guard] pull_ file parse failed (${pullPath}): ${e.message}`);
    }
  }

  return { ok: false, reason: `${GOOGLE_ADS_DATA_DIR} に report_all_campaigns_*.json / pull_7357396296_*.json が無い、または対象キャンペーン(${GADS_CAMPAIGN_ID})のデータが無い。Google Ads分は未取得のためスキップ` };
}

// ---------------- 判定: Meta ZEROSYSリサーチ広告 ----------------

function evaluateMetaResearch(opsResult, state, todayJst) {
  const key = 'meta_research';
  const ch = getChannelState(state, key);
  const findings = [];

  if (!opsResult.ok) {
    findings.push({
      id: 'meta_research_unavailable',
      channel: key,
      type: 'data_unavailable',
      severity: 'info',
      detail: `Meta/Stripeデータ取得不可: ${opsResult.reason}`,
    });
    return findings;
  }

  const data = opsResult.data;
  const metaErr = data.meta?.error;
  const stripeErr = data.stripe?.error;
  if (metaErr || stripeErr) {
    findings.push({
      id: 'meta_research_partial_unavailable',
      channel: key,
      type: 'data_unavailable',
      severity: 'info',
      detail: `meta.error=${metaErr || 'なし'} / stripe.error=${stripeErr || 'なし'}`,
    });
  }

  const metaToday = data.meta?.campaign?.today;
  const metaMax = data.meta?.campaign?.maximum;
  const stripeToday = data.stripe?.today?.byProduct?.research;

  // ---- A) spend_no_result: 今日のspend>0 かつ 今日のStripe実成果(research)0が連続 ----
  // stripe.today はops-dashboard-data.js側で既にJST0:00基準の当日バケットとして計算済みなので、
  // ここで日付差分を自前計算する必要はない(既存APIをそのまま信用する)。
  if (metaToday && stripeToday) {
    const spendToday = Number(metaToday.spend || 0);
    const researchCountToday = Number(stripeToday.count || 0);

    if (ch.lastEvaluatedDate !== todayJst) {
      // 新しい暦日の最初の実行のみカウンタを更新する(二重カウント防止。同日内の2回目以降の
      // 実行=ad-pdca-daily/ad-lp-apply-dailyが同じ日に両方走っても加算しない)。
      if (spendToday > 0 && researchCountToday === 0) {
        ch.streakDays = (ch.streakDays || 0) + 1;
      } else {
        // spend=0の日(出稿してない日)、またはspend>0でStripe実績もある健全な日はリセットする。
        ch.streakDays = 0;
      }
      ch.lastEvaluatedDate = todayJst;
    }
    ch.lastSnapshot = { date: todayJst, spendToday, researchCountToday, checkedAt: nowIso() };

    if (ch.streakDays >= SPEND_NO_RESULT_STREAK_DAYS_FOR_P1) {
      findings.push({
        id: 'meta_research_spend_no_result',
        channel: key,
        type: 'spend_no_result',
        severity: 'P1',
        streakDays: ch.streakDays,
        detail: `Metaリサーチ広告に${ch.streakDays}日連続で出稿(本日spend=¥${spendToday.toLocaleString('ja-JP')})しているが、Stripe実決済(research)が0件のまま`,
      });
    } else if (ch.streakDays === 1) {
      findings.push({
        id: 'meta_research_spend_no_result_watch',
        channel: key,
        type: 'spend_no_result',
        severity: 'info',
        streakDays: ch.streakDays,
        detail: `本日spend=¥${spendToday.toLocaleString('ja-JP')}でStripe実決済(research)が0件。${SPEND_NO_RESULT_STREAK_DAYS_FOR_P1}日連続でP1判定`,
      });
    }
  }

  // ---- B) tracking_dead: 直近(このキャンペーン稼働開始からの累計=maximum)でクリック>=100かつ
  //         Meta自己申告のpurchasesが0 → 配信はされているのに計測イベントが1件も飛んでいない疑い ----
  // campaign.maximumはops-dashboard-data.js側が「名前一致するACTIVEキャンペーンの通算」を返す
  // ため、キャンペーンがローテーションしても常にその時点の主力キャンペーンの実質的な直近実績になる
  // (2026-07-23にキャンペーンが切り替わったばかりなら、maximum=切替後の累計=実質「直近」)。
  if (metaMax) {
    const clicksMax = Number(metaMax.clicks || 0);
    const purchasesMax = Number(metaMax.purchases || 0);
    if (clicksMax >= CLICK_EVAL_MIN) {
      if (purchasesMax === 0) {
        findings.push({
          id: 'meta_research_tracking_dead',
          channel: key,
          type: 'tracking_dead',
          severity: 'P1',
          detail: `Metaリサーチ広告の累計クリック${clicksMax}件(spend≈¥${Number(metaMax.spend || 0).toLocaleString('ja-JP')})に対しMeta自己申告purchasesが0件。Pixel/CAPIの計測断が疑われる`,
        });
      }
    } else {
      findings.push({
        id: 'meta_research_tracking_observing',
        channel: key,
        type: 'tracking_dead',
        severity: 'info',
        detail: `累計クリック${clicksMax}件(<${CLICK_EVAL_MIN}件)のため計測断の評価は保留(ad-stop-rules.md基準)`,
      });
    }
  }

  return findings;
}

// ---------------- 判定: Google Ads OMAKASE MEO(口コミ返信代行_検索_launch) ----------------

function evaluateGoogleAdsMeo(gadsResult) {
  const key = 'google_ads_meo';
  const findings = [];

  if (!gadsResult.ok) {
    findings.push({
      id: 'google_ads_meo_unavailable',
      channel: key,
      type: 'data_unavailable',
      severity: 'info',
      detail: gadsResult.reason,
    });
    return findings;
  }

  const { clicks, costJpy, conversions, periodFrom, periodTo, source } = gadsResult;
  const period = periodFrom && periodTo ? `${periodFrom}〜${periodTo}` : '直近7日';

  if (clicks < CLICK_EVAL_MIN) {
    findings.push({
      id: 'google_ads_meo_observing',
      channel: key,
      type: 'spend_no_result',
      severity: 'info',
      detail: `${period}のクリック${clicks}件(<${CLICK_EVAL_MIN}件)のためCV評価は保留(ad-stop-rules.md基準)。spend=¥${costJpy.toLocaleString('ja-JP')} conversions=${conversions}`,
      source,
    });
    return findings;
  }

  if (costJpy > 0 && conversions === 0) {
    findings.push({
      id: 'google_ads_meo_spend_no_result',
      channel: key,
      type: 'spend_no_result',
      severity: 'P1',
      detail: `Google Ads「口コミ返信代行_検索_launch」の${period}でクリック${clicks}件・spend=¥${costJpy.toLocaleString('ja-JP')}に対しconversions=0件`,
      source,
    });
  }

  return findings;
}

// ---------------- GitHub Issue upsert(automation-health-check.mjsと同じパターン) ----------------

async function ghApi(path, init) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${path} -> ${res.status}`);
  return res.json();
}

async function upsertGithubIssue({ title, bodyLines, isP1 }) {
  if (!GITHUB_TOKEN) {
    console.log('[ad-money-guard] GITHUB_TOKEN未設定のためIssue起票をスキップ');
    return;
  }
  try {
    const issues = await ghApi(`/repos/${REPO}/issues?state=open&per_page=50&labels=ad-money-guard`).catch(() => []);
    const list = Array.isArray(issues) ? issues : [];
    const existing = list.find((i) => i.title === title);

    if (isP1) {
      if (!existing) {
        await ghApi(`/repos/${REPO}/issues`, {
          method: 'POST',
          body: JSON.stringify({ title, body: bodyLines.join('\n'), labels: ['ad-money-guard'] }),
        });
        console.log(`[ad-money-guard] filed issue: ${title}`);
      } else {
        await ghApi(`/repos/${REPO}/issues/${existing.number}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body: bodyLines.join('\n') }),
        });
        console.log(`[ad-money-guard] updated existing open issue #${existing.number} with latest numbers`);
      }
    } else if (existing) {
      await ghApi(`/repos/${REPO}/issues/${existing.number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: '実成果への結びつき/計測を確認できたため自動クローズします。' }),
      });
      await ghApi(`/repos/${REPO}/issues/${existing.number}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed' }),
      });
      console.log(`[ad-money-guard] closed recovered issue #${existing.number}`);
    }
  } catch (e) {
    console.log(`[ad-money-guard] issue upsert failed (non-fatal): ${e.message}`);
  }
}

// ---------------- main ----------------

async function main() {
  const generatedAt = new Date();
  const todayJst = jstDateString(generatedAt);

  const state = loadState();

  const opsResult = await fetchOpsDashboardData();
  const gadsResult = loadGoogleAdsWeeklyMetrics();

  const metaFindings = evaluateMetaResearch(opsResult, state, todayJst);
  const gadsFindings = evaluateGoogleAdsMeo(gadsResult);
  const findings = [...metaFindings, ...gadsFindings];

  const p1Findings = findings.filter((f) => f.severity === 'P1');
  const hasAnyRealSignal = findings.some((f) => f.severity !== 'info' || f.type !== 'data_unavailable');
  let overallSeverity;
  if (p1Findings.length > 0) overallSeverity = 'P1';
  else if (hasAnyRealSignal) overallSeverity = 'ok';
  else overallSeverity = 'unknown'; // 両ソースとも取得できず判定不能(スキップのみ)

  const status = {
    generatedAt: generatedAt.toISOString(),
    generatedAtJst: jstLabel(generatedAt),
    sources: {
      opsDashboard: opsResult.ok
        ? { ok: true }
        : { ok: false, skipped: !!opsResult.skipped, reason: opsResult.reason },
      googleAds: gadsResult.ok
        ? { ok: true, source: gadsResult.source, period: `${gadsResult.periodFrom || '?'}〜${gadsResult.periodTo || '?'}` }
        : { ok: false, reason: gadsResult.reason },
    },
    findings,
    overallSeverity,
    thresholds: {
      clickEvalMin: CLICK_EVAL_MIN,
      spendNoResultStreakDaysForP1: SPEND_NO_RESULT_STREAK_DAYS_FOR_P1,
    },
  };

  writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2) + '\n');
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  console.log(`[ad-money-guard] wrote ${STATUS_PATH} / ${STATE_PATH}`);
  console.log(`[ad-money-guard] overallSeverity=${overallSeverity} findings=${findings.length} (P1=${p1Findings.length})`);
  for (const f of findings) {
    console.log(`  - [${f.severity}] ${f.channel}/${f.type}: ${f.detail}`);
  }

  const title = '[P1] 広告費が実成果に結びついていません';
  const bodyLines = [
    `検知時刻(JST): ${status.generatedAtJst}`,
    '',
    ...p1Findings.map((f) => `- **${f.channel}** (${f.type}): ${f.detail}`),
    '',
    'このIssueは ad-money-guard.mjs (決定論・LLM不使用) が自動起票。予算/入札変更・出稿停止などの金銭操作は一切行っていません(検知のみ)。',
    '対応の目安: Meta Pixel/CAPI・Google Ads CVタグの疎通確認、LP到達率・フォーム到達率の点検(ad-stop-rules.md参照)。',
    '',
    '実成果への結びつき/計測の復旧を検知すると次回実行時に自動クローズします。',
  ];
  await upsertGithubIssue({ title, bodyLines, isP1: overallSeverity === 'P1' });
}

main().catch((e) => {
  console.error('[ad-money-guard] fatal (non-blocking, exiting 0):', e);
});
