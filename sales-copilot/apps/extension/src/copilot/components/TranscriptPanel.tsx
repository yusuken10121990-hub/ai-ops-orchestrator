import type { TranscriptSegmentMessage } from '@sales-copilot/contracts';

const SRC: Record<TranscriptSegmentMessage['source'], string> = { SELF: '自分', REMOTE: '会議側', UNKNOWN: '不明' };

/** 文字起こし履歴（既定は折りたたみ）。テキストノードのみで描画。 */
export function TranscriptPanel({ segments }: { segments: TranscriptSegmentMessage[] }) {
  const recent = segments.slice(-40);
  return (
    <details className="transcript">
      <summary>文字起こし履歴（{segments.length}件）</summary>
      {recent.length === 0 ? <p className="dim small">まだありません</p> : null}
      <ul className="plain">
        {recent.map((s) => (
          <li key={s.segmentId}>
            <span className="src">{SRC[s.source]}:</span>
            <span>{s.text}</span>
            {!s.isFinal ? <span className="small dim">（暫定）</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
