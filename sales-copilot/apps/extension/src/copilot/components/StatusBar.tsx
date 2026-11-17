import { useState } from 'react';
import type { StatusMessage, UsageMessage, WarningMessage } from '@sales-copilot/contracts';
import { Badge } from '../../ui/common';
import { localSourceLabel, pipelineLabel, sourceFixHint, wsLabel, type Label, type Tone } from '../../shared/labels';
import type { OffscreenSnapshot } from '../../shared/runtime-messages';

export interface StatusBarProps {
  snapshot: OffscreenSnapshot;
  status: StatusMessage | null;
  usage: UsageMessage | null;
  onOpenOptions?: () => void;
}

const TONE_RANK: Record<Tone, number> = { error: 4, warn: 3, muted: 2, info: 1, ok: 0 };

function modeText(status: StatusMessage | null): string {
  if (!status) return '接続待ち';
  return status.mode === 'LIVE' ? 'LIVE' : 'OFFLINEテスト';
}

/**
 * 全体の状態を 1 つのラベルにまとめる（例「LIVE・正常」「LIVE・会議側が無音」）。
 * 一番重い問題だけを出し、詳細は StatusDetails で見る。色だけに頼らず文字で区別する。
 */
export function overallHealth({ snapshot, status, usage }: Pick<StatusBarProps, 'snapshot' | 'status' | 'usage'>): Label {
  const mode = modeText(status);
  const candidates: Label[] = [];
  const add = (prefix: string, l: Label) => candidates.push({ text: prefix ? `${prefix}${l.text}` : l.text, tone: l.tone });
  // 一時的に切れているだけ（画面共有・切替など）。商談は終わっていないことを最優先で伝える
  if (snapshot.reconnecting) return { text: `${mode}・再接続中（商談は続いています）`, tone: 'warn' };

  if (snapshot.ws !== 'open') add('サーバー', wsLabel(snapshot.ws));
  if (snapshot.paused) add('', { text: '解析一時停止中', tone: 'warn' });
  if (usage?.budget.level === 'blocked') add('', { text: '上限到達・新規処理停止', tone: 'error' });
  else if (usage?.budget.level === 'warn') add('', { text: '使用量が上限に接近', tone: 'warn' });

  for (const src of ['REMOTE', 'SELF'] as const) {
    const name = src === 'REMOTE' ? '会議側' : '自分側';
    const local = snapshot.sources[src];
    if (src === 'SELF' && local === 'user_off') {
      candidates.push({ text: '自分の音声OFF', tone: 'info' });
      continue;
    }
    const l = localSourceLabel(local);
    if (l.tone === 'error' || l.tone === 'warn') add(`${name}: `, l);
    else if (status && snapshot.ws === 'open' && local === 'capturing') {
      const p = pipelineLabel(status.pipelines.capture[src]);
      if (status.pipelines.capture[src].reason === 'silence') candidates.push({ text: `${name}が無音`, tone: src === 'REMOTE' ? 'warn' : 'info' });
      else if (p.tone === 'error' || p.tone === 'warn') add(`${name}: `, p);
    }
  }
  if (status && snapshot.ws === 'open') {
    for (const [name, p] of [
      ['文字起こし', status.pipelines.stt],
      ['助言', status.pipelines.advice],
    ] as const) {
      const l = pipelineLabel(p);
      if (l.tone === 'error' || l.tone === 'warn') add(`${name}: `, l);
    }
  }
  const worst = candidates.reduce<Label | null>((a, b) => (!a || TONE_RANK[b.tone] > TONE_RANK[a.tone] ? b : a), null);
  if (!worst) return { text: `${mode}・正常`, tone: 'ok' };
  const more = candidates.length > 1 ? `（ほか${candidates.length - 1}件）` : '';
  return { text: `${mode}・${worst.text}${more}`, tone: worst.tone };
}

export interface Notice {
  key: string;
  tone: 'error' | 'warn';
  text: string;
  openOptions?: boolean;
}

/**
 * 画面上部に出すお知らせ。同じ内容は 1 回だけ（key で重複除去）。重いもの（エラー）を先に並べる。
 * サーバー警告は warningId が毎回変わるので code + 本文で同一判定する。
 */
