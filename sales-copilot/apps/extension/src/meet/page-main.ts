/**
 * Meet ページの MAIN world に document_start で入るスクリプト（manifest の content_scripts, world: "MAIN"）。
 * ここでは chrome.* API は使えない。content script（隔離 world）とは MessageChannel だけでやりとりする。
 *
 * 役割:
 * 1) Meet が RTCPeerConnection を作る前にフックし、相手側の音声トラックを記録する（取得はしない）。
 * 2) 「接続」後、content script の指示でだけ WebAudio で 16kHz PCM16 にして content script へ渡す。
 * 文字起こし・画面の文字は扱わない（DOM・字幕のスクレイピングはしない）。
 */
import { CaptureDsp } from '../audio/dsp/capture-dsp';
import { PageAudio, installRtcHook, type AudioPipe, type PcmSink, type StreamLike, type TrackLike } from './page-audio';
import { BRIDGE_HELLO, type FromPage, type ToPage } from './wire';

declare global {
  interface Window {
    __zerosysCopilotPage?: boolean;
  }
}

(() => {
  if (window.__zerosysCopilotPage) return;
  window.__zerosysCopilotPage = true;

  // Meet の後続スクリプトが差し替えても影響を受けないよう、元の API を先に保持する
  const NativeAudioContext = window.AudioContext;
  const NativeMediaStream = window.MediaStream;
  const md = navigator.mediaDevices;
  const nativeGetUserMedia = md && md.getUserMedia ? md.getUserMedia.bind(md) : null;

  let port: MessagePort | null = null;
  let pendingActive: FromPage | null = null;

  const emit = (msg: FromPage) => {
    if (!port) {
      if (msg.type === 'rtc.active') pendingActive = msg;
      return;
    }
    if (msg.type === 'pcm') port.postMessage(msg, [msg.pcm.buffer]);
    else port.postMessage(msg);
  };

  let ctx: AudioContext | null = null;
  const getCtx = (): AudioContext => {
    if (!ctx || ctx.state === 'closed') {
      const c = new NativeAudioContext({ latencyHint: 'interactive' });
      // 画面共有・出力デバイスの切替などで止められたら動かし直す（タブを切り替えても止めない）
      c.addEventListener('statechange', () => {
        if (ctx === c && c.state !== 'running' && c.state !== 'closed') void c.resume().catch(() => {});
      });
      ctx = c;
    }
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    return ctx;
  };

  const createPipe = (_source: string, onPcm: PcmSink): AudioPipe => {
    const c = getCtx();
    const mix = c.createGain();
    // ScriptProcessor は入力 1ch 指定で自動的にモノラルへ混ぜられる。AudioWorklet はページの CSP で
    // 読み込めない可能性があるため、ここでは使わない（リサンプリングは同じ CaptureDsp）。
    const proc = c.createScriptProcessor(2048, 1, 1);
    const silent = c.createGain();
    silent.gain.value = 0; // 処理を動かすためだけに destination へ繋ぐ（音は出さない）
    mix.connect(proc);
    proc.connect(silent);
    silent.connect(c.destination);
    const dsp = new CaptureDsp(c.sampleRate, 40);
    let enabled = true;
    proc.onaudioprocess = (ev: AudioProcessingEvent) => {
      if (!enabled) return;
      const block = dsp.process([new Float32Array(ev.inputBuffer.getChannelData(0))]);
      if (block) onPcm(block.pcm, block.levelDb, block.inputSampleRate);
    };
    const nodes = new Map<string, MediaStreamAudioSourceNode>();
    return {
      addTrack(t: TrackLike) {
        if (nodes.has(t.id)) return;
        const src = c.createMediaStreamSource(new NativeMediaStream([t as unknown as MediaStreamTrack]));
        src.connect(mix);
        nodes.set(t.id, src);
      },
      removeTrack(t: TrackLike) {
        const n = nodes.get(t.id);
        if (!n) return;
        try {
          n.disconnect();
        } catch {
          /* noop */
        }
        nodes.delete(t.id);
      },
      setEnabled(e: boolean) {
        enabled = e;
      },
      close() {
        enabled = false;
        proc.onaudioprocess = null;
        for (const n of nodes.values()) {
          try {
            n.disconnect();
          } catch {
            /* noop */
          }
        }
        nodes.clear();
        try {
          mix.disconnect();
          proc.disconnect();
          silent.disconnect();
        } catch {
          /* noop */
        }
      },
    };
  };

  let hook: ReturnType<typeof installRtcHook> | null = null;

  const audio = new PageAudio({
    createPipe,
    async getMic() {
      if (!nativeGetUserMedia) throw Object.assign(new Error('getUserMedia unavailable'), { name: 'NotSupportedError' });
      return (await nativeGetUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
      })) as unknown as StreamLike;
    },
    collectRemoteTracks() {
      const out: TrackLike[] = [];
      for (const pc of hook?.peers() ?? []) {
        for (const r of pc.getReceivers?.() ?? []) if (r.track && r.track.kind === 'audio') out.push(r.track);
      }
      for (const el of Array.from(document.querySelectorAll('audio'))) {
        const so = (el as HTMLMediaElement).srcObject;
        if (so instanceof NativeMediaStream) for (const t of so.getAudioTracks()) out.push(t as unknown as TrackLike);
      }
      return out;
    },
    closeAll() {
      const c = ctx;
      ctx = null;
      if (c && c.state !== 'closed') void c.close().catch(() => {});
    },
    emit,
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    now: () => performance.now(),
  });

  hook = installRtcHook(window as unknown as Record<string, unknown>, (t) => audio.addRemoteTrack(t));

  // content script からの握手（MessagePort の受け渡し）。新しい content script（拡張の更新後など）が来たら差し替える。
  window.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== window || !ev.data || (ev.data as { type?: unknown }).type !== BRIDGE_HELLO || !ev.ports[0]) return;
    if (port) {
      audio.stopAll();
      port.close();
    }
    port = ev.ports[0];
    port.onmessage = (m: MessageEvent) => {
      const msg = m.data as ToPage;
      if (msg && typeof msg.type === 'string') audio.handle(msg);
    };
    port.postMessage({ type: 'ready' } satisfies FromPage);
    if (pendingActive) port.postMessage(pendingActive);
    else if (audio.remoteTrackCount > 0) port.postMessage({ type: 'rtc.active', remoteTracks: audio.remoteTrackCount } satisfies FromPage);
    pendingActive = null;
  });
})();
