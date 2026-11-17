import { useEffect, useRef, useState } from 'react';
import type { ClientMessage, ManualAdviceKind, WarningMessage } from '@sales-copilot/contracts';
import { Meter } from '../../ui/common';
import type { OffscreenSnapshot } from '../../shared/runtime-messages';
import type { CardView } from '../state';
import { CardPanel } from './CardPanel';
import { NoticeLine, StatusLine, collectNotices, type StatusBarProps } from './StatusBar';
import { TranscriptPanel } from './TranscriptPanel';
import type { TranscriptSegmentMessage } from '@sales-copilot/contracts';

export interface LiveActions {
  sendClient(msg: ClientMessage): void;
  pin(adviceId: string): void;
  unpin(adviceId: string): void;
  setSelf(enabled: boolean): void;
  setPaused(paused: boolean): void;
  end(exportRequested: boolean): void;
  changeFont(delta: number): void;
  toggleTheme(): void;
  openOptions(): void;
  /** 商談中に商談目的を変える（1 タップ接続では会議名が仮の目的）。 */
  updatePurpose?(purpose: string): void;
}

export interface LiveViewProps extends Omit<StatusBarProps, 'onOpenOptions'> {
  view: CardView;
  transcript: TranscriptSegmentMessage[];
  warnings: WarningMessage[];
  levels: Record<'SELF' | 'REMOTE', number | null>;
  snapshot: OffscreenSnapshot;
  lastError: string | null;
  /** 今の商談目的（不明なら表示しない）。 */
  purpose?: string | null;
  actions: LiveActions;
  newId?: () => string;
}

interface ControlDef {
  key: string;
  label: string;
  run: () => void;
  pressed?: boolean;
  disabled?: boolean;
  danger?: boolean;
  primary?: boolean;
}

