/**
 * Meet ページ（content script）側の「切れても終わらせない」ルール（純粋関数。DOM・chrome API に依存しない）。
 *
 * 2026-11-17 の実商談で、画面共有やタブ／ウィンドウの切替のたびに商談が勝手に終わった。
 * 終わってよいのは「終了」ボタン・カンペ画面を閉じた・Meet のタブを閉じた・通話から退出した、の 4 つだけ。
 * - offscreen との Port が切れたら、商談が終わった合図（stop.all）を受けていない限り、少しずつ間隔を空けてつなぎ直す。
 * - 通話からの退出は「相手の音声トラックが 1 本も無い」かつ「退出ボタンが無い」状態が続いたときだけ。
 *   タブを隠す・画面共有・Meet 内の画面遷移（URL が一時的に変わる等）では退出とみなさない。
 */

/** つなぎ直しを諦めるまで（offscreen 側の待ち時間 IN_PAGE_GRACE_MS=45 秒より短く）。 */
export const RECONNECT_MAX_MS = 40_000;
/** 退出らしい状態がこれだけ続いたら退出とみなす。 */
export const LEFT_CONFIRM_MS = 8_000;

/** n 回目（0 始まり）のつなぎ直しまでの待ち時間。 */
export function reconnectDelay(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt), 4_000);
}

export interface LeaveObservation {
  now: number;
  /** 今の URL の会議コード（Meet 内の別画面なら null）。 */
  code: string | null;
  /** 接続中の商談の会議コード。 */
  liveCode: string;
  /** 相手の音声トラックが 1 本以上ある、または退出ボタンが見えている。 */
  inCall: boolean;
}

/** 通話からの退出の判定（ページ内の移動・画面共有・タブ切替では退出にしない）。 */
export class LeaveDetector {
  private outSince: number | null = null;

  observe(o: LeaveObservation): 'in_call' | 'maybe_left' | 'left' {
    // 別の会議へ移った: 前の会議からは確実に退出している
    if (o.code !== null && o.code !== o.liveCode) return 'left';
    if (o.inCall) {
      this.outSince = null;
      return 'in_call';
    }
    if (this.outSince === null) this.outSince = o.now;
    return o.now - this.outSince >= LEFT_CONFIRM_MS ? 'left' : 'maybe_left';
  }

  reset(): void {
    this.outSince = null;
  }
}
