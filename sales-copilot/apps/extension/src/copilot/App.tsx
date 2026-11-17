import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ClientMessage } from '@sales-copilot/contracts';
import { usePrefs } from '../ui/common';
import { clientFromSettings, describeApiError } from '../shared/api';
import { saveSettings, isTokenUsable } from '../shared/settings';
import type {
  CaptureSourceKey,
  EndResult,
  FromOffscreen,
  OffscreenSnapshot,
  StopReason,
  TargetInfo,
  ToOffscreen,
  ToSw,
} from '../shared/runtime-messages';
import { copilotReducer, initialCopilotState, selectCardView, selectTranscript } from './state';
import { PreSession, type PreSessionServerInfo, type StartParams } from './components/PreSession';
import { LiveView, type LiveActions } from './components/LiveView';
import { EndView } from './components/EndView';
import { decideAutoStart } from './auto-start';

const HEARTBEAT_MS = 2000;

function sendOffscreen(msg: ToOffscreen): Promise<unknown> {
  return chrome.runtime.sendMessage(msg).catch(() => undefined);
}
function sendSw(msg: ToSw): Promise<unknown> {
  return chrome.runtime.sendMessage(msg).catch(() => undefined);
}

const EMPTY_SERVER: PreSessionServerInfo = {
  health: 'checking',
  healthError: null,
  config: null,
  configError: null,
  facts: null,
  factsError: null,
  scripts: null,
};

