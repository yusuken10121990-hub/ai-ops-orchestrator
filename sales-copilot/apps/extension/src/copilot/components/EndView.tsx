import type { ExportResult, StopReason } from '../../shared/runtime-messages';

const REASON: Record<StopReason, string> = {
  user_end: '終了しました',
  window_closed: 'ウィンドウを閉じたため終了しました',
  tab_closed: '会議タブが閉じられたため終了しました',
  track_ended: '会議タブの音声取得が終わったため終了しました（共有停止・権限取り消し等）',
  heartbeat_lost: '画面が応答しなくなったため取得を止めました',
  no_permission: '権限がないため終了しました',
  connection_failed: 'ローカルサーバーとの接続が切れた（または開始できなかった）ため終了しました',
  server_ended: 'サーバー側で終了しました',
  error: 'エラーのため終了しました',
};

export function EndView({
  reason,
  exportRequested,
  exportResult,
  onClose,
}: {
  reason: StopReason | null;
  exportRequested: boolean;
  exportResult: ExportResult | null;
  onClose(): void;
}) {
  return (
    <div className="app">
      <h1>商談の支援を終了しました</h1>
      <p role="status">{reason ? REASON[reason] : '終了しました'}。音声の取得・送信・解析はすべて止まっています。</p>
      <section className="box" aria-label="保存">
        {exportResult?.saved ? (
          <>
            <p>振り返りをこのPCに出力しました:</p>
            <p>
              <code>{exportResult.path}</code>
            </p>
            <p className="small tone-warn">機密情報を含む可能性があります。不要になったらファイルを削除してください。</p>
          </>
        ) : exportRequested && !exportResult ? (
          <p>出力結果をサーバーから受け取れませんでした（保存されたか確認できません）。サーバーの画面を確認してください。</p>
        ) : (
          <p>何も保存していません（会話と助言はメモリ上だけで、終了後に破棄されます）。{exportResult && !exportResult.saved ? `（${exportResult.reason}）` : ''}</p>
        )}
      </section>
      <p className="small dim">次の商談は、会議タブで拡張アイコンを押して新しく開始してください。</p>
      <button type="button" className="primary" onClick={onClose}>
        このウィンドウを閉じる
      </button>
    </div>
  );
}