export function collectNotices(input: { snapshot: OffscreenSnapshot; lastError: string | null; warnings: WarningMessage[] }): Notice[] {
  const out: Notice[] = [];
  const seen = new Set<string>();
  const push = (n: Notice) => {
    if (seen.has(n.key)) return;
    seen.add(n.key);
    out.push(n);
  };
  if (input.lastError) push({ key: `error:${input.lastError}`, tone: 'error', text: input.lastError });
  for (const h of [sourceFixHint(input.snapshot.sources.REMOTE, 'REMOTE'), sourceFixHint(input.snapshot.sources.SELF, 'SELF')]) {
    if (h) push({ key: `hint:${h}`, tone: 'error', text: h, openOptions: h.includes('設定画面') });
  }
  // 自分の音声を自分で OFF にしたときは状態表示（「自分の音声OFF」）だけで伝える。サーバーの同じ趣旨の注意は重ねない。
  const selfOff = input.snapshot.sources.SELF === 'user_off';
  for (const w of [...input.warnings].reverse()) {
    if (selfOff && isSelfOffWarning(w)) continue;
    push({ key: `warning:${w.code}:${w.message}`, tone: 'warn', text: `注意: ${w.message}` });
  }
  return out;
}

/** サーバーの「自分の音声取得はOFF」注意（degraded_capture）。 */
function isSelfOffWarning(w: WarningMessage): boolean {
  return w.code === 'degraded_capture' && w.message.includes('自分の音声取得はOFF');
}

