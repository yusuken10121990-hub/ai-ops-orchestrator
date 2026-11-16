import { useMemo, useState } from 'react';
import type { ApprovedFact, AppliedFactRef, SessionMode } from '@sales-copilot/contracts';
import { Badge, Meter, hasMicPermission, useAudioInputs, useLocalMicTest } from '../../ui/common';
import { localSourceLabel, sourceFixHint } from '../../shared/labels';
import type { OffscreenSnapshot, TargetInfo } from '../../shared/runtime-messages';
import type { Settings } from '../../shared/settings';
import type { ConfigStatusResponse } from '../../shared/noncontract';
import { isTokenUsable } from '../../shared/settings';

export interface PreSessionServerInfo {
  health: 'checking' | 'ok' | 'ng';
  healthError: string | null;
  config: ConfigStatusResponse | null;
  configError: string | null;
  facts: ApprovedFact[] | null;
  factsError: string | null;
}

export interface StartParams {
  purpose: string;
  customerName: string | null;
  appliedFacts: AppliedFactRef[];
  mode: SessionMode;
  selfCaptureEnabled: boolean;
  micDeviceId: string | null;
}

export interface PreSessionProps {
  target: TargetInfo | null;
  settings: Settings | null;
  server: PreSessionServerInfo;
  snapshot: OffscreenSnapshot | null;
  remoteLevel: number | null;
  starting: boolean;
  startError: string | null;
  now: number;
  onStart(p: StartParams): void;
  onOpenOptions(): void;
  onRefresh(): void;
  onSelectMic(deviceId: string | null): void;
}

/** /config/status を文字だけで短く表示。 */
function renderConfig(cfg: ConfigStatusResponse): string[] {
  const out: string[] = [];
  const prov = (name: string, p: ConfigStatusResponse['stt']) =>
    p ? `${name}（${[p.provider, p.model, p.language].filter(Boolean).join(' / ')}）: ${p.configured ? '設定済み' : 'API未設定'}` : `${name}: 確認できません`;
  out.push(prov('文字起こし', cfg.stt));
  out.push(prov('助言生成', cfg.llm));
  if (cfg.modes) out.push(`LIVE: ${cfg.modes.LIVE ? '利用できます' : '利用できません（APIキー未設定）'} ／ OFFLINEテスト: ${cfg.modes.OFFLINE ? '利用できます' : '利用できません'}`);
  if (cfg.offlineAdvice)
    out.push(`OFFLINEの助言: ${cfg.offlineAdvice === 'anthropic' ? 'Anthropic（外部送信あり）' : 'ルールベース（外部送信なし）'}`);
  if (cfg.priceTable)
    out.push(
      cfg.priceTable.configured
        ? `価格表: 設定済み（${cfg.priceTable.currency ?? '通貨不明'}・確認日 ${cfg.priceTable.checkedDate ?? '不明'}）`
        : '価格表: 未設定（金額は表示せず使用量のみ）',
    );
  return out;
}

