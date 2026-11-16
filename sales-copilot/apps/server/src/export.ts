import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AdviceCard, AppliedFactRef, AudioGapRecord, ReviewTranscriptEntry, SessionMode, UsageSnapshot } from '@sales-copilot/contracts';
import type { LatencyStats } from './latency';

export interface SessionExport {
  sessionId: string;
  mode: SessionMode;
  startedAt: number;
  endedAt: number;
  purpose: string;
  customerName: string | null;
  appliedFacts: AppliedFactRef[];
  adviceLabel: string | null;
  transcript: ReviewTranscriptEntry[];
  advice: AdviceCard[];
  usage: UsageSnapshot;
  latency: LatencyStats;
  audioGaps: AudioGapRecord[];
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** 会話は HTML として扱わない。Markdown でも記号をエスケープしてそのまま文字列として出す。 */
function mdEscape(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (c) => `\\${c}`);
}

export function renderMarkdown(e: SessionExport): string {
  const lines: string[] = [];
  lines.push(`# 商談振り返り（${e.mode}）`);
  lines.push('');
  lines.push('> 機密情報を含む可能性があります。共有・保存先に注意してください。');
  lines.push('');
  lines.push(`- セッション: ${e.sessionId}`);
  lines.push(`- 開始: ${iso(e.startedAt)} / 終了: ${iso(e.endedAt)}`);
  if (e.customerName) lines.push(`- 顧客名: ${mdEscape(e.customerName)}`);
  lines.push(`- 商談目的: ${mdEscape(e.purpose)}`);
  lines.push(`- 適用した条件: ${e.appliedFacts.length ? e.appliedFacts.map((f) => `${f.factId}@v${f.version}`).join(', ') : 'なし'}`);
  if (e.adviceLabel) lines.push(`- 助言生成: ${e.adviceLabel}`);
  lines.push('');
  lines.push('## 文字起こし（確定のみ）');
  lines.push('');
  for (const u of e.transcript) {
    const who = u.source === 'SELF' ? '自分側' : u.source === 'REMOTE' ? '会議側' : '不明';
    const flag = u.flags.length ? ` [${u.flags.join(',')}]` : '';
    lines.push(`- ${mmss(u.startMs)} ${who}${flag}: ${mdEscape(u.text)}`);
  }
  lines.push('');
  lines.push('## 表示したカンペ');
  lines.push('');
  for (const c of e.advice) {
    lines.push(`- ${iso(c.createdAt)} [${c.status}] ${mdEscape(c.headline)}`);
    if (c.say) lines.push(`  - 次に言う一言: ${mdEscape(c.say)}`);
    if (c.avoid) lines.push(`  - 今は言わない: ${mdEscape(c.avoid)}`);
  }
  lines.push('');
  lines.push('## 使用量');
  lines.push('');
  lines.push(`- STT 秒数: 自分側 ${e.usage.sttSecondsBySource.SELF.toFixed(1)} / 会議側 ${e.usage.sttSecondsBySource.REMOTE.toFixed(1)}`);
  lines.push(`- LLM: ${e.usage.calls} 回 / 入力 ${e.usage.llmInputTokens} / 出力 ${e.usage.llmOutputTokens} トークン`);
  lines.push(
    `- 推定費用: ${e.usage.estimatedCost ? `${e.usage.estimatedCost.amount.toFixed(4)} ${e.usage.estimatedCost.currency}（${e.usage.estimatedCost.priceSource}, ${e.usage.estimatedCost.priceCheckedDate}）` : '価格表未設定のため算出しない'}`,
  );
  lines.push('');
  lines.push('## 遅延（発話終了推定→送信）');
  lines.push('');
  const s = e.latency.speechEndToSentMs;
  lines.push(`- n=${s.n} p50=${s.p50 ?? '-'}ms p95=${s.p95 ?? '-'}ms（開発目標 p50≤3000 / p95≤5000、保証ではない）`);
  if (e.audioGaps.length) {
    lines.push('');
    lines.push('## 音声の欠落区間');
    for (const g of e.audioGaps) lines.push(`- ${g.source} ${mmss(g.fromMs)}〜${mmss(g.toMs)}（${Math.round(g.droppedMs)}ms・${g.origin === 'client' ? '拡張側' : 'サーバー側'}: ${g.reason}）`);
  }
  lines.push('');
  return lines.join('\n');
}

/** exports/ へ JSON と Markdown を書き出し、JSON のパスを返す（本人が選んだ場合のみ呼ぶ）。 */
export function writeSessionExport(dir: string, e: SessionExport): { jsonPath: string; mdPath: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date(e.endedAt).toISOString().replace(/[:.]/g, '-');
  const base = path.join(dir, `session-${stamp}-${e.sessionId.replace(/[^A-Za-z0-9_-]/g, '')}`);
  const jsonPath = `${base}.json`;
  const mdPath = `${base}.md`;
  writeFileSync(jsonPath, JSON.stringify(e, null, 2), { mode: 0o600 });
  writeFileSync(mdPath, renderMarkdown(e), { mode: 0o600 });
  return { jsonPath, mdPath };
}
