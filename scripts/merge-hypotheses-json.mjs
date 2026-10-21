#!/usr/bin/env node
// merge-hypotheses-json.mjs <ours.json> <theirs.json> <out.json>
//
// memory/ad-pipeline/strategy-hypotheses.json (Strategist Agent の仮説台帳) の
// 衝突を、中身の意味にもとづいて統合する。
//
// なぜ必要か（2026-10-21 実測、ai-ops-config の rivet-ux-learning run
// 39674534249）:
//   並行して走る複数のcloud loop (rivet-ui-learning / rivet-ux-learning /
//   ad-pipeline の各loop) が同じ短い時間帯にこのファイルへ書き込み、
//   「Commit & push generated learnings」が5回リトライ全敗した:
//     CONFLICT (content): Merge conflict in memory/ad-pipeline/strategy-hypotheses.json
//     [git-push-retry] conflict outside cache allowlist, cannot auto-resolve
//
//   このファイルは memory/*-state.json の累積カウンタとも、
//   memory/ad-metrics/**/*.json のような「丸ごと再生成されるスナップショット」
//   とも違う。安定した hypothesis_id を持つ各エントリを、別loopが
//   (a) 新規追加 し、(b) revision を上げて status を更新 する「構造化された台帳」
//   である。したがって:
//     - keep-ours (CACHE_ONLY_PATTERN) は誤り: 他方が追加した新しい仮説が
//       消える = データ損失。
//     - .gitattributes merge=union も誤り: テキストを機械的に連結するだけなので
//       無効なJSON、または同じ仮説の重複エントリになる。
//   正しい修正は merge-state-json.mjs と同じ「意味を理解した統合」を、
//   id単位の配列に対して行うこと。
//
// 統合ルール（どちらの側の仮説も失わない。推測で混ぜない）:
//   - トップレベルのオブジェクト（_comment, schema 等）は ours をベースに保持。
//     updated_at は新しい方（文字列比較で大きい方）を採る。
//   - items / hypotheses のうち存在する配列はそれぞれ、エントリの
//     hypothesis_id（無ければ id。どちらも無ければ統合できないので失敗）を
//     キーに union する。
//   - 同じキーが両側にあるとき:
//       revision が両方数値で異なれば大きい方を採る。
//       revision が無い/同じなら revised_at → updated_at → proposed_at →
//       created_at の優先順でタイムスタンプ文字列を比較し、新しい方を採る。
//       それでも決められなければ ours を採る（取りこぼしはしない。
//       どちらを採ってもキー自体は必ず残る）。
//   - 片側にしか無いキーは無条件で残す。
//   - 想定外の形（トップレベルが object でない／items・hypothesesのどちらも
//     既知の配列ではない／エントリに安定したキーが無い）は 1 を返して
//     失敗させる。呼び出し側（git-push-retry.sh）はこれを「中断」として扱う。

import fs from 'node:fs';

const [oursPath, theirsPath, outPath] = process.argv.slice(2);
if (!oursPath || !theirsPath || !outPath) {
  console.error('usage: merge-hypotheses-json.mjs <ours.json> <theirs.json> <out.json>');
  process.exit(1);
}

function read(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`[merge-hypotheses] ${p} を読めません: ${e.message}`); process.exit(1); }
}

const ours = read(oursPath);
const theirs = read(theirsPath);

const ARRAY_KEYS = ['items', 'hypotheses'];
const TIMESTAMP_KEYS = ['revised_at', 'updated_at', 'proposed_at', 'created_at'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function hasKnownShape(obj) {
  if (!isPlainObject(obj)) return false;
  const present = ARRAY_KEYS.filter((k) => k in obj);
  if (present.length === 0) return false;
  return present.every((k) => Array.isArray(obj[k]));
}

if (!hasKnownShape(ours) || !hasKnownShape(theirs)) {
  console.error('[merge-hypotheses] items/hypotheses 配列を持つ既知の形ではないため自動統合しません');
  process.exit(1);
}

// hypothesis_id を優先し、無ければ id にフォールバックする。
// どちらも無いエントリは安全に同一視できないため統合しない（失敗させる）。
function entryKey(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.hypothesis_id === 'string' && entry.hypothesis_id) return `hid:${entry.hypothesis_id}`;
  if (typeof entry.id === 'string' && entry.id) return `id:${entry.id}`;
  return null;
}

function timestampOf(entry) {
  for (const k of TIMESTAMP_KEYS) {
    if (entry && typeof entry[k] === 'string' && entry[k]) return entry[k];
  }
  return '';
}

function pickWinner(a, b) {
  const ra = Number.isFinite(a.revision) ? a.revision : null;
  const rb = Number.isFinite(b.revision) ? b.revision : null;
  if (ra !== null && rb !== null && ra !== rb) {
    return ra > rb ? a : b;
  }
  const ta = timestampOf(a);
  const tb = timestampOf(b);
  if (ta && tb && ta !== tb) {
    return ta > tb ? a : b;
  }
  // 決められないときは取りこぼさないよう ours を採る（キー自体は必ず残る）。
  return a;
}

let abort = false;

function mergeArray(oursArr, theirsArr) {
  const order = [];
  const byKey = new Map();

  for (const entry of oursArr) {
    const key = entryKey(entry);
    if (key === null) { abort = true; return []; }
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, entry);
  }
  for (const entry of theirsArr) {
    const key = entryKey(entry);
    if (key === null) { abort = true; return []; }
    if (byKey.has(key)) {
      byKey.set(key, pickWinner(byKey.get(key), entry));
    } else {
      order.push(key);
      byKey.set(key, entry);
    }
  }
  return order.map((k) => byKey.get(k));
}

const merged = { ...ours };
for (const k of ARRAY_KEYS) {
  const oursArr = Array.isArray(ours[k]) ? ours[k] : [];
  const theirsArr = Array.isArray(theirs[k]) ? theirs[k] : [];
  if (!(k in ours) && !(k in theirs)) continue;
  merged[k] = mergeArray(oursArr, theirsArr);
  if (abort) {
    console.error(`[merge-hypotheses] "${k}" 配列に hypothesis_id/id を持たないエントリがあるため自動統合しません`);
    process.exit(1);
  }
}

const oursUpdated = typeof ours.updated_at === 'string' ? ours.updated_at : '';
const theirsUpdated = typeof theirs.updated_at === 'string' ? theirs.updated_at : '';
if (oursUpdated || theirsUpdated) {
  merged.updated_at = theirsUpdated > oursUpdated ? theirsUpdated : oursUpdated;
}

fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n');
const counts = ARRAY_KEYS
  .filter((k) => Array.isArray(merged[k]))
  .map((k) => `${k}=${merged[k].length}`)
  .join(' ');
console.log(`[merge-hypotheses] 統合しました ${counts} updated_at=${merged.updated_at || 'N/A'}`);
