import type { AdviceCard, AdviceInvalidationReason, AdviceKind, EvidenceLevel } from '@sales-copilot/contracts';
import { Badge } from '../../ui/common';
import { cardStatusLabel } from '../../shared/labels';
import type { CardView } from '../state';

/**
 * カンペ表示。会話・助言は全て React のテキストノードとして描画する（HTML として解釈しない／XSS 対策）。
 * 【次に言う一言】を一番大きく（ひと目で読める）。【今の一手】はその上に小さく、【今は言わない】と根拠は下に控えめに。
 */

const KIND_LABEL: Record<AdviceKind, string> = {
  answer: '返答',
  clarify: '確認',
  reframe: '切り返し',
  next_step: '次の一歩',
  risk: '注意',
  listen: '聞く',
};
const EVIDENCE_LABEL: Record<EvidenceLevel, string> = {
  supported: '根拠あり',
  tentative: '仮（要確認）',
  insufficient: '根拠不足',
};
export const INVALID_REASON_LABEL: Record<AdviceInvalidationReason, string> = {
  transcript_revised: '発言の文字起こしが訂正されました',
  context_changed: '会話の前提が変わりました',
  stale: '時間が経ちました',
  superseded: '新しいカードに置き換わりました',
  fact_revoked: '使っていた条件の承認が外れました',
  validation_failed: '表示前の検証に通りませんでした',
  session_ended: '商談が終了しました',
};

function triggerLabel(c: AdviceCard): string | null {
  switch (c.trigger) {
    case 'manual_rebuttal':
      return '切り返し（手動）';
    case 'manual_next_question':
      return '次に聞く（手動）';
    case 'manual_next_step':
      return '次の約束（手動）';
    default:
      return null;
  }
}

export interface CardPanelProps {
  view: CardView;
  onUnpin?: () => void;
}

export function CardPanel({ view, onUnpin }: CardPanelProps) {
  if (!view.card || !view.displayStatus) {
    return (
      <section className="card status-empty" aria-label="カンペ" aria-live="polite">
        <div className="card-top">
          <span className="slot-label">【今の一手】</span>
          <span className="headline">待機</span>
        </div>
        <div className="slot-label say-label">【次に言う一言】</div>
        <div className="say-empty">今は相手の説明を聞く場面です。必要になったらここに表示します。</div>
      </section>
    );
  }
  const c = view.card;
  const status = view.displayStatus;
  const invalid = status === 'invalidated';
  const quiet = c.action !== 'show';
  const trig = triggerLabel(c);
  return (
    <section className={`card status-${status}`} aria-label="カンペ" aria-live="polite" data-advice-id={c.adviceId}>
      <div className="card-top">
        <span className="slot-label">【今の一手】</span>
        <span className="headline">{quiet ? c.headline || '待機' : c.headline}</span>
        <span className="chips">
          <Badge label={cardStatusLabel(status)} prefix="状態" />
          {view.mode === 'pinned' ? <Badge label={{ text: '表示固定中', tone: 'info' }} /> : null}
          <span className="badge tone-muted">{KIND_LABEL[c.kind]}</span>
          {trig ? <span className="badge tone-muted">{trig}</span> : null}
        </span>
      </div>

      <div className="slot-label say-label">
        【次に言う一言】
        {status === 'reference' && !invalid ? <span className="tone-warn"> 参考扱いです（現行の推奨ではありません）</span> : null}
      </div>
      {invalid ? (
        <div className="notice-line error" role="alert">
          このカードは無効です
          {view.invalidReason ? `（${INVALID_REASON_LABEL[view.invalidReason]}）` : ''}。この内容では話さないでください。
        </div>
      ) : quiet || !c.say ? (
        <div className="say-empty">{quiet ? '今は相手の説明を聞く' : '（今は言うことはありません）'}</div>
      ) : (
        <div className="say" lang="ja">
          {c.say}
        </div>
      )}

      {view.hasNewerCard ? (
        <div className="notice-line warn" role="status">
          <span className="notice-text">新しいカードがあります（表示固定中のため切り替えていません）。</span>
          {onUnpin ? (
            <button type="button" onClick={onUnpin}>
              固定を解除して新しいカードを見る
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="avoid-line">
        <span className="slot-label">【今は言わない】</span> <span className="avoid">{invalid ? '—' : c.avoid ?? '特になし'}</span>
      </div>

      {view.warnings.length > 0 ? (
        <ul className="plain small card-warnings" aria-label="注意">
          {view.warnings.map((w) => (
            <li key={w.code} className="tone-warn">
              注意: {w.message}
            </li>
          ))}
        </ul>
      ) : null}

      <details className="reason">
        <summary>根拠・確認事項</summary>
        <p>
          <span className="badge tone-muted">{EVIDENCE_LABEL[c.evidenceLevel]}</span> {c.briefReason}
        </p>
        {c.missingItems.length > 0 ? (
          <>
            <p className="small dim">まだ確認できていないこと:</p>
            <ul>
              {c.missingItems.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </>
        ) : null}
        {c.approvedFactIds.length > 0 ? <p className="small dim">使用した承認済み条件: {c.approvedFactIds.length}件</p> : null}
      </details>
    </section>
  );
}
