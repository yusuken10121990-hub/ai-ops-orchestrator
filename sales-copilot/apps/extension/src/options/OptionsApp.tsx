import { useCallback, useEffect, useState } from 'react';
import { FactCategory, PAIRING_CODE_PATTERN, type ApprovedFact } from '@sales-copilot/contracts';
import { Badge, Meter, hasMicPermission, useAudioInputs, useLocalMicTest, usePrefs } from '../ui/common';
import { clientFromSettings, describeApiError, type FactInput } from '../shared/api';
import { checkPairing, PAIRING_CODE_HELP, pairingProblemLine, type PairingCheck } from '../shared/pairing';
import { isTokenUsable, normalizeServerUrl, saveSettings, type Settings } from '../shared/settings';
import { clampFrameMs } from '../audio/dsp/chunker';
import { LearningSection } from './LearningSection';

const CATEGORY_LABEL: Record<FactCategory, string> = {
  price_initial: '初期費用',
  price_monthly: '月額',
  tax: '税区分',
  usage_fee: '従量',
  extra_fee: '追加費用',
  min_term: '最低契約期間',
  cancellation: '途中解約',
  ip_rights: '権利帰属',
  data_migration: 'データ移行',
  demo_scope: '無料デモの範囲',
  maintenance_scope: '保守範囲',
  tech_spec: '確認済み技術仕様',
  unverified_note: '未検証事項',
};

const STATUS_LABEL = { unverified: '未確認', approved: '承認済み', revoked: '失効' } as const;

function fmt(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleString('ja-JP');
}

const EMPTY_INPUT: FactInput = { category: 'price_monthly', value: '', scope: '', sourceNote: '' };

export function OptionsApp() {
  const { settings, changeFont, toggleTheme } = usePrefs();
  return (
    <div className="app">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>ZEROSYS Sales Copilot 設定</h1>
        <div className="row">
          <button type="button" aria-label="文字を小さく" onClick={() => changeFont(-0.1)}>
            A−
          </button>
          <button type="button" aria-label="文字を大きく" onClick={() => changeFont(0.1)}>
            A＋
          </button>
          <button type="button" onClick={toggleTheme}>
            明暗
          </button>
        </div>
      </div>
      {settings ? (
        <>
          <ServerSection settings={settings} />
          <MicSection settings={settings} />
          <FactsSection settings={settings} />
          <LearningSection settings={settings} />
        </>
      ) : (
        <p>読み込み中…</p>
      )}
    </div>
  );
}

