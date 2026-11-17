/**
 * Meet ページの content script（隔離 world, document_start）。
 * - 通話に参加したら「接続／拒否」のポップアップを Shadow DOM で出す（Meet の CSS の影響を受けない）。
 * - 「接続」1 タップで: MAIN world に取得開始を指示 → service worker へ開始依頼（カンペ画面を開く）
 *   → offscreen との runtime Port を開き、16kHz PCM16 を中継する。
 * - 「拒否」/×: その会議では何も取得しない。タブが開いている間（sessionStorage）は再表示しない。
 * - Port が切れたら（終了・ウィンドウを閉じた・拡張の再読み込み）ページ内の取得を全部止める。
 */
import {
  connectFailure,
  initialPopupState,
  isDeclined,
  isPopupVisible,
  parseMeetingCode,
  popupReducer,
  purposeFromMeetTitle,
  rememberDeclined,
  type DecisionStore,
  type PopupEvent,
  type PopupState,
} from './popup-state';
import {
  BRIDGE_HELLO,
  MEET_PORT_NAME,
  pcmToBase64,
  type FromOffscreenPort,
  type FromPage,
  type ToOffscreenPort,
  type ToPage,
} from './wire';
import { REPAIR_BUTTON_LABEL } from '../shared/pairing';
import type { MeetConnectResult, ToSw } from '../shared/runtime-messages';

declare global {
  interface Window {
    __zerosysCopilotContent?: boolean;
  }
}

const OBSERVE_MS = 1000;
const LEAVE_SELECTORS = ['[aria-label*="通話から退出"]', '[aria-label*="Leave call"]', '[data-tooltip*="通話から退出"]'];