function fmtDate(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function PreSession(p: PreSessionProps) {
  const [purpose, setPurpose] = useState('');
  const [customer, setCustomer] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<SessionMode>('LIVE');
  const [selfOn, setSelfOn] = useState(true);
  const [ackMic, setAckMic] = useState(false);
  const [ackConsent, setAckConsent] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [devRefresh, setDevRefresh] = useState(0);
  const devices = useAudioInputs(devRefresh);
  const micId = p.settings?.micDeviceId ?? null;
  const micTest = useLocalMicTest(micId);
  const micGranted = hasMicPermission(devices);

  const paired = p.settings ? isTokenUsable(p.settings, p.now) : false;
  const approved = useMemo(() => (p.server.facts ?? []).filter((f) => f.status === 'approved'), [p.server.facts]);
  const others = useMemo(() => (p.server.facts ?? []).filter((f) => f.status !== 'approved'), [p.server.facts]);
  const remoteState = p.snapshot?.sources.REMOTE ?? 'off';
  const remoteReady = remoteState === 'armed';
  const remoteHint = p.target?.armError ? sourceFixHint('error', 'REMOTE') : sourceFixHint(remoteState, 'REMOTE');

  const missing: string[] = [];
  if (!paired) missing.push('サーバーとのペアリング');
  if (p.server.health !== 'ok') missing.push('ローカルサーバーへの接続');
  if (!purpose.trim()) missing.push('商談目的');
  const liveUnavailable = p.server.config?.modes ? !p.server.config.modes.LIVE : false;
  const offlineExternal = p.server.config?.offlineAdvice === 'anthropic';
  if (mode === 'LIVE' && liveUnavailable) missing.push('LIVE用のAPIキー（サーバー側で未設定。OFFLINEテストは可能）');
  if (mode === 'LIVE' && !remoteReady) missing.push('会議タブの音声（会議タブで拡張アイコンを押す）');
  if (selfOn && !ackMic) missing.push('①ブラウザのマイク許可の確認');
  if (!ackConsent) missing.push('②商談相手への説明・同意／社内承認の確認');
  const canStart = missing.length === 0 && !p.starting;

  const doStart = () => {
    p.onStart({
      purpose: purpose.trim(),
      customerName: customer.trim() || null,
      appliedFacts: approved.filter((f) => selected[f.factId]).map((f) => ({ factId: f.factId, version: f.version })),
      mode,
      selfCaptureEnabled: selfOn,
      micDeviceId: micId,
    });
  };

  return (
    <div className="app">
      <h1>商談の開始前の確認</h1>

      <section className="box" aria-labelledby="h-target">
        <h2 id="h-target">対象の会議タブ</h2>
        {p.target?.tabId ? (
          <>
            <p>
              {p.target.title ?? '（タイトル不明）'}{' '}
              {p.target.isMeet ? <Badge label={{ text: 'Google Meet', tone: 'ok' }} /> : <Badge label={{ text: 'Meet以外のタブ', tone: 'warn' }} />}
            </p>
            <p className="small dim">このタブだけを取得します。ほかのタブへ移っても対象は変わりません。</p>
          </>
        ) : (
          <p>対象タブがありません。会議タブで拡張アイコンを押してください（OFFLINEテストは不要）。</p>
        )}
        <p>
          会議側の音声: <Badge label={localSourceLabel(remoteState)} />
        </p>
        <Meter name="会議側" db={p.remoteLevel} note={remoteReady ? '無音' : '取得なし'} />
        {remoteReady ? <p className="small dim">今はこのPC内で音量を確認しているだけで、外部へは送っていません。</p> : null}
        {remoteHint && p.target?.tabId ? (
          <div className="notice error" role="alert">
            {remoteHint}
          </div>
        ) : null}
      </section>

      <section className="box" aria-labelledby="h-server">
        <h2 id="h-server">ローカルサーバーとAPI設定</h2>
        <p>
          接続:{' '}
          <Badge
            label={
              p.server.health === 'ok'
                ? { text: '接続OK', tone: 'ok' }
                : p.server.health === 'checking'
                  ? { text: '確認中', tone: 'info' }
                  : { text: '通信断', tone: 'error' }
            }
          />{' '}
          ペアリング: {paired ? <Badge label={{ text: `済み（期限 ${fmtDate(p.settings?.session?.expiresAt ?? null)}）`, tone: 'ok' }} /> : <Badge label={{ text: '未ペアリング', tone: 'error' }} />}
        </p>
        {p.server.healthError ? <p className="small tone-error">{p.server.healthError}</p> : null}
        {p.server.config ? (
          <ul className="plain small">
            {renderConfig(p.server.config).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        ) : (
          <p className="small dim">API設定状態: {p.server.configError ?? '確認できません'}</p>
        )}
        <div className="row">
          <button type="button" onClick={p.onRefresh}>
            再確認
          </button>
          <button type="button" onClick={p.onOpenOptions}>
            設定画面（ペアリング・マイク・条件）
          </button>
        </div>
      </section>

      <section className="box" aria-labelledby="h-mic">
        <h2 id="h-mic">自分のマイク</h2>
        <label className="check">
          <input type="checkbox" checked={selfOn} onChange={(e) => setSelfOn(e.target.checked)} />
          <span>自分の音声を取得する（会議側とは別系統）</span>
        </label>
        <p className="small tone-warn">
          Meetでミュートしても、このアプリの自分の音声取得は止まりません。止めたいときは商談中の「自分の音声取得OFF」を押してください。
        </p>
        {selfOn ? (
          <>
            <div className="field">
              <label htmlFor="mic">使うマイク</label>
              <select id="mic" value={micId ?? ''} onChange={(e) => p.onSelectMic(e.target.value || null)}>
                <option value="">既定のマイク</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || '（名前は許可後に表示）'}
                  </option>
                ))}
              </select>
            </div>
            <p>
              ブラウザの許可: {micGranted ? <Badge label={{ text: '許可済み', tone: 'ok' }} /> : <Badge label={{ text: '未許可', tone: 'error' }} />}
            </p>
            <div className="row">
              <button
                type="button"
                onClick={() => {
                  if (micTest.running) micTest.stop();
                  else {
                    micTest.start();
                    setTimeout(() => setDevRefresh((x) => x + 1), 800);
                  }
                }}
              >
                {micTest.running ? 'テストを止める' : micGranted ? 'マイクをテスト' : 'マイクを許可してテスト'}
              </button>
            </div>
            <Meter name="自分" db={micTest.db} note={micTest.running ? '…' : 'テスト停止中'} />
            {micTest.error ? (
              <div className="notice error" role="alert">
                {micTest.error}。上の「マイクを許可してテスト」を押し、ブラウザの確認で「許可」を選んでください。出ない場合は{' '}
                <button type="button" onClick={p.onOpenOptions}>
                  設定画面で許可
                </button>
              </div>
            ) : null}
            <p className="small dim">テストの音はこの画面内だけで確認し、送信もスピーカー再生もしません。</p>
          </>
        ) : null}
      </section>

      <section className="box" aria-labelledby="h-deal">
        <h2 id="h-deal">商談の情報</h2>
        <div className="field">
          <label htmlFor="purpose">商談目的（必須）</label>
          <input id="purpose" type="text" maxLength={500} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="例: 業務診断の結果共有と次の進め方" />
        </div>
        <div className="field">
          <label htmlFor="customer">顧客名（任意）</label>
          <input id="customer" type="text" maxLength={100} value={customer} onChange={(e) => setCustomer(e.target.value)} />
        </div>
      </section>

      <section className="box" aria-labelledby="h-facts">
        <h2 id="h-facts">今回適用する条件（承認済みのみ）</h2>
        {p.server.factsError ? <p className="small tone-error">{p.server.factsError}</p> : null}
        {approved.length === 0 ? <p className="small dim">承認済みの条件はありません（価格・契約条件は未確認として扱われます）。</p> : null}
        {approved.map((f) => (
          <label key={f.factId} className="check">
            <input type="checkbox" checked={!!selected[f.factId]} onChange={(e) => setSelected({ ...selected, [f.factId]: e.target.checked })} />
            <span>
              {f.value} <span className="small dim">（{f.category} / 版{f.version} / 承認 {fmtDate(f.approvedAt)}）</span>
            </span>
          </label>
        ))}
        {others.length > 0 ? <p className="small dim">未確認・失効した条件 {others.length} 件は使えません（設定画面で承認できます）。</p> : null}
      </section>

      <section className="box" aria-labelledby="h-mode">
        <h2 id="h-mode">モード</h2>
        <div className="row" role="radiogroup" aria-label="モード">
          <label className="check">
            <input type="radio" name="mode" checked={mode === 'LIVE'} onChange={() => setMode('LIVE')} />
            <span>LIVE（実際の商談。外部APIへ送信）</span>
          </label>
          <label className="check">
            <input type="radio" name="mode" checked={mode === 'OFFLINE'} onChange={() => setMode('OFFLINE')} />
            <span>OFFLINEテスト（APIキー不要。サーバー既定の架空会話で動作確認）</span>
          </label>
        </div>
      </section>

      <section className="box" aria-labelledby="h-data">
        <h2 id="h-data">音声の取得元・送信先・保存</h2>
        <ul className="small">
          <li>会議側: 対象の会議タブの音声（相手が複数でも「会議側」。声から名前・役職は推測しません）</li>
          <li>自分側: 上で選んだマイク（スピーカーや会議へは流しません）</li>
          <li>
            送信先: このPCのローカルサーバー（127.0.0.1）
            {mode === 'LIVE'
              ? ' → Deepgram（文字起こし）、Anthropic（助言生成）'
              : offlineExternal
                ? ' → OFFLINEテストでも助言生成に Anthropic を使う設定です（架空会話のみ送信）'
                : '（OFFLINEテストでは外部へ送りません）'}
          </li>
          <li>保存: 音声は保存しません。会話と助言は既定でメモリのみ。終了時に選んだ場合だけ、このPCへ振り返りを出力します。</li>
          <li>外部事業者側の保持は各社の規約によります（「外部に一切保存されない」とは言えません）。</li>
        </ul>
        <div className="notice">画面共有は「資料のタブだけ」にしてください。全画面共有だと、このカンペが相手に映る可能性があります。</div>
      </section>

      <section className="box" aria-labelledby="h-ack">
        <h2 id="h-ack">確認（2つは別のものです）</h2>
        {selfOn ? (
          <label className="check">
            <input type="checkbox" checked={ackMic} onChange={(e) => setAckMic(e.target.checked)} />
            <span>
              ① ブラウザのマイク許可: この拡張機能がマイクを使うことをブラウザで許可した（技術的な許可）
            </span>
          </label>
        ) : null}
        <label className="check">
          <input type="checkbox" checked={ackConsent} onChange={(e) => setAckConsent(e.target.checked)} />
          <span>② 商談相手への説明・同意、または社内承認を得た（ブラウザの許可とは別に、人として必要な確認）</span>
        </label>
      </section>

      {p.startError ? (
        <div className="notice error" role="alert">
          {p.startError}
        </div>
      ) : null}

      {!confirming ? (
        <>
          {missing.length > 0 ? <p className="small tone-warn">開始に必要: {missing.join('／')}</p> : null}
          <button type="button" className="primary" disabled={!canStart} onClick={() => setConfirming(true)}>
            開始の確認へ
          </button>
        </>
      ) : (
        <section className="box" aria-label="開始の最終確認">
          <p>
            <strong>
              {mode === 'LIVE'
                ? '外部への送信を開始します。'
                : offlineExternal
                  ? 'OFFLINEテストを開始します（架空会話を Anthropic へ送信）。'
                  : 'OFFLINEテストを開始します（外部送信なし）。'}
            </strong>
          </p>
          {mode === 'LIVE' ? (
            <p className="small">会議側{selfOn ? '・自分側' : ''}の音声をローカルサーバー経由で Deepgram と Anthropic へ送ります。よろしいですか？</p>
          ) : null}
          <div className="row">
            <button type="button" className="primary" disabled={!canStart} onClick={doStart}>
              {p.starting ? '開始中…' : '開始する'}
            </button>
            <button type="button" onClick={() => setConfirming(false)}>
              戻る
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
