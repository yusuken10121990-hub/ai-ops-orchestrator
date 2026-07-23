#!/usr/bin/env node
// sns-stock-parser.mjs
//
// dev-integration (2026-07-23)。CMOが書く sns_posts_batch_*_argument_style.md
// (marketing/配下、ai-business-ops経由でchecko済みの想定) をパースし、
// {day, slot, service, text}[] の配列にする。フォーマットは
// `### HH:MM サービス名` の見出し+本文1行+採用理由/想定反論の箇条書き
// (2026-07-20 CMO確立フォーマット)。本文行の末尾URLは投稿文にそのまま含める
// (別フィールドには分離しない=投稿API呼び出し側はtextをそのまま渡すだけでよい)。

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function parseStockFile(filePath) {
  const raw = readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const posts = [];
  let currentDay = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const dayMatch = line.match(/^##\s+Day(\d+)/);
    if (dayMatch) {
      currentDay = Number(dayMatch[1]);
      continue;
    }
    const slotMatch = line.match(/^###\s+(\d{1,2}:\d{2})\s+(.+)$/);
    if (slotMatch && currentDay !== null) {
      const [, slot, service] = slotMatch;
      const bodyLine = (lines[i + 1] || '').trim();
      if (bodyLine && !bodyLine.startsWith('-')) {
        posts.push({ day: currentDay, slot, service: service.trim(), text: bodyLine });
      }
    }
  }
  return posts;
}

// marketing/ 配下の sns_posts_batch_*_argument_style.md のうち、最新(ファイル名
// 降順=日付降順)のものを返す。
export function latestStockFile(marketingDir) {
  const files = readdirSync(marketingDir)
    .filter((f) => /^sns_posts_batch_\d{8}_argument_style\.md$/.test(f))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  return path.join(marketingDir, files[0]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node sns-stock-parser.mjs <path-to-stock-file>');
    process.exit(1);
  }
  console.log(JSON.stringify(parseStockFile(file), null, 2));
}
