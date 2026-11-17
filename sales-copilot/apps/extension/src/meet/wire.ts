/**
 * Meet ページ内取得（ワンタップ接続）の通信形式。
 *
 * 経路: [MAIN world: page-main] --MessagePort--> [content script: content-main]
 *       --chrome.runtime Port（名前 MEET_PORT_NAME）--> [offscreen: CaptureController]
 *
 * runtime Port は JSON 直列化なので、PCM16 は base64 文字列で運ぶ（Int16Array はそのまま渡せない）。
 * 文字起こし文字列はこの経路を通らない（音声だけ）。
 */
import type { CaptureSourceKey } from '../shared/runtime-messages';

export const MEET_PORT_NAME = 'zerosys-meet-audio';
/** MAIN world との握手に使う印（window.postMessage）。 */
export const BRIDGE_HELLO = 'zerosys-copilot/bridge-hello';

// ---- MAIN world ⇄ content script（MessagePort。構造化複製なので Int16Array を転送できる）----
export type ToPage =
  | { type: 'remote.start' }
  | { type: 'remote.enable'; enabled: boolean }
  | { type: 'self.start' }
  | { type: 'self.stop' }
  | { type: 'stop.all' };

export type FromPage =
  | { type: 'ready' }
  /** 相手側の音声トラックが見つかった（＝通話に参加済みとみなす合図）。 */
  | { type: 'rtc.active'; remoteTracks: number }
  | { type: 'pcm'; source: CaptureSourceKey; pcm: Int16Array; levelDb: number; inputSampleRate: number }
  | { type: 'self.error'; name: string }
  | { type: 'remote.error'; name: string };

// ---- content script ⇄ offscreen（runtime Port。JSON）----
export type ToOffscreenPort =
  | { type: 'pcm'; source: CaptureSourceKey; b64: string; levelDb: number }
  | { type: 'self.error'; name: string }
  | { type: 'remote.error'; name: string };

export type FromOffscreenPort =
  | { type: 'remote.enable'; enabled: boolean }
  | { type: 'self.start' }
  | { type: 'self.stop' }
  | { type: 'stop.all' };

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Int16Array（リトルエンディアン）→ base64。btoa に依存しない（worker / Node でも同じ結果）。 */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i]! & 0xffff;
    bytes[i * 2] = v & 0xff;
    bytes[i * 2 + 1] = v >> 8;
  }
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '==';
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '=';
  }
  return out;
}

const REV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** base64 → Int16Array。形式が不正なら null（不正データを音声として送らない）。 */
export function base64ToPcm(b64: string): Int16Array | null {
  if (typeof b64 !== 'string' || b64.length % 4 !== 0) return null;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  const nBytes = (b64.length / 4) * 3 - pad;
  if (nBytes % 2 !== 0) return null;
  const bytes = new Uint8Array(nBytes);
  let o = 0;
  for (let i = 0; i < b64.length; i += 4) {
    const c = [0, 1, 2, 3].map((k) => {
      const ch = b64.charCodeAt(i + k);
      if (ch === 61 /* = */ && i + k >= b64.length - pad) return 0;
      return ch < 128 ? REV[ch]! : -1;
    });
    if (c.some((x) => x < 0)) return null;
    const n = (c[0]! << 18) | (c[1]! << 12) | (c[2]! << 6) | c[3]!;
    if (o < nBytes) bytes[o++] = (n >> 16) & 0xff;
    if (o < nBytes) bytes[o++] = (n >> 8) & 0xff;
    if (o < nBytes) bytes[o++] = n & 0xff;
  }
  const out = new Int16Array(nBytes / 2);
  for (let i = 0; i < out.length; i++) {
    const v = bytes[i * 2]! | (bytes[i * 2 + 1]! << 8);
    out[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

/** offscreen が content script から受け取るメッセージの検査（形が違うものは捨てる）。 */
export function parseToOffscreenPort(raw: unknown): ToOffscreenPort | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type === 'pcm') {
    if ((m.source !== 'SELF' && m.source !== 'REMOTE') || typeof m.b64 !== 'string' || typeof m.levelDb !== 'number') return null;
    if (m.b64.length > 64_000) return null; // 1 回ぶん（数百 ms）より大きいものは受け取らない
    return { type: 'pcm', source: m.source, b64: m.b64, levelDb: m.levelDb };
  }
  if ((m.type === 'self.error' || m.type === 'remote.error') && typeof m.name === 'string') return { type: m.type, name: m.name.slice(0, 64) };
  return null;
}
