/**
 * Meet 参加時の「接続／拒否」ポップアップの状態（純粋関数。DOM・chrome API に依存しない）。
 *
 * - 会議コード（xxx-xxxx-xxx）のページで、通話に参加したと分かったら 1 回だけ出す。
 * - 「拒否」はその会議コードについてタブが開いている間は覚え、再表示しない（何も取得しない）。
 * - 「接続」の 1 タップが開始操作。商談相手への説明・同意（開始前画面の②）の確認を兼ねる。
 */

/** https://meet.google.com/abc-defg-hij（末尾の / やクエリは許容）から会議コードを取り出す。 */
export function parseMeetingCode(href: string): string | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'meet.google.com') return null;
  const m = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/.exec(u.pathname);
  return m ? m[1]! : null;
}

/** 会議ごとの判断の保存先（実装は sessionStorage ＝ そのタブが開いている間だけ）。 */
export interface DecisionStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const KEY_PREFIX = 'zerosys-copilot:decision:';
export function isDeclined(store: DecisionStore, code: string): boolean {
  try {
    return store.get(KEY_PREFIX + code) === 'declined';
  } catch {
    return false;
  }
}
export function rememberDeclined(store: DecisionStore, code: string): void {
  try {
    store.set(KEY_PREFIX + code, 'declined');
  } catch {
    /* 保存できなくても、このページ内の状態では再表示しない */
  }
}

export type PopupState =
  | { kind: 'hidden'; code: string | null }
  | { kind: 'prompt'; code: string }
  | { kind: 'connecting'; code: string }
  | { kind: 'connected'; code: string }
  | { kind: 'declined'; code: string }
  /** 接続した後に終了した（同じページでは自動で出し直さない。再開は拡張アイコンかページの再読み込み）。 */
  | { kind: 'ended'; code: string }
  | { kind: 'error'; code: string; message: string };

export type PopupEvent =
  /** 会議ページを見た（joined = 通話参加を確認できた）。 */
  | { type: 'observe'; code: string | null; joined: boolean; declined: boolean }
  | { type: 'connect' }
  | { type: 'decline' }
  | { type: 'connect.ok' }
  | { type: 'connect.fail'; message: string }
  /** 取得が終わった（終了・ウィンドウを閉じた等）。 */
  | { type: 'capture.ended' }
  | { type: 'dismiss' };

export const initialPopupState: PopupState = { kind: 'hidden', code: null };

export function popupReducer(s: PopupState, e: PopupEvent): PopupState {
  switch (e.type) {
    case 'observe': {
      if (e.code === null) return { kind: 'hidden', code: null };
      // 別の会議へ移った: 前の会議の状態は持ち越さない
      if (e.code !== s.code) {
        if (e.declined) return { kind: 'declined', code: e.code };
        return e.joined ? { kind: 'prompt', code: e.code } : { kind: 'hidden', code: e.code };
      }
      if (s.kind === 'hidden' && e.joined && !e.declined) return { kind: 'prompt', code: e.code };
      return s;
    }
    case 'connect':
      return s.kind === 'prompt' || s.kind === 'error' ? { kind: 'connecting', code: s.code } : s;
    case 'decline':
      return s.kind === 'prompt' || s.kind === 'error' ? { kind: 'declined', code: s.code } : s;
    case 'connect.ok':
      return s.kind === 'connecting' ? { kind: 'connected', code: s.code } : s;
    case 'connect.fail':
      return s.kind === 'connecting' ? { kind: 'error', code: s.code, message: e.message } : s;
    case 'capture.ended':
      // 接続していた会議だけ。終了直後に勝手に出し直さない
      return s.kind === 'connected' || s.kind === 'connecting' ? { kind: 'ended', code: s.code } : s;
    case 'dismiss':
      // ×で閉じた: 拒否と同じ扱い（何も取得しない・再表示しない）
      return s.kind === 'prompt' || s.kind === 'error' ? { kind: 'declined', code: s.code } : s;
  }
}

/** 画面に出すか。 */
export function isPopupVisible(s: PopupState): boolean {
  return s.kind === 'prompt' || s.kind === 'connecting' || s.kind === 'error';
}

/**
 * 商談目的の既定値: Meet のタブタイトル（「Meet - 」等を除く）。名前が無ければ会議コード入り。
 * 開始を止めないための既定値で、商談中に変更できる。
 */
export function purposeFromMeetTitle(title: string | null | undefined, code: string | null): string {
  let t = (title ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(Google\s+)?Meet\s*[-–—:：]\s*/i, '').replace(/\s*[-–—]\s*(Google\s+)?Meet$/i, '').trim();
  if (!t || /^(Google\s+)?Meet$/i.test(t) || (code && t === code)) t = code ? `Google Meet の商談（${code}）` : 'Google Meet の商談';
  return t.slice(0, 500);
}