export function App() {
  const { settings, changeFont, toggleTheme } = usePrefs();
  const [state, dispatch] = useReducer(copilotReducer, initialCopilotState);
  const [snapshot, setSnapshot] = useState<OffscreenSnapshot | null>(null);
  const [levels, setLevels] = useState<Record<CaptureSourceKey, number | null>>({ SELF: null, REMOTE: null });
  const [target, setTarget] = useState<TargetInfo | null>(null);
  const [server, setServer] = useState<PreSessionServerInfo>(EMPTY_SERVER);
  const [phase, setPhase] = useState<'pre' | 'live' | 'end'>('pre');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [exportRequested, setExportRequested] = useState(false);
  const [endResult, setEndResult] = useState<EndResult | null>(null);
  const displayedRef = useRef(new Set<string>());
  const [now, setNow] = useState(() => Date.now());
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  /** Meet ポップアップの「接続」で開いた場合の自動開始（1 回だけ）。 */
  const autoHandledRef = useRef<number | null>(null);
  const [autoNote, setAutoNote] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<string | null>(null);

  // offscreen / service worker からのメッセージ
  useEffect(() => {
    const onMsg = (raw: unknown) => {
      const m = raw as FromOffscreen;
      if (!m || m.target !== 'ui') return;
      switch (m.type) {
        case 'snapshot':
          setSnapshot(m.snapshot);
          if (m.snapshot.phase === 'live' || m.snapshot.phase === 'connecting' || m.snapshot.phase === 'ending') {
            if (phaseRef.current === 'pre' && m.snapshot.phase === 'live') setPhase('live');
          }
          if (m.snapshot.phase === 'stopped') {
            setStarting(false);
            if (phaseRef.current === 'live') setPhase('end');
            else if (m.snapshot.stopReason === 'connection_failed') setStartError('ローカルサーバーで開始できませんでした（接続・認証・サーバー状態を確認してください）');
          }
          break;
        case 'levels':
          setLevels(m.levels);
          break;
        case 'server':
          if (m.message.type === 'session.ended') {
            setEndResult({ source: 'session.ended', exportPath: m.message.exportPath, reviewAvailableUntil: m.message.reviewAvailableUntil });
          }
          dispatch({ type: 'server', message: m.message });
          break;
        case 'offscreen.error':
          setStartError(m.message);
          break;
        case 'gap':
          break;
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    void sendOffscreen({ target: 'offscreen', type: 'getState' }).then((s) => {
      if (s && typeof s === 'object' && 'phase' in s) setSnapshot(s as OffscreenSnapshot);
    });
    // UI が消えたら offscreen 側が取得を止める（ハートビート）
    const hb = setInterval(() => void sendOffscreen({ target: 'offscreen', type: 'heartbeat' }), HEARTBEAT_MS);
    void sendOffscreen({ target: 'offscreen', type: 'heartbeat' });
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      chrome.runtime.onMessage.removeListener(onMsg);
      clearInterval(hb);
      clearInterval(clock);
    };
  }, []);

  // 対象タブ情報（開始前は取得状況が変わるので定期確認）
  useEffect(() => {
    if (phase !== 'pre') return;
    const load = () =>
      void sendSw({ target: 'sw', type: 'ui.getTarget' }).then((t) => {
        if (t && typeof t === 'object' && 'tabId' in t) setTarget(t as TargetInfo);
      });
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [phase]);

  const refreshServer = useCallback(async () => {
    if (!settings) return;
    setServer((s) => ({ ...s, health: 'checking' }));
    const api = clientFromSettings(settings);
    const usable = isTokenUsable(settings, Date.now());
    const [h, c, f, sc] = await Promise.all([
      api.health(),
      usable ? api.configStatus() : Promise.resolve(null),
      usable ? api.listFacts() : Promise.resolve(null),
      usable ? api.offlineScripts() : Promise.resolve(null),
    ]);
    setServer({
      health: h.ok ? 'ok' : 'ng',
      healthError: h.ok ? null : describeApiError(h.error),
      config: c?.ok ? c.data : null,
      configError: c ? (c.ok ? null : describeApiError(c.error)) : 'ペアリング後に確認できます',
      facts: f?.ok ? f.data : null,
      factsError: f ? (f.ok ? null : describeApiError(f.error)) : null,
      scripts: sc?.ok ? sc.data : null,
    });
  }, [settings]);

  useEffect(() => {
    if (phase === 'pre') void refreshServer();
  }, [phase, refreshServer]);

  // 終了後: 通常は session.ended で結果が分かる。届かなかった場合だけ振り返り API で確認する（フォールバック）
  const endedSessionId = snapshot?.sessionId ?? state.sessionId;
  useEffect(() => {
    if (phase !== 'end' || endResult || !settings || !endedSessionId) return;
    let cancelled = false;
    void (async () => {
      await new Promise((res) => setTimeout(res, 1500));
      const api = clientFromSettings(settings);
      for (let i = 0; i < 3 && !cancelled; i++) {
        const r = await api.sessionReview(endedSessionId);
        if (cancelled) return;
        if (r.ok) {
          setEndResult((cur) => cur ?? { source: 'review', exportPath: r.data.exportPath, reviewAvailableUntil: r.data.retainedUntil });
          return;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
      if (!cancelled) setEndResult((cur) => cur ?? { source: 'unknown' });
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, endResult, settings, endedSessionId]);

  // 検証済みカードを画面に反映したら、サーバーへ表示報告（遅延計測の最終点。1カード1回）
  const cardView = selectCardView(state, now);
  const shownId = phase === 'live' && cardView.card && cardView.displayStatus !== 'invalidated' ? cardView.card.adviceId : null;
  useEffect(() => {
    if (!shownId || displayedRef.current.has(shownId)) return;
    displayedRef.current.add(shownId);
    void sendOffscreen({ target: 'offscreen', type: 'client', message: { type: 'advice.displayed', adviceId: shownId, at: Date.now() } });
  }, [shownId]);

  const openOptions = useCallback(() => void sendSw({ target: 'sw', type: 'ui.openOptions' }), []);

  const onStart = useCallback(
    (p: StartParams) => {
      if (!settings?.session) return;
      setStarting(true);
      setStartError(null);
      dispatch({ type: 'reset' });
      setEndResult(null);
      displayedRef.current.clear();
      setPurpose(p.purpose);
      void saveSettings({ lastMode: p.mode });
      void sendSw({
        target: 'sw',
        type: 'ui.start',
        config: {
          serverUrl: settings.serverUrl,
          token: settings.session.token,
          frameMs: settings.frameMs,
          micDeviceId: p.micDeviceId,
          maxBufferedBytes: settings.maxBufferedBytes,
          start: {
            purpose: p.purpose,
            ...(p.customerName ? { customerName: p.customerName } : {}),
            appliedFacts: p.appliedFacts,
            mode: p.mode,
            selfCaptureEnabled: p.selfCaptureEnabled,
            consentConfirmed: true,
            storage: 'memory_only',
            ...(p.mode === 'OFFLINE' && p.offlineScriptId ? { offlineScriptId: p.offlineScriptId } : {}),
            ...(p.mode === 'OFFLINE' && p.offlineUseAnthropic ? { offlineUseAnthropic: true } : {}),
          },
        },
      });
    },
    [settings],
  );

  // Meet ポップアップの「接続」: 確認画面を挟まずに開始する（タップ＝同意②の確認）。できなければ理由と直し方を出す。
  const auto = target?.autoStart ?? null;
  const remoteState = snapshot?.sources.REMOTE ?? 'off';
  useEffect(() => {
    if (phase !== 'pre' || !auto || autoHandledRef.current === auto.requestedAt || !settings) return;
    const d = decideAutoStart({
      paired: isTokenUsable(settings, now),
      health: server.health,
      config: server.config,
      configError: server.configError,
      lastMode: settings.lastMode,
      remote: remoteState,
      elapsedMs: now - auto.requestedAt,
    });
    if (d.kind === 'wait') return;
    autoHandledRef.current = auto.requestedAt;
    void sendSw({ target: 'sw', type: 'ui.autoStartDone' });
    if (d.kind === 'fail') {
      setAutoNote(d.message);
      return;
    }
    onStart({
      purpose: auto.purpose,
      customerName: null,
      appliedFacts: [],
      mode: d.mode,
      selfCaptureEnabled: true,
      micDeviceId: settings.micDeviceId,
      offlineScriptId: null,
      offlineUseAnthropic: false,
    });
  }, [phase, auto, settings, server, remoteState, now, onStart]);

  const actions: LiveActions = useMemo(
    () => ({
      sendClient: (message: ClientMessage) => void sendOffscreen({ target: 'offscreen', type: 'client', message }),
      pin: (adviceId) => {
        dispatch({ type: 'pin', adviceId });
        void sendOffscreen({ target: 'offscreen', type: 'client', message: { type: 'card.pin', adviceId } });
      },
      unpin: (adviceId) => {
        dispatch({ type: 'unpin' });
        void sendOffscreen({ target: 'offscreen', type: 'client', message: { type: 'card.unpin', adviceId } });
      },
      setSelf: (enabled) => void sendOffscreen({ target: 'offscreen', type: 'self.set', enabled }),
      setPaused: (paused) => void sendOffscreen({ target: 'offscreen', type: 'pause.set', paused }),
      end: (exp) => {
        setExportRequested(exp);
        void sendOffscreen({ target: 'offscreen', type: 'end', exportRequested: exp });
      },
      updatePurpose: (next) => {
        setPurpose(next);
        void sendOffscreen({ target: 'offscreen', type: 'client', message: { type: 'session.update', purpose: next } });
      },
      changeFont,
      toggleTheme,
      openOptions,
    }),
    [changeFont, toggleTheme, openOptions],
  );

  if (phase === 'end') {
    return (
      <EndView
        reason={(snapshot?.stopReason as StopReason | null) ?? null}
        exportRequested={exportRequested}
        result={endResult}
        onClose={() => window.close()}
      />
    );
  }

  if (phase === 'live' && snapshot) {
    return (
      <LiveView
        view={cardView}
        transcript={selectTranscript(state)}
        warnings={state.warnings}
        levels={levels}
        snapshot={snapshot}
        status={state.status}
        usage={state.usage}
        lastError={state.lastError ? `サーバー: ${state.lastError.message}` : null}
        purpose={purpose}
        actions={actions}
      />
    );
  }

  return (
    <PreSession
      target={target}
      settings={settings}
      server={server}
      snapshot={snapshot}
      remoteLevel={levels.REMOTE}
      starting={starting || (!!auto && autoHandledRef.current !== auto.requestedAt && !autoNote)}
      startError={startError}
      autoNote={autoNote}
      initialPurpose={auto?.purpose ?? null}
      now={now}
      onStart={onStart}
      onOpenOptions={openOptions}
      onRefresh={() => void refreshServer()}
      onSelectMic={(id) => void saveSettings({ micDeviceId: id })}
    />
  );
}
