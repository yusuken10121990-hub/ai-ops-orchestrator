import { useCallback, useEffect, useState } from 'react';
import { LEARNING_LIMITS, RuleScope, type LearningOverviewResponse, type ProposalEstimateResponse, type RuleProposal } from '@sales-copilot/contracts';
import { Badge } from '../ui/common';
import { clientFromSettings, describeApiError, LearningApi, type ApiResult } from '../shared/api';
import { isTokenUsable, type Settings } from '../shared/settings';
import { estimateText, HISTORY_LABEL, rateText, SCOPE_LABEL, shouldSuggestProposal, versionLabel } from './learning-view';

function fmt(ms: number): string {
  return new Date(ms).toLocaleString('ja-JP');
}

/**
 * 学習（承認制）。評価から AI が改善案を出し、承認したものだけを次の商談から使う。
 * 承認・却下・停止・削除はすべてここで行い、自動では何も変わらない。
 */
export function LearningSection({ settings }: { settings: Settings }) {
  const paired = isTokenUsable(settings, Date.now());
  const [data, setData] = useState<LearningOverviewResponse | null>(null);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [estimate, setEstimate] = useState<ProposalEstimateResponse | null>(null);

  const api = useCallback(() => new LearningApi(clientFromSettings(settings)), [settings]);

  const load = useCallback(async () => {
    if (!paired) return;
    const r = await api().overview();
    if (r.ok) setData(r.data);
    else setMsg({ text: describeApiError(r.error), error: true });
  }, [api, paired]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 操作を実行し、結果を表示して一覧を読み直す。 */
  const run = async <T,>(fn: () => Promise<ApiResult<T>>, ok: string | ((d: T) => string)) => {
    setBusy(true);
    setMsg(null);
    const r = await fn();
    setBusy(false);
    if (!r.ok) {
      setMsg({ text: describeApiError(r.error), error: true });
      return null;
    }
    setMsg({ text: typeof ok === 'string' ? ok : ok(r.data), error: false });
    await load();
    return r.data;
  };

  if (!paired) {
    return (
      <section className="box">
        <h2>学習（承認制）</h2>
        <p>ペアリング後に使えます。上の「ペアリング」を先に済ませてください。</p>
      </section>
    );
  }

  const prepare = async () => {
    setBusy(true);
    setMsg(null);
    const r = await api().estimate();
    setBusy(false);
    if (!r.ok) return setMsg({ text: describeApiError(r.error), error: true });
    if (!r.data.configured) return setMsg({ text: 'AIのキーが未設定です。.env に ANTHROPIC_API_KEY を入れてサーバーを起動し直してください', error: true });
    if (!r.data.enoughSamples) {
      return setMsg({
        text: `評価が${LEARNING_LIMITS.minSamplesForProposal}件以上必要です（今${r.data.sampleCount}件）。商談中にカードの「役立った」「ずれた」を押してください`,
        error: true,
      });
    }
    setEstimate(r.data);
  };

  const generate = async () => {
    setEstimate(null);
    await run(() => api().generate(), (d) =>
      d.proposals.length === 0
        ? `新しい改善案はありませんでした${d.dropped ? `（決まりに合わない案${d.dropped}件は表示していません）` : ''}`
        : `改善案を${d.proposals.length}件作りました。下で承認・却下してください${d.dropped ? `（決まりに合わない案${d.dropped}件は除外）` : ''}`,
    );
  };

  const wipe = async () => {
    if (!confirm('評価の記録と未処理の改善案を全部消します。承認済みのルールは残ります。消しますか？')) return;
    await run(() => api().wipe(), '学習データを消しました');
  };

  return (
    <section className="box" aria-labelledby="h-learn">
      <h2 id="h-learn">学習（承認制）</h2>
      <p className="small">
        商談中の「役立った」「ずれた」から、AIが改善ルールの案を出します。承認した案だけが、次の商談から使われます。勝手には変わりません。
      </p>

      {msg ? (
        <p role={msg.error ? 'alert' : 'status'} className={msg.error ? 'tone-error' : 'tone-ok'}>
          {msg.text}
        </p>
      ) : null}

      {data ? (
        <>
          <div className="field">
            <label className="row" style={{ gap: '0.5em' }}>
              <input
                type="checkbox"
                checked={data.settings.saveCardText}
                disabled={busy}
                onChange={(e) => void run(() => api().updateSettings({ saveCardText: e.target.checked }), e.target.checked ? '保存をONにしました' : '保存をOFFにしました')}
              />
              学習のために評価したカンペの文面を保存する
            </label>
            <p className="small dim">
              評価したカードの文面と商談目的だけをこのPCに保存します。会話の文字起こし・お客様の名前は保存しません。
            </p>
          </div>

          <h3>改善案</h3>
          {shouldSuggestProposal(data.newSamplesSinceLastProposal) ? (
            <div className="notice" role="status">
              前回から新しい評価が{data.newSamplesSinceLastProposal}件あります。「改善案を作る」を押すと案が出ます。
            </div>
          ) : null}
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => void prepare()}>
              改善案を作る
            </button>
            <span className="small dim">使える評価 {data.samplesWithText}件</span>
          </div>
          {estimate ? (
            <div className="notice" role="status">
              <p>{estimateText(estimate)}</p>
              <div className="row">
                <button type="button" className="primary" disabled={busy} onClick={() => void generate()}>
                  この内容で作る
                </button>
                <button type="button" disabled={busy} onClick={() => setEstimate(null)}>
                  やめる
                </button>
              </div>
            </div>
          ) : null}
          {busy ? <p className="small dim">処理中…</p> : null}

          {data.proposals.length === 0 ? <p className="dim">承認待ちの案はありません。</p> : null}
          {data.proposals.map((p) => (
            <ProposalItem
              key={p.proposalId}
              p={p}
              busy={busy}
              onApprove={(edit) => void run(() => api().approve(p.proposalId, edit), (d) => `承認しました（版${d.rulesVersion}）。次の商談から使われます`)}
              onReject={() => void run(() => api().reject(p.proposalId), '却下しました')}
            />
          ))}

          <h3>使っているルール（現在 {versionLabel(data.rulesVersion)}）</h3>
          {data.rules.length === 0 ? <p className="dim">承認済みのルールはまだありません。</p> : null}
          {data.rules.length > 0 ? (
            <table className="facts">
              <thead>
                <tr>
                  <th>ルール</th>
                  <th>状態</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.rules.map((r) => (
                  <tr key={r.ruleId}>
                    <td>
                      {r.text}
                      <div className="small dim">場面: {SCOPE_LABEL[r.scope]}</div>
                    </td>
                    <td>
                      <Badge label={{ text: r.status === 'active' ? '使用中' : '停止中', tone: r.status === 'active' ? 'ok' : 'muted' }} />
                      <div className="small dim">版{r.version}で承認</div>
                      <div className="small dim">{fmt(r.approvedAt)}</div>
                    </td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => api().setRuleEnabled(r.ruleId, r.status !== 'active'),
                              r.status === 'active' ? '止めました。次の商談から使われません' : '再開しました。次の商談から使われます',
                            )
                          }
                        >
                          {r.status === 'active' ? '止める' : '再開'}
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={busy}
                          onClick={() => {
                            if (confirm('このルールを削除しますか？（履歴には残ります）')) void run(() => api().deleteRule(r.ruleId), '削除しました');
                          }}
                        >
                          削除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          <h3>効果（版ごとの「役立った」率）</h3>
          {data.stats.length === 0 ? (
            <p className="dim">まだ評価がありません。商談中にカードの「役立った」「ずれた」を押すと、ここに出ます。</p>
          ) : (
            <table className="facts">
              <thead>
                <tr>
                  <th>版</th>
                  <th>役立った率</th>
                </tr>
              </thead>
              <tbody>
                {data.stats.map((s) => (
                  <tr key={String(s.rulesVersion)}>
                    <td>{versionLabel(s.rulesVersion)}</td>
                    <td className={s.insufficient ? 'dim' : undefined}>{rateText(s)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <details>
            <summary>変更の履歴</summary>
            {data.history.length === 0 ? <p className="dim">まだありません。</p> : null}
            <ul>
              {data.history.map((h, i) => (
                <li key={i} className="small">
                  {fmt(h.changedAt)}　{HISTORY_LABEL[h.action]}　{h.text}（{SCOPE_LABEL[h.scope]}・{versionLabel(h.rulesVersion)}）
                </li>
              ))}
            </ul>
          </details>

          <div className="row" style={{ marginTop: '1em' }}>
            <button type="button" className="danger" disabled={busy} onClick={() => void wipe()}>
              学習データを全部消す
            </button>
            <span className="small dim">評価の記録と未処理の改善案を消します。承認済みのルールは残ります（上で個別に削除できます）。</span>
          </div>
        </>
      ) : !msg ? (
        <p>読み込み中…</p>
      ) : (
        <button type="button" onClick={() => void load()}>
          もう一度読み込む
        </button>
      )}
    </section>
  );
}

function ProposalItem({
  p,
  busy,
  onApprove,
  onReject,
}: {
  p: RuleProposal;
  busy: boolean;
  onApprove: (edit: { text?: string; scope?: RuleScope }) => void;
  onReject: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(p.rule);
  const [scope, setScope] = useState<RuleScope>(p.scope);
  return (
    <div className="notice">
      {editing ? (
        <>
          <div className="field">
            <label htmlFor={`rt-${p.proposalId}`}>ルール（{LEARNING_LIMITS.ruleText}文字以内の1文・金額や期間は入れない）</label>
            <textarea id={`rt-${p.proposalId}`} rows={2} maxLength={LEARNING_LIMITS.ruleText} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`rs-${p.proposalId}`}>使う場面</label>
            <select id={`rs-${p.proposalId}`} value={scope} onChange={(e) => setScope(e.target.value as RuleScope)}>
              {RuleScope.options.map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <button type="button" className="primary" disabled={busy || text.trim().length === 0} onClick={() => onApprove({ text: text.trim(), scope })}>
              この内容で承認
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            <strong>{p.rule}</strong>
          </p>
          <p className="small dim">
            場面: {SCOPE_LABEL[p.scope]}　理由: {p.reason}
          </p>
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => onApprove({})}>
              承認
            </button>
            <button type="button" disabled={busy} onClick={onReject}>
              却下
            </button>
            <button type="button" disabled={busy} onClick={() => setEditing(true)}>
              編集して承認
            </button>
          </div>
        </>
      )}
    </div>
  );
}
