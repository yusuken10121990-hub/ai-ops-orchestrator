import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ClientMessage } from '@sales-copilot/contracts';
import { usePrefs } from '../ui/common';
import { clientFromSettings, describeApiError } from '../shared/api';
import { saveSettings, isTokenUsable } from '../shared/settings';
import type {
  CaptureSourceKey,
  ExportResult,
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
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

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
          dispatch({ type: 'server', message: m.message });
          break;
        case 'export.result':
          setExportResult(m.result);
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
    const [h, c, f] = await Promise.all([
      api.health(),
      isTokenUsable(settings, Date.now()) ? api.configStatus() : Promise.resolve(null),
      isTokenUsable(settings, Date.now()) ? api.listFacts() : Promise.resolve(null),
    ]);
    setServer({
      health: h.ok ? 'ok' : 'ng',
      healthError: h.ok ? null : describeApiError(h.error),
      config: c?.ok ? c.data : null,
      configError: c ? (c.ok ? null : describeApiError(c.error)) : 'ペアリング後に確認できます',
      facts: f?.ok ? f.data : null,
      factsError: f ? (f.ok ? null : describeApiError(f.error)) : null,
    });
  }, [settings]);

  useEffect(() => {
    if (phase === 'pre') void refreshServer();
  }, [phase, refreshServer]);

  // 終了後: 出力を頼んだ場合だけ、サーバーの振り返り情報から出力先パスを確認する
  const endedSessionId = snapshot?.sessionId ?? state.sessionId;
  useEffect(() => {
    if (phase !== 'end' || !exportRequested || exportResult || !settings || !endedSessionId) return;
    let cancelled = false;
    void (async () => {
      const api = clientFromSettings(settings);
      for (let i = 0; i < 4 && !cancelled; i++) {
        const r = await api.sessionReview(endedSessionId);
        if (r.ok && r.data.exportPath) {
          setExportResult({ saved: true, path: r.data.exportPath });
          return;
        }
        if (r.ok && i >= 2) {
          setExportResult({ saved: false, reason: 'サーバーは出力していません' });
          return;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, exportRequested, exportResult, settings, endedSessionId]);

  const openOptions = useCallback(() => void sendSw({ target: 'sw', type: 'ui.openOptions' }), []);

  const onStart = useCallback(
    (p: StartParams) => {
      if (!settings?.session) return;
      setStarting(true);
      setStartError(null);
      dispatch({ type: 'reset' });
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
          },
        },
      });
    },
    [settings],
  );

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
        exportResult={exportResult}
        onClose={() => window.close()}
      />
    );
  }

  if (phase === 'live' && snapshot) {
    return (
      <LiveView
        view={selectCardView(state, now)}
        transcript={selectTranscript(state)}
        warnings={state.warnings}
        levels={levels}
        snapshot={snapshot}
        status={state.status}
        usage={state.usage}
        lastError={state.lastError ? `サーバー: ${state.lastError.message}` : null}
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
      starting={starting}
      startError={startError}
      now={now}
      onStart={onStart}
      onOpenOptions={openOptions}
      onRefresh={() => void refreshServer()}
      onSelectMic={(id) => void saveSettings({ micDeviceId: id })}
    />
  );
}
