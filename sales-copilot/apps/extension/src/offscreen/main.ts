/**
 * offscreen document（reason: USER_MEDIA）。長時間の MediaStream・AudioContext・WebSocket はここだけが持つ。
 * service worker や copilot ウィンドウには MediaStream を置かない（SPEC §6-2）。
 * offscreen では chrome.runtime 以外の拡張 API は使えないため、設定値は start メッセージで受け取る。
 */
import { CaptureController, type AudioGraphLike, type CaptureDeps, type InPageLink, type MediaStreamLike, type PcmListener } from './capture-controller';
import type { FromOffscreen, ToOffscreen } from '../shared/runtime-messages';
import { MEET_PORT_NAME, base64ToPcm, parseToOffscreenPort } from '../meet/wire';

const WORKLET_URL = chrome.runtime.getURL('capture-worklet.js');
const PROCESSOR_NAME = 'sales-copilot-capture';

async function createGraph(): Promise<AudioGraphLike> {
  // 実デバイスの既定レート（通常 48000Hz）で動かし、worklet 内で 16kHz へ実リサンプリングする。
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule(WORKLET_URL);
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

  const attach = async (stream: MediaStream, onPcm: PcmListener, playback: boolean) => {
    const src = ctx.createMediaStreamSource(stream);
    // 出力 0（スピーカーへは何も出さない）。Chrome は出力なし AudioWorkletNode も処理する。
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, { numberOfInputs: 1, numberOfOutputs: 0 });
    node.port.onmessage = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; pcm?: Int16Array; levelDb?: number };
      if (d?.type === 'pcm' && d.pcm) onPcm(d.pcm, d.levelDb ?? -100);
    };
    src.connect(node);
    // 会議タブは取得するとタブ側の再生が止まるため、ここで 1 回だけ再生し直す（二重再生にしない）。
    if (playback) src.connect(ctx.destination);
    return {
      setEnabled(enabled: boolean) {
        node.port.postMessage({ type: 'enable', enabled });
      },
      dispose() {
        try {
          src.disconnect();
        } catch {
          /* noop */
        }
        node.port.onmessage = null;
        node.port.close();
      },
    };
  };

  return {
    sampleRate: ctx.sampleRate,
    attachRemote: (s, cb) => attach(s as MediaStream, cb, true),
    attachSelf: (s, cb) => attach(s as MediaStream, cb, false),
    close: () => ctx.close(),
  };
}

function send(msg: FromOffscreen): void {
  chrome.runtime.sendMessage(msg).catch(() => {
    /* 受け手（UI）がいないときは捨てる */
  });
}

const deps: CaptureDeps = {
  async getTabStream(streamId) {
    const constraints = {
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false,
    } as unknown as MediaStreamConstraints;
    return (await navigator.mediaDevices.getUserMedia(constraints)) as unknown as MediaStreamLike;
  },
  async getMicStream(deviceId) {
    // マイク許可は見える設定画面で事前に取得済みであること（offscreen は許可ダイアログを出せない）。
    return (await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    })) as unknown as MediaStreamLike;
  },
  createGraph,
  createSocket: (url) => new WebSocket(url) as unknown as ReturnType<CaptureDeps['createSocket']>,
  now: () => performance.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  emit: send,
  onDeviceChange(cb) {
    navigator.mediaDevices.addEventListener('devicechange', cb);
    return () => navigator.mediaDevices.removeEventListener('devicechange', cb);
  },
  async listAudioInputIds() {
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.filter((d) => d.kind === 'audioinput').map((d) => d.deviceId);
  },
};

const controller = new CaptureController(deps);

// Meet ポップアップの「接続」: service worker が指定したタブの content script からの Port だけ受け付ける
let expectedInPageTab: number | null = null;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== MEET_PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined || tabId !== expectedInPageTab) {
    port.disconnect();
    return;
  }
  expectedInPageTab = null;
  let open = true;
  const link: InPageLink = {
    send(msg) {
      if (!open) return;
      try {
        port.postMessage(msg);
      } catch {
        /* 切断済み */
      }
    },
    close() {
      if (!open) return;
      open = false;
      port.disconnect();
    },
  };
  port.onMessage.addListener((raw: unknown) => {
    const m = parseToOffscreenPort(raw);
    if (!m) return;
    if (m.type === 'pcm') {
      const pcm = base64ToPcm(m.b64);
      if (pcm) controller.inPagePcm(link, m.source, pcm, m.levelDb);
    } else controller.inPageError(link, m.type === 'self.error' ? 'SELF' : 'REMOTE', m.name);
  });
  port.onDisconnect.addListener(() => {
    open = false;
    controller.inPageLost(link);
  });
  void controller.armInPage(link);
});

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const msg = raw as ToOffscreen;
  if (!msg || msg.target !== 'offscreen') return false;
  switch (msg.type) {
    case 'arm':
      void controller.arm(msg.streamId).then(() => sendResponse(controller.snapshot()));
      return true;
    case 'inpage.expect':
      expectedInPageTab = msg.tabId;
      sendResponse({ ok: true });
      return false;
    case 'start':
      void controller.start(msg.config);
      sendResponse({ ok: true });
      return false;
    case 'client':
      controller.sendClient(msg.message);
      return false;
    case 'self.set':
      void controller.setSelf(msg.enabled);
      return false;
    case 'pause.set':
      void controller.setPaused(msg.paused);
      return false;
    case 'end':
      void controller.end(msg.exportRequested);
      return false;
    case 'stop':
      if (msg.reason === 'tab_closed') controller.tabClosed();
      else void controller.stop(msg.reason);
      return false;
    case 'heartbeat':
      controller.heartbeat();
      return false;
    case 'getState':
      sendResponse(controller.snapshot());
      return false;
  }
  return false;
});
