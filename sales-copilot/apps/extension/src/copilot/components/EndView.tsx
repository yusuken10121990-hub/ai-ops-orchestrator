import type { SessionEndReason } from '@sales-copilot/contracts';
import type { EndResult, StopReason } from '../../shared/runtime-messages';

/** サーバーが記録した終了理由（ログの endReason と同じ）。 */
export const SERVER_END_REASON: Record<SessionEndReason, string> = {
  user_end: '「終了」ボタン',
  window_closed: 'カンペ画面を閉じた',
  tab_closed: 'Meet のタブを閉じた',
  call_left: '通話から退出した',
  meet_lost: 'Meet のページとつながらないまま時間切れ',
  connection_lost: 'サーバーとの接続が切れたまま時間切れ',
  no_permission: '権限なし',
  error: 'エラー',
};

const REASON: Record<StopReason, string> = {
  user_end: '終了しました',
  window_closed: 'ウィンドウを閉じたため終了しました',
  tab_closed: '会議タブが閉じられたため終了しました',
  call_left: '通話から退出したため終了しました',
  meet_lost: 'Meet のページとつながらない状態が続いたため終了しました（ページを再読み込みした・別のページへ移動した等）',
  track_ended: '会議タブの音声取得が終わったため終了しました（共有停止・権限取り消し等）',
  heartbeat_lost: 'カンペ画面が応答しなくなったため取得を止めました',
  no_permission: '権限がないため終了しました',
  connection_failed: 'ローカルサーバーとの接続が切れたまま再接続できなかった（または開始できなかった）ため終了しました',
  server_ended: 'サーバー側で終了しました',
  error: 'エラーのため終了しました',
};

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function EndView({
  reason,
  exportRequested,
  result,
  onClose,
}: {
  reason: StopReason | null;
  exportRequested: boolean;
  /** null = まだ確認中。 */
  result: EndResult | null;
  onClose(): void;
}) {
  const known = result && result.source !== 'unknown' ? result : null;
  return (
    <div className="app">
      <h1>商談の支援を終了しました</h1>
      <p role="status">{reason ? REASON[reason] : '終了しました'}。音声の取得・送信・解析はすべて止まっています。</p>
      {known?.source === 'session.ended' ? (
        <p className="small dim" data-testid="server-ended">
          サーバー側の終了を確認しました
          {known.reviewAvailableUntil ? `（振り返りデータは ${hhmm(known.reviewAvailableUntil)} までサーバーのメモリに残り、その後消去されます）` : ''}。
        </p>
      ) : null}
      {known?.endReason ? (
        <p className="small dim" data-testid="end-reason">
          終了の理由（サーバーの記録）: {SERVER_END_REASON[known.endReason]}
        </p>
      ) : null}
      <section className="box" aria-label="保存">
        {known?.exportPath ? (
          <>
            <p>振り返りをこのPCに出力しました:</p>
            <p>
              <code data-testid="export-path">{known.exportPath}</code>
            </p>
            <p className="small tone-warn">機密情報を含む可能性があります。不要になったらファイルを削除してください（同じ名前の .md も出力されています）。</p>
          </>
        ) : exportRequested && !known ? (
          result === null ? (
            <p>出力結果を確認しています…</p>
          ) : (
            <p>
              出力結果をサーバーから受け取れませんでした（保存されたか確認できません）。サーバーを起動した画面のログと、
              <code>exports</code> フォルダを確認してください。
            </p>
          )
        ) : exportRequested && known ? (
          <p className="tone-warn">出力を選びましたが、サーバーは出力しませんでした（サーバーのログで原因を確認してください）。何も保存されていません。</p>
        ) : (
          <p data-testid="no-export">何も保存していません（会話と助言はメモリ上だけで、終了後に破棄されます）。</p>
        )}
      </section>
      <p className="small dim">次の商談は、Meet で通話に参加したときに出る「接続」を押すだけで始まります。</p>
      <button type="button" className="primary" onClick={onClose}>
        このウィンドウを閉じる
      </button>
    </div>
  );
}
