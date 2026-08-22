// read-json.mjs — BOM耐性のあるJSON読み込み（orchestrator共通）
//
// 2026-08-23 の実障害:
//   automation-health-cloud は毎回 success で終わっていたが、中身は
//   localRunner.status="unknown" / error="Unexpected token '﻿' ... is not valid JSON"
//   になっていた。ローカルPC側のスケジューラが書く
//   ai-ops-config/memory/automation-heartbeat.json が UTF-8 BOM 付きで、
//   JSON.parse がBOMで落ちていたのが原因。
//
//   影響は「読めなかった」だけで終わらない。heartbeat=null になると
//   checkLocalTasks() のtask一覧が空集合になり、ローカルタスク9件が
//   実際には動いているのに 'never-fired' として偽警告になる。
//   同時にローカルランナーの死活監視そのものが盲目になる。
//   ワークフローは緑なので誰も気づかない ＝ 監視のFALSE PASS。
//
// ai-ops-config 側は scripts/safe-io.mjs / qa-gate.mjs / quality-os.mjs /
// ui-resource-manager.mjs が既に BOM を剥がす作法で統一されていた。
// orchestrator 側にその作法が無かっただけなので、ここで揃える。
//
// Windows(PowerShell)の既定出力がBOM付きである以上、
// 「PC側が書いたJSONをクラウド側が読む」経路では常にこれを通すこと。
import { readFileSync } from 'node:fs';

/** 先頭のUTF-8 BOM(U+FEFF)を取り除く。無ければそのまま返す。 */
export function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * BOM付きでも読めるJSON読み込み。
 * パース失敗は握りつぶさず例外のまま投げる（呼び出し側が状態として記録できるように）。
 */
export function readJson(path) {
  return JSON.parse(stripBom(readFileSync(path, 'utf8')));
}