function ServerSection({ settings }: { settings: Settings }) {
  const [url, setUrl] = useState(settings.serverUrl);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [frameMs, setFrameMs] = useState(String(settings.frameMs));
  const paired = isTokenUsable(settings, Date.now());
  // サーバーに確かめた結果（期限は使うたびに延長されるので、保存値をサーバーの最新値に合わせる）
  const [check, setCheck] = useState<PairingCheck | null>(null);
  const token = settings.session?.token ?? null;
  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await checkPairing(clientFromSettings(settings), settings.session);
      if (!alive) return;
      setCheck(r);
      if (r.kind === 'ok' && settings.session && settings.session.expiresAt !== r.expiresAt) {
        await saveSettings({ session: { ...settings.session, expiresAt: r.expiresAt } });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, settings.serverUrl]);
  const problem = check && (check.kind === 'server_down' || check.kind === 'pairing_expired') ? check.kind : null;

  const unpair = async () => {
    // サーバー側でも失効させる（つながらなくても拡張側は消す。サーバーの記録は期限で消える）
    const r = await clientFromSettings(settings).revokePairing();
    await saveSettings({ session: null });
    setMsg({ text: r.ok ? '解除しました' : '拡張機能側は解除しました（サーバーにつながらないため、サーバー側の記録は期限まで残ります）', error: !r.ok });
  };

  const saveUrl = async () => {
    const n = normalizeServerUrl(url);
    if (!n) return setMsg({ text: 'URLは http://127.0.0.1:ポート または http://localhost:ポート のみ使えます', error: true });
    await saveSettings({ serverUrl: n, session: n === settings.serverUrl ? settings.session : null });
    setUrl(n);
    setMsg({ text: '保存しました', error: false });
  };

  const pair = async () => {
    if (!PAIRING_CODE_PATTERN.test(code)) return setMsg({ text: `ペアリングコードは数字6桁です（${PAIRING_CODE_HELP}）`, error: true });
    const api = clientFromSettings({ serverUrl: settings.serverUrl, session: null });
    const r = await api.pair({ pairingCode: code, extensionId: chrome.runtime.id, clientName: 'ZEROSYS Sales Copilot 拡張' });
    if (!r.ok) return setMsg({ text: describeApiError(r.error), error: true });
    if (!r.data.ok) {
      const map = {
        invalid_code: 'コードが違います → pnpm pair で出した最新のコードを入力してください',
        expired_code: 'コードの期限が切れました → pnpm pair をもう一度実行して新しいコードを入力してください',
        already_paired: 'このコードは使用済みです → pnpm pair をもう一度実行して新しいコードを入力してください',
        origin_mismatch: '拡張機能IDがサーバーの許可と一致しません。サーバーの設定を確認してください',
        rate_limited: '試行が多すぎます。少し待ってからやり直してください',
      } as const;
      return setMsg({ text: map[r.data.error], error: true });
    }
    await saveSettings({ session: r.data.session });
    setCode('');
    setMsg({ text: 'ペアリングしました（使っている間は切れません。PC やサーバーを再起動してもそのまま使えます）', error: false });
  };

  return (
    <section className="box" aria-labelledby="h-srv">
      <h2 id="h-srv">ローカルサーバー</h2>
      <div className="field">
        <label htmlFor="url">サーバーURL</label>
        <div className="row">
          <input id="url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1, width: 'auto' }} />
          <button type="button" onClick={() => void saveUrl()}>
            保存
          </button>
        </div>
      </div>
      <p>
        ペアリング:{' '}
        {problem === 'pairing_expired' ? (
          <Badge label={{ text: '期限切れ', tone: 'error' }} />
        ) : paired ? (
          <Badge label={{ text: `済み（期限 ${fmt(settings.session?.expiresAt ?? null)}・使うたびに延長）`, tone: 'ok' }} />
        ) : (
          <Badge label={{ text: settings.session ? '期限切れ' : '未ペアリング', tone: 'error' }} />
        )}
      </p>
      {problem ? (
        <p className="tone-error" role="alert">
          {problem === 'pairing_expired' ? 'ペアリングが切れました → 下のペアリングコード欄で再ペアリング' : pairingProblemLine(problem)}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="code">ペアリングコード（{PAIRING_CODE_HELP}）</label>
        <div className="row">
          <input id="code" inputMode="numeric" autoComplete="off" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ flex: 1, width: 'auto' }} />
          <button type="button" className="primary" onClick={() => void pair()}>
            ペアリング
          </button>
          {settings.session ? (
            <button type="button" onClick={() => void unpair()}>
              解除
            </button>
          ) : null}
        </div>
      </div>
      <div className="field">
        <label htmlFor="frame">音声フレーム長（ms・100〜250、既定200）</label>
        <div className="row">
          <input id="frame" inputMode="numeric" value={frameMs} onChange={(e) => setFrameMs(e.target.value)} style={{ width: '6em' }} />
          <button type="button" onClick={() => void saveSettings({ frameMs: clampFrameMs(Number(frameMs)) }).then((s) => setFrameMs(String(s.frameMs)))}>
            保存
          </button>
        </div>
      </div>
      {msg ? (
        <p role={msg.error ? 'alert' : 'status'} className={msg.error ? 'tone-error' : 'tone-ok'}>
          {msg.text}
        </p>
      ) : null}
    </section>
  );
}

function MicSection({ settings }: { settings: Settings }) {
  const [refresh, setRefresh] = useState(0);
  const devices = useAudioInputs(refresh);
  const granted = hasMicPermission(devices);
  const test = useLocalMicTest(settings.micDeviceId);
  return (
    <section className="box" aria-labelledby="h-mic">
      <h2 id="h-mic">マイク（自分側の音声）</h2>
      <p className="small">
        音声取得は裏側の画面（offscreen）で行うため、そこでは許可の確認が出せません。必ずこの画面で先に「許可」してください。
        許可はこの拡張機能だけに対するもので、商談相手への説明・同意とは別です。
      </p>
      <p>
        ブラウザの許可: {granted ? <Badge label={{ text: '許可済み', tone: 'ok' }} /> : <Badge label={{ text: '未許可', tone: 'error' }} />}
      </p>
      <div className="row">
        <button
          type="button"
          className={granted ? undefined : 'primary'}
          onClick={() => {
            if (test.running) test.stop();
            else {
              test.start();
              setTimeout(() => setRefresh((x) => x + 1), 800);
            }
          }}
        >
          {test.running ? 'テストを止める' : granted ? 'マイクをテスト' : 'マイクを許可してテスト'}
        </button>
      </div>
      {test.error ? (
        <div className="notice error" role="alert">
          {test.error}。アドレスバー左のアイコン →「マイク」を「許可」にしてから、もう一度ボタンを押してください。
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="mic">使うマイク（ヘッドセット推奨）</label>
        <select id="mic" value={settings.micDeviceId ?? ''} onChange={(e) => void saveSettings({ micDeviceId: e.target.value || null })}>
          <option value="">既定のマイク</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || '（名前は許可後に表示）'}
            </option>
          ))}
        </select>
      </div>
      <Meter name="自分" db={test.db} note={test.running ? '…' : 'テスト停止中'} />
      <p className="small dim">テスト音はこの画面内だけで確認し、送信もスピーカー再生もしません。</p>
    </section>
  );
}