const CSS = `
:host { all: initial; }
.box { position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 320px; box-sizing: border-box;
  font: 14px/1.5 system-ui, "Segoe UI", "Hiragino Sans", "Meiryo", sans-serif; color: #111; background: #fff;
  border: 1px solid #c7c7c7; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.25); padding: 14px 16px; }
.head { display: flex; justify-content: space-between; align-items: center; font-weight: 700; margin-bottom: 6px; }
.x { all: unset; cursor: pointer; padding: 2px 8px; border-radius: 6px; font-size: 18px; line-height: 1; color: #444; }
.x:focus-visible, button:focus-visible { outline: 3px solid #1a73e8; outline-offset: 2px; }
p { margin: 4px 0 10px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
button.b { font: inherit; font-weight: 700; padding: 10px 14px; border-radius: 8px; cursor: pointer; border: 1px solid #888; background: #f4f4f4; color: #111; min-width: 96px; }
button.primary { background: #1a73e8; border-color: #1a73e8; color: #fff; flex: 1; }
.err { color: #b00020; }
@media (prefers-color-scheme: dark) {
  .box { background: #202124; color: #eee; border-color: #555; }
  .x { color: #ccc; }
  button.b { background: #303134; color: #eee; border-color: #777; }
  button.primary { background: #8ab4f8; border-color: #8ab4f8; color: #111; }
  .err { color: #f28b82; }
}
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

(() => {
  if (window.__zerosysCopilotContent) return;
  window.__zerosysCopilotContent = true;

  const store: DecisionStore = {
    get: (k) => window.sessionStorage.getItem(k),
    set: (k, v) => window.sessionStorage.setItem(k, v),
  };

  // ---------------------------------------------------------------- MAIN world との橋
  let pagePort: MessagePort | null = null;
  let rtcActive = false;
  let offPort: chrome.runtime.Port | null = null;

  const toPage = (msg: ToPage) => pagePort?.postMessage(msg);

  const openBridge = () => {
    const ch = new MessageChannel();
    ch.port1.onmessage = (ev: MessageEvent) => {
      const m = ev.data as FromPage;
      if (!m || typeof m.type !== 'string') return;
      if (m.type === 'ready') {
        pagePort = ch.port1;
        return;
      }
      if (m.type === 'rtc.active') {
        rtcActive = m.remoteTracks > 0;
        tick();
        return;
      }
      if (!offPort) return; // 接続前の音声はどこへも送らない
      let out: ToOffscreenPort;
      if (m.type === 'pcm') out = { type: 'pcm', source: m.source, b64: pcmToBase64(m.pcm), levelDb: m.levelDb };
      else out = { type: m.type, name: m.name };
      try {
        offPort.postMessage(out);
      } catch {
        /* 切断済み */
      }
    };
    window.postMessage({ type: BRIDGE_HELLO }, window.location.origin, [ch.port2]);
  };
  // MAIN world 側の読み込み順は保証されないので、応答があるまで数回試す
  let tries = 0;
  const retry = window.setInterval(() => {
    if (pagePort || ++tries > 20) return window.clearInterval(retry);
    openBridge();
  }, 250);
  openBridge();

  // ---------------------------------------------------------------- ポップアップ
  let state: PopupState = initialPopupState;
  let host: HTMLElement | null = null;
  let root: ShadowRoot | null = null;
  let hideTimer: number | null = null;

  const dispatch = (e: PopupEvent) => {
    const prev = state;
    state = popupReducer(state, e);
    if (state === prev) return;
    if (state.kind === 'declined' && prev.kind !== 'declined') rememberDeclined(store, state.code);
    render();
  };

  const ensureHost = (): ShadowRoot => {
    if (root && host?.isConnected) return root;
    host = el('div', { id: 'zerosys-copilot-popup' });
    root = host.attachShadow({ mode: 'open' });
    (document.body ?? document.documentElement).appendChild(host);
    return root;
  };

  function render(): void {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
    const visible = isPopupVisible(state) || state.kind === 'connected';
    if (!visible) {
      host?.remove();
      host = null;
      root = null;
      return;
    }
    const r = ensureHost();
    r.replaceChildren();
    r.appendChild(el('style', {}, CSS));
    const box = el('div', { class: 'box', role: 'dialog', 'aria-label': 'ZEROSYS カンペ接続' });
    const head = el('div', { class: 'head' });
    head.appendChild(el('span', {}, 'ZEROSYS カンペ'));
    if (state.kind === 'prompt' || state.kind === 'error') {
      const x = el('button', { class: 'x', type: 'button', 'aria-label': '閉じる（この会議では接続しない）' }, '×');
      x.addEventListener('click', () => dispatch({ type: 'dismiss' }));
      head.appendChild(x);
    }
    box.appendChild(head);

    if (state.kind === 'prompt' || state.kind === 'error') {
      if (state.kind === 'error') box.appendChild(el('p', { class: 'err', role: 'alert' }, state.message));
      box.appendChild(el('p', {}, '相手に説明・同意済みの場合のみ接続してください'));
      const row = el('div', { class: 'row' });
      const openOptions = () => void chrome.runtime.sendMessage({ target: 'sw', type: 'ui.openOptions' } satisfies ToSw).catch(() => {});
      const repair = state.kind === 'error' && state.fix === 'options';
      if (repair) {
        // ペアリング切れ: 直す操作（設定画面）を主ボタンに。再ペアリング後に「もう一度接続」
        const opt = el('button', { class: 'b primary', type: 'button' }, REPAIR_BUTTON_LABEL);
        opt.addEventListener('click', openOptions);
        row.append(opt);
      }
      const ok = el('button', { class: repair ? 'b' : 'b primary', type: 'button' }, state.kind === 'error' ? 'もう一度接続' : '接続');
      ok.addEventListener('click', onConnect);
      const no = el('button', { class: 'b', type: 'button' }, '拒否');
      no.addEventListener('click', () => dispatch({ type: 'decline' }));
      row.append(ok, no);
      if (state.kind === 'error' && !repair) {
        const opt = el('button', { class: 'b', type: 'button' }, '設定を開く');
        opt.addEventListener('click', openOptions);
        row.append(opt);
      }
      box.appendChild(row);
    } else if (state.kind === 'connecting') {
      box.appendChild(el('p', { role: 'status' }, '接続中…（カンペ画面を開いています）'));
    } else if (state.kind === 'connected') {
      box.appendChild(el('p', { role: 'status' }, '接続しました。カンペ画面で状態を確認できます。'));
      hideTimer = window.setTimeout(() => {
        host?.remove();
        host = null;
        root = null;
      }, 4000);
    }
    r.appendChild(box);
  }

  // ---------------------------------------------------------------- 接続
  const stopPage = () => toPage({ type: 'stop.all' });

  const attachOffscreen = () => {
    const p = chrome.runtime.connect({ name: MEET_PORT_NAME });
    offPort = p;
    p.onMessage.addListener((raw: unknown) => {
      const m = raw as FromOffscreenPort;
      if (!m || typeof m.type !== 'string') return;
      if (m.type === 'stop.all') {
        stopPage();
        return;
      }
      toPage(m);
    });
    p.onDisconnect.addListener(() => {
      if (offPort === p) offPort = null;
      stopPage();
      dispatch({ type: 'capture.ended' });
    });
  };

  function onConnect(): void {
    const code = state.kind === 'prompt' || state.kind === 'error' ? state.code : null;
    if (!code) return;
    dispatch({ type: 'connect' });
    // タップの直後（ユーザー操作の有効期間内）にページ内の音声処理を始める。送信は接続が確立してから。
    toPage({ type: 'remote.start' });
    const req: ToSw = {
      target: 'sw',
      type: 'meet.connect',
      meetingCode: code,
      purpose: purposeFromMeetTitle(document.title, code),
    };
    chrome.runtime
      .sendMessage(req)
      .then((res: MeetConnectResult | undefined) => {
        if (!res?.ok) {
          stopPage();
          dispatch(connectFailure(res));
          return;
        }
        attachOffscreen();
        dispatch({ type: 'connect.ok' });
      })
      .catch((e: unknown) => {
        stopPage();
        dispatch(connectFailure(null, e instanceof Error ? e.message : String(e)));
      });
  }

  // ---------------------------------------------------------------- 会議の監視
  const joinedByDom = () => LEAVE_SELECTORS.some((s) => document.querySelector(s) !== null);

  function tick(): void {
    const code = parseMeetingCode(window.location.href);
    // 接続中に別の会議へ移った: 前の会議の取得は続けない
    if (offPort && state.code !== null && code !== state.code) {
      offPort.disconnect();
      offPort = null;
      stopPage();
    }
    const joined = code !== null && (rtcActive || joinedByDom());
    dispatch({ type: 'observe', code, joined, declined: code !== null && isDeclined(store, code) });
  }
  window.setInterval(tick, OBSERVE_MS);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick, { once: true });
  else tick();
})();
