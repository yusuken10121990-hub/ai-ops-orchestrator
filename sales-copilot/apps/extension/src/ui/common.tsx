import { useCallback, useEffect, useState } from 'react';
import type { Label } from '../shared/labels';
import { FONT_SCALE_MAX, FONT_SCALE_MIN, loadSettings, onSettingsChanged, saveSettings, type Settings } from '../shared/settings';

/** 状態バッジ。色だけでなく必ず文字で伝える。 */
export function Badge({ label, prefix }: { label: Label; prefix?: string }) {
  return (
    <span className={`badge tone-${label.tone}`}>
      {prefix ? `${prefix}: ` : ''}
      {label.text}
    </span>
  );
}

/** レベルメーター（dBFS -60〜0 を 0〜100%）。 */
export function Meter({ name, db, note }: { name: string; db: number | null; note?: string }) {
  const pct = db === null ? 0 : Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const text = db === null ? note ?? '取得なし' : db <= -59 ? '無音' : `${Math.round(db)} dB`;
  return (
    <div className="meter">
      <span>{name}</span>
      <div className="bar" role="meter" aria-label={`${name}の音量`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-valuetext={text}>
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="small dim">{text}</span>
    </div>
  );
}

export function applyPrefs(s: Pick<Settings, 'fontScale' | 'theme'>): void {
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.style.setProperty('--scale', String(s.fontScale));
}

/** 文字サイズと明暗（chrome.storage.local に保存）。 */
export function usePrefs() {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    let alive = true;
    void loadSettings().then((s) => {
      if (!alive) return;
      setSettings(s);
      applyPrefs(s);
    });
    const off = onSettingsChanged((s) => {
      setSettings(s);
      applyPrefs(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);
  const changeFont = useCallback(
    (delta: number) => {
      const cur = settings?.fontScale ?? 1;
      const next = Math.round(Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, cur + delta)) * 10) / 10;
      void saveSettings({ fontScale: next });
    },
    [settings],
  );
  const toggleTheme = useCallback(() => {
    void saveSettings({ theme: settings?.theme === 'dark' ? 'light' : 'dark' });
  }, [settings]);
  return { settings, changeFont, toggleTheme };
}

/** 画面内の音量確認用（設定画面・開始前のマイクテスト）。取得はこのページ内だけで、送信しない。 */
export function useLocalMicTest(deviceId: string | null) {
  const [db, setDb] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!running) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true },
        });
        if (cancelled) return;
        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const an = ctx.createAnalyser();
        an.fftSize = 2048;
        src.connect(an); // スピーカーへは繋がない
        const buf = new Float32Array(an.fftSize);
        const tick = () => {
          an.getFloatTimeDomainData(buf);
          let s = 0;
          for (const v of buf) s += v * v;
          const r = Math.sqrt(s / buf.length);
          setDb(r <= 1e-5 ? -100 : 20 * Math.log10(r));
          raf = requestAnimationFrame(tick);
        };
        tick();
        setError(null);
      } catch (e) {
        const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
        setError(name === 'NotAllowedError' ? 'マイクが許可されていません' : 'マイクを開けませんでした');
        setRunning(false);
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      for (const t of stream?.getTracks() ?? []) t.stop();
      void ctx?.close();
      setDb(null);
    };
  }, [running, deviceId]);
  return { db, running, error, start: () => setRunning(true), stop: () => setRunning(false) };
}

export function useAudioInputs(refreshKey: number) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      navigator.mediaDevices
        .enumerateDevices()
        .then((d) => alive && setDevices(d.filter((x) => x.kind === 'audioinput')))
        .catch(() => {});
    void load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener('devicechange', load);
    };
  }, [refreshKey]);
  return devices;
}

/** マイク許可状態（ラベルが読めれば許可済み）。 */
export function hasMicPermission(devices: MediaDeviceInfo[]): boolean {
  return devices.some((d) => d.label !== '');
}