export function LiveView(props: LiveViewProps) {
  const { view, actions, snapshot } = props;
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [exportReq, setExportReq] = useState(false);
  const [feedbackDone, setFeedbackDone] = useState<string | null>(null);
  const [editingPurpose, setEditingPurpose] = useState<string | null>(null);
  const newId = props.newId ?? (() => crypto.randomUUID());
  const card = view.card;
  const pinned = view.mode === 'pinned';
  const live = snapshot.phase === 'live';

  const request = (kind: ManualAdviceKind) => actions.sendClient({ type: 'advice.request', kind, requestId: newId() });
  const feedback = (rating: 'helpful' | 'off') => {
    if (!card) return;
    actions.sendClient({ type: 'feedback', adviceId: card.adviceId, rating });
    setFeedbackDone(rating === 'helpful' ? '「役立った」を送りました' : '「ずれた」を送りました');
  };

  const controls: ControlDef[] = [
    { key: 'r', label: '切り返し', primary: true, run: () => request('rebuttal'), disabled: !live || snapshot.paused },
    { key: 'q', label: '次に聞く', primary: true, run: () => request('next_question'), disabled: !live || snapshot.paused },
    { key: 'n', label: '次の約束', primary: true, run: () => request('next_step'), disabled: !live || snapshot.paused },
    {
      key: 'p',
      label: pinned ? '固定解除' : '表示固定',
      run: () => (card ? (pinned ? actions.unpin(card.adviceId) : actions.pin(card.adviceId)) : undefined),
      pressed: pinned,
      disabled: !card || (!pinned && view.displayStatus === 'invalidated'),
    },
    { key: 'g', label: '役立った', run: () => feedback('helpful'), disabled: !card || !live },
    { key: 'b', label: 'ずれた', run: () => feedback('off'), disabled: !card || !live },
    {
      key: 'm',
      label: snapshot.selfEnabled ? '自分の音声取得OFF' : '自分の音声取得ON',
      run: () => actions.setSelf(!snapshot.selfEnabled),
      pressed: !snapshot.selfEnabled,
      disabled: !live,
    },
    {
      key: 's',
      label: snapshot.paused ? '解析再開' : '解析一時停止',
      run: () => actions.setPaused(!snapshot.paused),
      pressed: snapshot.paused,
      disabled: !live,
    },
    { key: 'e', label: '終了', run: () => setConfirmEnd(true), danger: true },
  ];

  const controlsRef = useRef(controls);
  controlsRef.current = controls;
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (ev.key === '+' || ev.key === '=') return void actions.changeFont(0.1);
      if (ev.key === '-') return void actions.changeFont(-0.1);
      if (ev.key === 'd') return void actions.toggleTheme();
      if (ev.key === 'Escape') return void setConfirmEnd(false);
      const c = controlsRef.current.find((x) => x.key === ev.key.toLowerCase());
      if (c && !c.disabled) {
        ev.preventDefault();
        c.run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions]);

  const notices = collectNotices({ snapshot, lastError: props.lastError, warnings: props.warnings });
  const primary = controls.filter((c) => c.primary);
  const secondary = controls.filter((c) => !c.primary && !c.danger);
  const danger = controls.filter((c) => c.danger);
  const btn = (c: ControlDef, cls: string) => (
    <button
      key={c.key}
      type="button"
      className={c.danger ? `${cls} danger` : cls}
      aria-keyshortcuts={c.key.toUpperCase()}
      aria-pressed={c.pressed === undefined ? undefined : c.pressed}
      disabled={c.disabled}
      onClick={c.run}
    >
      {c.label}
      <kbd>{c.key.toUpperCase()}</kbd>
    </button>
  );

  return (
    <div className="app live">
      <h1 className="sr-only">ZEROSYS カンペ</h1>
      <main className="prompter">
        <CardPanel view={view} onUnpin={card && pinned ? () => actions.unpin(card.adviceId) : undefined} />
        {pinned ? <p className="small dim">表示固定は画面の切替を止めるだけです。解析は続いています（止めるには「解析一時停止」）。</p> : null}
      </main>

      <div className="dock">
        <StatusLine
          snapshot={snapshot}
          status={props.status}
          usage={props.usage}
          onOpenOptions={actions.openOptions}
          onFont={actions.changeFont}
          onTheme={actions.toggleTheme}
        />
        <NoticeLine notices={notices} onOpenOptions={actions.openOptions} />
        {confirmEnd ? (
          <section className="box" aria-label="終了の確認">
            <p>
              <strong>商談を終了しますか？</strong> 音声取得・送信・解析をすべて止めます。再開には会議タブで新たに開始が必要です。
            </p>
            <label className="check">
              <input type="checkbox" checked={exportReq} onChange={(e) => setExportReq(e.target.checked)} />
              <span>
                振り返りをこのPCのファイルへ出力する（任意）
                <br />
                <span className="small tone-warn">出力ファイルには商談の機密情報が含まれる可能性があります。保管・削除はご自身で管理してください。</span>
              </span>
            </label>
            <div className="row">
              <button type="button" className="danger" onClick={() => actions.end(exportReq)}>
                終了する
              </button>
              <button type="button" onClick={() => setConfirmEnd(false)}>
                戻る
              </button>
            </div>
          </section>
        ) : (
          <div className="controls" role="toolbar" aria-label="操作">
            <div className="controls-primary">{primary.map((c) => btn(c, 'big'))}</div>
            <div className="controls-secondary">
              {secondary.map((c) => btn(c, 'compact'))}
              <span className="end-sep" aria-hidden="true" />
              {danger.map((c) => btn(c, 'compact'))}
            </div>
          </div>
        )}
        {feedbackDone ? (
          <p className="small dim" role="status">
            {feedbackDone}
          </p>
        ) : null}
      </div>

      <div className="extras">
        {props.purpose && actions.updatePurpose ? (
          editingPurpose === null ? (
            <p className="small">
              商談目的: {props.purpose}{' '}
              <button type="button" onClick={() => setEditingPurpose(props.purpose ?? '')}>
                変更
              </button>
            </p>
          ) : (
            <form
              className="row"
              aria-label="商談目的の変更"
              onSubmit={(ev) => {
                ev.preventDefault();
                const next = editingPurpose.trim();
                if (next) actions.updatePurpose?.(next.slice(0, 500));
                setEditingPurpose(null);
              }}
            >
              <label htmlFor="live-purpose" className="small">
                商談目的
              </label>
              <input id="live-purpose" type="text" maxLength={500} value={editingPurpose} onChange={(e) => setEditingPurpose(e.target.value)} autoFocus />
              <button type="submit" className="primary" disabled={!editingPurpose.trim()}>
                保存
              </button>
              <button type="button" onClick={() => setEditingPurpose(null)}>
                やめる
              </button>
            </form>
          )
        ) : null}
        {!snapshot.selfEnabled && live ? (
          <p className="small tone-info">自分の音声は取得していません（会議側だけを解析中）。</p>
        ) : (
          <p className="small dim">Meetでミュートしても、このアプリの自分の音声取得は止まりません。止めるには「自分の音声取得OFF」。</p>
        )}
        <details>
          <summary>音量</summary>
          <Meter name="会議側" db={props.levels.REMOTE} />
          <Meter name="自分" db={props.levels.SELF} note={snapshot.selfEnabled ? '取得なし' : '取得OFF'} />
        </details>
        <TranscriptPanel segments={props.transcript} />
      </div>
    </div>
  );
}