/** 詳細な状態（SPEC §4-3）。無音・権限なし・API未設定・通信断を区別する。普段は折りたたむ。 */
export function StatusBar({ snapshot, status, usage }: StatusBarProps) {
  const disconnected = snapshot.ws !== 'open';
  const stale = (l: Label): Label => (disconnected ? { text: '不明（通信断）', tone: 'muted' } : l);
  const mode = status?.mode ?? null;
  const stt = usage ? usage.sttSecondsBySource.SELF + usage.sttSecondsBySource.REMOTE + usage.sttSecondsBySource.UNKNOWN : null;
  return (
    <div className="statusbar" aria-label="状態の詳細">
      {mode ? <Badge label={{ text: mode === 'LIVE' ? 'LIVE' : 'OFFLINEテスト', tone: mode === 'LIVE' ? 'warn' : 'info' }} /> : null}
      <span className="item">
        会議側 <Badge label={localSourceLabel(snapshot.sources.REMOTE)} />
        {status && !disconnected && snapshot.sources.REMOTE === 'capturing' ? (
          <> <Badge label={pipelineLabel(status.pipelines.capture.REMOTE)} /></>
        ) : null}
      </span>
      <span className="item">
        自分側 <Badge label={localSourceLabel(snapshot.sources.SELF)} />
        {status && !disconnected && snapshot.sources.SELF === 'capturing' ? (
          <> <Badge label={pipelineLabel(status.pipelines.capture.SELF)} /></>
        ) : null}
      </span>
      <span className="item">
        外部送信 <Badge label={sendingLabel(snapshot, status)} />
      </span>
      <span className="item">
        文字起こし <Badge label={stale(pipelineLabel(status?.pipelines.stt))} />
      </span>
      <span className="item">
        助言 <Badge label={stale(pipelineLabel(status?.pipelines.advice))} />
      </span>
      <span className="item">
        サーバー <Badge label={wsLabel(snapshot.ws)} />
      </span>
      {snapshot.paused ? <Badge label={{ text: '解析一時停止中', tone: 'muted' }} /> : null}
      <span className="item">保存: {storageText(status)}</span>
      {usage ? (
        <span className="item">
          使用量: 文字起こし{Math.round(stt ?? 0)}秒 / 助言{usage.calls}回
          {usage.estimatedCost ? ` / 約${usage.estimatedCost.amount.toFixed(2)} ${usage.estimatedCost.currency}` : ' / 金額は価格表未設定'}
          {usage.budget.level !== 'ok' ? (
            <> <Badge label={usage.budget.level === 'warn' ? { text: '上限接近', tone: 'warn' } : { text: '上限到達・新規処理停止', tone: 'error' }} /></>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function sendingLabel(snapshot: OffscreenSnapshot, status: StatusMessage | null): Label {
  if (snapshot.ws !== 'open' || !status) return { text: '停止', tone: 'muted' };
  return status.externalSending ? { text: '送信中', tone: 'warn' } : { text: '送信なし', tone: 'muted' };
}

function storageText(status: StatusMessage | null): string {
  return status?.storage === 'export_on_end' ? '終了時に出力' : 'メモリのみ';
}

export interface StatusLineProps extends StatusBarProps {
  onFont(delta: number): void;
  onTheme(): void;
}

/**
 * 1 行の状態表示（折り返さない）。全体の状態 1 つ + 送信/保存（安全表示・常に見える）+「⋯」メニュー。
 * 文字サイズ・明暗は「⋯」の中（ショートカット + / - / d はそのまま）。状態を押すと詳細が上に開く。
 * 読み上げは状態の文言（.health-text）だけを polite で通知する（行全体を live にしない）。
 */
export function StatusLine(props: StatusLineProps) {
  const [open, setOpen] = useState(false);
  const health = overallHealth(props);
  const sending = sendingLabel(props.snapshot, props.status);
  const saving = props.status?.storage === 'export_on_end' ? '終了時に出力' : '保存なし';
  return (
    <div className="statusline-wrap">
      {open ? (
        <div id="status-details" className="status-details">
          <StatusBar snapshot={props.snapshot} status={props.status} usage={props.usage} />
        </div>
      ) : null}
      <div className="statusline" aria-label="状態">
        <button
          type="button"
          className={`health tone-${health.tone}`}
          aria-expanded={open}
          aria-controls="status-details"
          onClick={() => setOpen((v) => !v)}
          title="状態の詳細を開く"
        >
          <span className="dot" aria-hidden="true" />
          <span className="health-text" aria-live="polite">
            {health.text}
          </span>
          <span className="caret" aria-hidden="true">
            {open ? '▾' : '▴'}
          </span>
        </button>
        <span className="safety small">
          <span className={`tone-${sending.tone}`}>{sending.text === '停止' ? '外部送信停止' : sending.text}</span>・
          <span>{saving}</span>
        </span>
        <details className="menu">
          <summary aria-label="表示の設定（文字サイズ・明暗）" title="文字サイズ・明暗">
            ⋯
          </summary>
          <div className="menu-panel">
            <button type="button" aria-label="文字を小さく" aria-keyshortcuts="-" onClick={() => props.onFont(-0.1)}>
              A−<kbd>-</kbd>
            </button>
            <button type="button" aria-label="文字を大きく" aria-keyshortcuts="+" onClick={() => props.onFont(0.1)}>
              A＋<kbd>+</kbd>
            </button>
            <button type="button" aria-label="明暗の切替" aria-keyshortcuts="d" onClick={props.onTheme}>
              明暗<kbd>D</kbd>
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}

/** お知らせ 1 行。複数あれば「ほかN件」で開く（積み上げない）。 */
export function NoticeLine({ notices, onOpenOptions }: { notices: Notice[]; onOpenOptions?: () => void }) {
  const [all, setAll] = useState(false);
  if (notices.length === 0) return null;
  const shown = all ? notices : notices.slice(0, 1);
  return (
    <div className="notices">
      {shown.map((n, i) => (
        <div key={n.key} className={`notice-line ${n.tone}`} role={n.tone === 'error' ? 'alert' : 'status'}>
          <span className="notice-text">{n.text}</span>
          {n.openOptions && onOpenOptions ? (
            <button type="button" onClick={onOpenOptions}>
              設定画面を開く
            </button>
          ) : null}
          {i === 0 && notices.length > 1 ? (
            <button type="button" className="link" aria-expanded={all} onClick={() => setAll((v) => !v)}>
              {all ? '閉じる' : `ほか${notices.length - 1}件`}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
