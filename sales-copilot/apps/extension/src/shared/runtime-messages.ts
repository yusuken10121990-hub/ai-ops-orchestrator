/**
 * 拡張機能内（service worker / offscreen / copilot ウィンドウ / 設定画面）のメッセージ。
 * offscreen document で使える chrome API は runtime だけなので、全て runtime メッセージで中継する。
 * `target` で宛先を絞り、他の文脈は無視する。サーバーとの WebSocket は offscreen だけが持つ。
 */
import type { ClientMessage, ServerMessage, SessionStartMessage } from '@sales-copilot/contracts';
import type { AudioGap } from '../audio/sender';

export type CaptureSourceKey = 'SELF' | 'REMOTE';

/** offscreen 内の取得系統の状態（UI 表示用・サーバーの status とは別にローカルで分かること）。 */
export type LocalSourceState =
  | 'off' // 取得していない
  | 'armed' // 取得中・音量確認のみ（外部送信前）
  | 'capturing' // 取得・送信中
  | 'paused' // 解析一時停止
  | 'user_off' // 自分の音声取得OFF
  | 'no_permission'
  | 'track_ended'
  | 'tab_closed'
  | 'device_changed'
  | 'error';

export type WsState = 'none' | 'connecting' | 'open' | 'closed' | 'error' | 'unauthorized';

export interface StartConfig {
  serverUrl: string;
  token: string;
  frameMs: number;
  micDeviceId: string | null;
  /** 送信待ち上限（バイト）。 */
  maxBufferedBytes: number;
  start: Omit<SessionStartMessage, 'type'>;
}

export type StopReason =
  | 'user_end'
  | 'window_closed'
  | 'tab_closed'
  | 'track_ended'
  | 'heartbeat_lost'
  | 'no_permission'
  | 'connection_failed'
  | 'server_ended'
  | 'error';

// ---- UI → service worker ----
export type ToSw =
  | { target: 'sw'; type: 'ui.getTarget' }
  | { target: 'sw'; type: 'ui.start'; config: StartConfig }
  | { target: 'sw'; type: 'ui.openOptions' }
  /** Meet のポップアップで「接続」が押された（content script から。対象タブは sender.tab）。 */
  | { target: 'sw'; type: 'meet.connect'; meetingCode: string; purpose: string }
  /** copilot 画面が自動開始を処理した（再読み込みで二重に開始しない）。 */
  | { target: 'sw'; type: 'ui.autoStartDone' };

export interface MeetConnectResult {
  ok: boolean;
  error?: string;
  /** 事前確認で分かった問題（サーバー未起動・ペアリング切れ）。error にはその直し方の 1 行が入る。 */
  problem?: import('./pairing').PairingProblem;
}

/** 会議音声の取り方。tab = 拡張アイコン（tabCapture）、inpage = Meet ポップアップの「接続」（ページ内取得）。 */
export type CaptureVia = 'tab' | 'inpage';

/** 「接続」1 タップで開いた画面が、確認画面を挟まずに開始するための情報。 */
export interface AutoStartRequest {
  purpose: string;
  meetingCode: string;
  requestedAt: number;
}

export interface TargetInfo {
  tabId: number | null;
  title: string | null;
  isMeet: boolean;
  /** 会議タブの音声を音量確認のために取得済みか（外部送信はまだ）。 */
  armed: boolean;
  armError: string | null;
  via: CaptureVia | null;
  /** 未処理の自動開始（Meet ポップアップの「接続」）。null = 通常の開始前画面。 */
  autoStart: AutoStartRequest | null;
}

// ---- service worker / UI → offscreen ----
export type ToOffscreen =
  | { target: 'offscreen'; type: 'arm'; streamId: string }
  /** このタブの content script からの音声 Port だけを受け付ける（Meet ポップアップの「接続」）。 */
  | { target: 'offscreen'; type: 'inpage.expect'; tabId: number }
  | { target: 'offscreen'; type: 'start'; config: StartConfig }
  | { target: 'offscreen'; type: 'client'; message: ClientMessage }
  | { target: 'offscreen'; type: 'self.set'; enabled: boolean }
  | { target: 'offscreen'; type: 'pause.set'; paused: boolean }
  | { target: 'offscreen'; type: 'end'; exportRequested: boolean }
  | { target: 'offscreen'; type: 'stop'; reason: StopReason }
  | { target: 'offscreen'; type: 'heartbeat' }
  | { target: 'offscreen'; type: 'getState' };

export interface OffscreenSnapshot {
  phase: 'idle' | 'armed' | 'connecting' | 'live' | 'ending' | 'stopped';
  sources: Record<CaptureSourceKey, LocalSourceState>;
  ws: WsState;
  paused: boolean;
  selfEnabled: boolean;
  sessionId: string | null;
  inputSampleRate: number | null;
  stopReason: StopReason | null;
}

// ---- offscreen → UI / service worker ----
export type FromOffscreen =
  | { target: 'ui'; type: 'snapshot'; snapshot: OffscreenSnapshot }
  | { target: 'ui'; type: 'levels'; levels: Record<CaptureSourceKey, number | null> }
  | { target: 'ui'; type: 'server'; message: ServerMessage }
  | { target: 'ui'; type: 'gap'; gap: AudioGap; phase: 'start' | 'end' }
  | { target: 'ui'; type: 'offscreen.error'; message: string }
  | { target: 'sw'; type: 'offscreen.stopped'; reason: StopReason };

/**
 * 終了時の結果（UI 表示用）。通常はサーバーの session.ended から作る。
 * session.ended を受け取れなかった場合だけ GET /sessions/:id/review で確認する（source='review'）。
 */
export type EndResult =
  | { source: 'session.ended' | 'review'; exportPath: string | null; reviewAvailableUntil: number | null }
  | { source: 'unknown' };

export type AnyRuntimeMessage = ToSw | ToOffscreen | FromOffscreen;
