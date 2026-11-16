import type { StatusMessage, UsageMessage } from '@sales-copilot/contracts';
import { Badge } from '../../ui/common';
import { localSourceLabel, pipelineLabel, sourceFixHint, wsLabel, type Label } from '../../shared/labels';
import type { OffscreenSnapshot } from '../../shared/runtime-messages';

export interface StatusBarProps {
  snapshot: OffscreenSnapshot;
  status: StatusMessage | null;
  usage: UsageMessage | null;
  onOpenOptions?: () => void;
}

/** 小さく常時表示する状態（SPEC §4-3）。無音・権限なし・API未設定・通信断を区別する。 */
export function StatusBar({ snapshot, status, usage, onOpenOptions }: StatusBarProps) {
  const disconnected = snapshot.ws !== 'open';
  const stale = (l: Label): Label => (disconnected ? { text: '不明（通信断）', tone: 'muted' } : l);
  const mode = status?.mode ?? null;
  const selfLocal = localSourceLabel(snapshot.sources.SELF);
  const remoteLocal = localSourceLabel(snapshot.sources.REMOTE);
  const hints = [sourceFixHint(snapshot.sources.REMOTE, 'REMOTE'), sourceFixHint(snapshot.sources.SELF, 'SELF')].filter(
    (h): h is string => !!h,
  );
  const stt = usage ? usage.sttSecondsBySource.SELF + usage.sttSecondsBySource.REMOTE + usage.sttSecondsBySource.UNKNOWN : null;
  return (
    <>
      <div className="statusbar" role="status" aria-label="状態">
        {mode ? <Badge label={{ text: mode === 'LIVE' ? 'LIVE' : 'OFFLINEテスト', tone: mode === 'LIVE' ? 'warn' : 'info' }} /> : null}
        <span className="item">
          会議側 <Badge label={remoteLocal} />
          {status && !disconnected && snapshot.sources.REMOTE === 'capturing' ? (
            <> <Badge label={pipelineLabel(status.pipelines.capture.REMOTE)} /></>
          ) : null}
        </span>
        <span className="item">
          自分側 <Badge label={selfLocal} />
          {status && !disconnected && snapshot.sources.SELF === 'capturing' ? (
            <> <Badge label={pipelineLabel(status.pipelines.capture.SELF)} /></>
          ) : null}
        </span>
        <span className="item">
          外部送信{' '}
          <Badge
            label={
              disconnected || !status
                ? { text: '停止', tone: 'muted' }
                : status.externalSending
                  ? { text: '送信中', tone: 'warn' }
                  : { text: '送信なし', tone: 'muted' }
            }
          />
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
        <span className="item">保存: {status?.storage === 'export_on_end' ? '終了時に出力' : 'メモリのみ'}</span>
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
      {hints.map((h) => (
        <div key={h} className="notice error" role="alert">
          {h}{' '}
          {onOpenOptions && h.includes('設定画面') ? (
            <button type="button" onClick={onOpenOptions}>
              設定画面を開く
            </button>
          ) : null}
        </div>
      ))}
    </>
  );
}
