/**
 * 状態ラベル（日本語）。色だけに頼らず文字で区別する（SPEC §4-1, §4-3）。
 * 「無音」「権限なし」「API未設定」「通信断」「遅延」「エラー」「一時停止」を同じ「待機」にしない。
 */
import type { AdviceCardStatus, PipelineStatus, StatusReason } from '@sales-copilot/contracts';
import type { LocalSourceState, WsState } from './runtime-messages';

export type Tone = 'ok' | 'info' | 'warn' | 'error' | 'muted';

export interface Label {
  text: string;
  tone: Tone;
}

const REASON_LABEL: Partial<Record<StatusReason, Label>> = {
  silence: { text: '無音', tone: 'info' },
  no_permission: { text: '権限なし', tone: 'error' },
  tab_closed: { text: 'タブ終了', tone: 'error' },
  track_ended: { text: '取得終了', tone: 'error' },
  device_changed: { text: 'デバイス変更', tone: 'warn' },
  source_lost: { text: '取得断', tone: 'error' },
  self_capture_off: { text: '自分OFF', tone: 'muted' },
  degraded_single_source: { text: '片側のみ', tone: 'warn' },
  backpressure_drop: { text: '音声欠落', tone: 'warn' },
  not_configured: { text: 'API未設定', tone: 'error' },
  disconnected: { text: '通信断', tone: 'error' },
  reconnecting: { text: '再接続中', tone: 'warn' },
  auth_failed: { text: '認証失敗', tone: 'error' },
  rate_limited: { text: '制限中', tone: 'warn' },
  timeout: { text: '時間切れ', tone: 'warn' },
  upstream_error: { text: '外部エラー', tone: 'error' },
  invalid_output: { text: '不正出力', tone: 'warn' },
  budget_warning: { text: '上限接近', tone: 'warn' },
  budget_exceeded: { text: '上限到達', tone: 'error' },
  cooldown: { text: '間隔待ち', tone: 'info' },
  generating: { text: '生成中', tone: 'ok' },
  listening: { text: '聞く場面', tone: 'info' },
  user_paused: { text: '一時停止', tone: 'muted' },
  session_ended: { text: '終了', tone: 'muted' },
  offline_mode: { text: 'OFFLINE', tone: 'info' },
};

export function pipelineLabel(p: PipelineStatus | null | undefined): Label {
  if (!p) return { text: '不明', tone: 'muted' };
  if (p.reason) {
    const r = REASON_LABEL[p.reason];
    if (r) return r;
  }
  switch (p.state) {
    case 'active':
      return { text: '動作中', tone: 'ok' };
    case 'idle':
      return { text: '待機', tone: 'muted' };
    case 'waiting':
      return { text: '待機', tone: 'info' };
    case 'delayed':
      return { text: '遅延', tone: 'warn' };
    case 'error':
      return { text: 'エラー', tone: 'error' };
    case 'not_configured':
      return { text: 'API未設定', tone: 'error' };
    case 'offline':
      return { text: '通信断', tone: 'error' };
    case 'paused':
      return { text: '一時停止', tone: 'muted' };
  }
}

export function localSourceLabel(s: LocalSourceState): Label {
  switch (s) {
    case 'off':
      return { text: '停止中', tone: 'muted' };
    case 'armed':
      return { text: '音量確認のみ', tone: 'info' };
    case 'capturing':
      return { text: '取得中', tone: 'ok' };
    case 'paused':
      return { text: '一時停止', tone: 'muted' };
    case 'user_off':
      return { text: '取得OFF', tone: 'muted' };
    case 'no_permission':
      return { text: '権限なし', tone: 'error' };
    case 'track_ended':
      return { text: '取得終了', tone: 'error' };
    case 'tab_closed':
      return { text: 'タブ終了', tone: 'error' };
    case 'device_changed':
      return { text: 'デバイス変更', tone: 'warn' };
    case 'error':
      return { text: 'エラー', tone: 'error' };
  }
}

export function wsLabel(s: WsState): Label {
  switch (s) {
    case 'none':
      return { text: '未接続', tone: 'muted' };
    case 'connecting':
      return { text: '接続中', tone: 'info' };
    case 'open':
      return { text: '接続', tone: 'ok' };
    case 'closed':
      return { text: '通信断', tone: 'error' };
    case 'error':
      return { text: '通信エラー', tone: 'error' };
    case 'unauthorized':
      return { text: '認証失敗', tone: 'error' };
  }
}

export function cardStatusLabel(s: AdviceCardStatus): Label {
  switch (s) {
    case 'current':
      return { text: '現行', tone: 'ok' };
    case 'reference':
      return { text: '参考', tone: 'warn' };
    case 'invalidated':
      return { text: '無効', tone: 'error' };
  }
}

/** ローカルで分かる問題に対して「どうすれば直るか」を添える（行き止まり表示にしない）。 */
export function sourceFixHint(s: LocalSourceState, source: 'SELF' | 'REMOTE'): string | null {
  if (source === 'SELF' && s === 'no_permission') return '設定画面でマイクを許可してから「自分の音声取得ON」を押してください';
  if (source === 'SELF' && s === 'device_changed') return 'マイクが外れました。設定画面でマイクを選び直し「自分の音声取得ON」を押してください';
  if (source === 'SELF' && s === 'track_ended') return '「自分の音声取得ON」で取り直せます';
  if (source === 'REMOTE' && (s === 'tab_closed' || s === 'track_ended'))
    return '会議タブの取得が終わりました。会議タブで拡張アイコンを押して新しく開始してください';
  if (source === 'REMOTE' && (s === 'no_permission' || s === 'error'))
    return '会議タブを表示した状態で拡張アイコンをもう一度押してください';
  return null;
}
