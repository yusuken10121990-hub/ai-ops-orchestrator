import { SessionToken } from '@sales-copilot/contracts';
import { DEFAULT_FRAME_MS, clampFrameMs } from '../audio/dsp/chunker';
import { DEFAULT_MAX_BUFFERED_BYTES } from '../audio/sender';

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:8787';

export type ThemePref = 'light' | 'dark';

export interface Settings {
  serverUrl: string;
  /** 一度限りのペアリングで得た期限付きトークン。chrome.storage.local（この拡張だけが読める）に置く。 */
  session: SessionToken | null;
  micDeviceId: string | null;
  frameMs: number;
  maxBufferedBytes: number;
  fontScale: number;
  theme: ThemePref;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: DEFAULT_SERVER_URL,
  session: null,
  micDeviceId: null,
  frameMs: DEFAULT_FRAME_MS,
  maxBufferedBytes: DEFAULT_MAX_BUFFERED_BYTES,
  fontScale: 1,
  theme: 'light',
};

export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.6;

/** ローカルサーバーのみ許可（host_permissions と一致）。 */
export function normalizeServerUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'http:') return null;
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return null;
    if (u.username || u.password) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function sanitizeSettings(raw: Partial<Settings> | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  const sess = SessionToken.safeParse(s.session);
  return {
    serverUrl: normalizeServerUrl(s.serverUrl) ?? DEFAULT_SERVER_URL,
    session: sess.success ? sess.data : null,
    micDeviceId: typeof s.micDeviceId === 'string' && s.micDeviceId ? s.micDeviceId : null,
    frameMs: clampFrameMs(s.frameMs),
    maxBufferedBytes:
      Number.isFinite(s.maxBufferedBytes) && s.maxBufferedBytes >= 16 * 1024 ? s.maxBufferedBytes : DEFAULT_MAX_BUFFERED_BYTES,
    fontScale: Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Number(s.fontScale) || 1)),
    theme: s.theme === 'dark' ? 'dark' : 'light',
  };
}

export function isTokenUsable(s: Settings, now: number): boolean {
  return !!s.session && s.session.expiresAt > now + 30_000;
}

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  try {
    const r = await chrome.storage.local.get(KEY);
    return sanitizeSettings(r[KEY] as Partial<Settings> | undefined);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const l = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[KEY]) cb(sanitizeSettings(changes[KEY].newValue as Partial<Settings>));
  };
  chrome.storage.onChanged.addListener(l);
  return () => chrome.storage.onChanged.removeListener(l);
}