function FactsSection({ settings }: { settings: Settings }) {
  const [facts, setFacts] = useState<ApprovedFact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApprovedFact | null>(null);
  const [input, setInput] = useState<FactInput>(EMPTY_INPUT);
  const [busy, setBusy] = useState(false);
  const paired = isTokenUsable(settings, Date.now());

  const load = useCallback(async () => {
    if (!paired) return;
    const r = await clientFromSettings(settings).listFacts();
    if (r.ok) {
      setFacts(r.data);
      setError(null);
    } else setError(describeApiError(r.error));
  }, [settings, paired]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (!input.value.trim()) return setError('値を入力してください');
    setBusy(true);
    const api = clientFromSettings(settings);
    const r = editing ? await api.updateFact(editing.factId, input) : await api.createFact(input);
    setBusy(false);
    if (!r.ok) return setError(describeApiError(r.error));
    setEditing(null);
    setInput(EMPTY_INPUT);
    await load();
  };

  const approve = async (f: ApprovedFact) => {
    setBusy(true);
    const r = await clientFromSettings(settings).approveFact(f.factId, f.version);
    setBusy(false);
    if (!r.ok) return setError(describeApiError(r.error));
    await load();
  };

  if (!paired) {
    return (
      <section className="box">
        <h2>商談条件（承認済み情報）</h2>
        <p>ペアリング後に編集できます。</p>
      </section>
    );
  }

  return (
    <section className="box" aria-labelledby="h-facts">
      <h2 id="h-facts">商談条件（承認済み情報）</h2>
      <p className="small">
        全項目は最初「未確認」です。承認した条件だけが商談中の助言に使われます。会話から出た条件は自動では承認されません。
      </p>
      {error ? (
        <p role="alert" className="tone-error">
          {error}
        </p>
      ) : null}
      {facts && facts.length === 0 ? <p className="dim">まだ登録がありません。</p> : null}
      {facts && facts.length > 0 ? (
        <table className="facts">
          <thead>
            <tr>
              <th>区分</th>
              <th>値・適用範囲</th>
              <th>状態</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {facts.map((f) => (
              <tr key={f.factId}>
                <td>{CATEGORY_LABEL[f.category]}</td>
                <td>
                  {f.value}
                  {f.scope ? <div className="small dim">範囲: {f.scope}</div> : null}
                  {f.sourceNote ? <div className="small dim">出典: {f.sourceNote}</div> : null}
                </td>
                <td>
                  <Badge label={{ text: STATUS_LABEL[f.status], tone: f.status === 'approved' ? 'ok' : f.status === 'revoked' ? 'error' : 'warn' }} />
                  <div className="small dim">版{f.version}</div>
                  <div className="small dim">承認 {fmt(f.approvedAt)}</div>
                </td>
                <td>
                  <div className="row">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(f);
                        setInput({ category: f.category, value: f.value, scope: f.scope, sourceNote: f.sourceNote });
                      }}
                    >
                      編集
                    </button>
                    {f.status !== 'approved' ? (
                      <button type="button" disabled={busy} onClick={() => void approve(f)}>
                        承認
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <h2>{editing ? '条件を編集' : '条件を追加（未確認として登録）'}</h2>
      {editing?.status === 'approved' ? (
        <div className="notice" role="status">
          承認済みの条件を編集すると、今の承認は外れ、再承認が必要になります（新しい版になります）。
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="cat">区分</label>
        <select id="cat" value={input.category} onChange={(e) => setInput({ ...input, category: e.target.value as FactCategory })}>
          {FactCategory.options.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="val">値</label>
        <textarea id="val" rows={2} maxLength={1000} value={input.value} onChange={(e) => setInput({ ...input, value: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="scope">適用範囲（サービス・プラン・顧客など）</label>
        <input id="scope" type="text" maxLength={500} value={input.scope} onChange={(e) => setInput({ ...input, scope: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="src">出典メモ</label>
        <input id="src" type="text" maxLength={500} value={input.sourceNote} onChange={(e) => setInput({ ...input, sourceNote: e.target.value })} />
      </div>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          {editing ? (editing.status === 'approved' ? '保存（承認が外れます）' : '保存') : '追加'}
        </button>
        {editing ? (
          <button
            type="button"
            onClick={() => {
              setEditing(null);
              setInput(EMPTY_INPUT);
            }}
          >
            取消
          </button>
        ) : null}
      </div>
    </section>
  );
}
