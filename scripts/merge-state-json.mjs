#!/usr/bin/env node
// merge-state-json.mjs <ours.json> <theirs.json> <out.json>
//
// memory/*-state.json の衝突を、中身の意味にもとづいて統合する。
//
// なぜ必要か（2026-08-21 実測）:
//   ad-pdca-daily の schedule 実行が「Commit & push generated learnings」で
//   5回リトライ全敗していた。原因は memory/ad-money-guard-state.json の衝突で、
//   git-push-retry.sh の keep-ours 許可リスト(`*-status.json`)に -state.json が
//   入っていなかったこと。
//
//   ただし -state.json を単純に許可リストへ足すのは誤り。この中の streakDays は
//   「広告費を使っているのに成果0の連続日数」を1日1回だけ加算する累積カウンタで、
//   ad-money-guard.mjs:219 が lastEvaluatedDate で二重加算を防いでいる。
//   keep-ours で潰すと加算が消え、**金銭のP1アラートが出るのが遅れる**。
//
// 統合ルール（加算を落とさず、二重にも数えない）:
//   - lastEvaluatedDate が新しい側を採用する。その側は既にその日の評価を終えている。
//   - 日付が同じなら、同じ日を評価した結果なので値は一致するはず。
//     念のため streakDays は大きい方を採る（取りこぼすより安全側）。
//   - 判断できない形のときは 1 を返して失敗させる。推測で混ぜない。

import fs from 'node:fs';

const [oursPath, theirsPath, outPath] = process.argv.slice(2);
if (!oursPath || !theirsPath || !outPath) {
  console.error('usage: merge-state-json.mjs <ours.json> <theirs.json> <out.json>');
  process.exit(1);
}

function read(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`[merge-state] ${p} を読めません: ${e.message}`); process.exit(1); }
}

const ours = read(oursPath);
const theirs = read(theirsPath);

/* 想定する形: { version, channels: { <key>: { streakDays, lastEvaluatedDate, lastSnapshot } } }
   これ以外の形は混ぜずに失敗させる。 */
if (!ours || !theirs || typeof ours !== 'object' || typeof theirs !== 'object'
    || !ours.channels || !theirs.channels) {
  console.error('[merge-state] channels を持つ既知の形ではないため自動統合しません');
  process.exit(1);
}

function newer(a, b) {
  const da = a && a.lastEvaluatedDate ? String(a.lastEvaluatedDate) : '';
  const db = b && b.lastEvaluatedDate ? String(b.lastEvaluatedDate) : '';
  if (da === db) return null;
  return da > db ? a : b;
}

const merged = { ...ours, channels: {} };
const keys = new Set([...Object.keys(ours.channels), ...Object.keys(theirs.channels)]);

for (const k of keys) {
  const a = ours.channels[k];
  const b = theirs.channels[k];
  if (!a) { merged.channels[k] = b; continue; }
  if (!b) { merged.channels[k] = a; continue; }

  const win = newer(a, b);
  if (win) {
    merged.channels[k] = win;
  } else {
    /* 同じ日を評価した結果同士。値は一致するはずだが、取りこぼしを避けて大きい方を採る。 */
    const base = a;
    merged.channels[k] = {
      ...base,
      streakDays: Math.max(Number(a.streakDays || 0), Number(b.streakDays || 0)),
      lastSnapshot: (a.lastSnapshot && b.lastSnapshot
        && String(a.lastSnapshot.checkedAt || '') >= String(b.lastSnapshot.checkedAt || ''))
        ? a.lastSnapshot : (b.lastSnapshot || a.lastSnapshot)
    };
  }
}

fs.writeFileSync(outPath, JSON.stringify(merged, null, 2) + '\n');
const summary = Object.keys(merged.channels)
  .map((k) => `${k}:streak=${merged.channels[k].streakDays}@${merged.channels[k].lastEvaluatedDate}`)
  .join(' ');
console.log(`[merge-state] 統合しました ${summary}`);
