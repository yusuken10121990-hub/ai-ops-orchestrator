/**
 * service worker（MV3）。長時間の MediaStream は持たない。
 * - アクションのクリック（会議タブ上のユーザー操作）で対象タブを最初に記録し、
 *   tabCapture.getMediaStreamId({ targetTabId }) を取得して offscreen へ渡す（ID は数秒で失効するため即利用）。
 * - その後 copilot ウィンドウ（popup 型）を開く。ウィンドウを開いても・他タブへ移っても対象は変えない。
 * - ウィンドウが閉じられたら取得・送信を全停止し offscreen を閉じる。対象タブが閉じられても停止。
 */
import type { FromOffscreen, TargetInfo, ToOffscreen, ToSw } from '../shared/runtime-messages';

const OFFSCREEN_URL = 'offscreen.html';
const COPILOT_URL = 'copilot.html';

interface SwState {
  targetTabId: number | null;
  targetTitle: string | null;
  isMeet: boolean;
  copilotWindowId: number | null;
  armed: boolean;
  armError: string | null;
}

const EMPTY: SwState = { targetTabId: null, targetTitle: null, isMeet: false, copilotWindowId: null, armed: false, armError: null };

// service worker は停止・再起動されるため、状態は storage.session に置く（ディスクへは書かない）。
async function load(): Promise<SwState> {
  const r = await chrome.storage.session.get('sw');
  return { ...EMPTY, ...((r.sw as Partial<SwState>) ?? {}) };
}
async function save(patch: Partial<SwState>): Promise<SwState> {
  const next = { ...(await load()), ...patch };
  await chrome.storage.session.set({ sw: next });
  return next;
}

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    // USER_MEDIA のみ。AUDIO_PLAYBACK は 30 秒無音で自動終了されるため付けない（会議の沈黙で止まるのを防ぐ）。
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: '会議タブの音声と選択したマイクを取得し、ローカルサーバーへ送るため（本人が開始操作した商談のみ）',
  });
}

async function closeOffscreen(): Promise<void> {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

/**
 * 停止の少し後に offscreen を閉じる。ただし、その間に新しい商談が始まっていたら閉じない
 * （終了直後に再開始すると、前回の遅延クローズで新しい取得が切られていた＝結合テストで発見）。
 */
function closeOffscreenLaterIfIdle(delayMs = 1500): void {
  setTimeout(() => {
    void (async () => {
      if (!(await hasOffscreen())) return;
      const snap = (await toOffscreen({ target: 'offscreen', type: 'getState' })) as { phase?: string } | undefined;
      if (snap?.phase && snap.phase !== 'stopped' && snap.phase !== 'idle') return;
      await closeOffscreen();
    })();
  }, delayMs);
}

function toOffscreen(msg: ToOffscreen): Promise<unknown> {
  return chrome.runtime.sendMessage(msg).catch(() => undefined);
}

async function armTarget(tabId: number): Promise<void> {
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureOffscreen();
    const snap = (await toOffscreen({ target: 'offscreen', type: 'arm', streamId })) as { sources?: { REMOTE?: string } } | undefined;
    const ok = snap?.sources?.REMOTE === 'armed' || snap?.sources?.REMOTE === 'capturing';
    await save({ armed: ok, armError: ok ? null : '会議タブの音声を取得できませんでした' });
  } catch (e) {
    await save({ armed: false, armError: e instanceof Error ? e.message : String(e) });
  }
}

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    const st = await load();
    if (st.copilotWindowId !== null) {
      // 既に開いている: 対象は変えずにウィンドウを前面へ。
      const w = await chrome.windows.get(st.copilotWindowId).catch(() => null);
      if (w) {
        // まだ会議タブを取得できていない場合だけ、本人がクリックしたタブを対象として取り直す。
        if (!st.armed && tab.id !== undefined) {
          const url = tab.url ?? '';
          await save({ targetTabId: tab.id, targetTitle: tab.title ?? null, isMeet: url.startsWith('https://meet.google.com/') });
          await armTarget(tab.id);
        }
        await chrome.windows.update(st.copilotWindowId, { focused: true });
        return;
      }
    }
    if (tab.id === undefined) return;
    // 1) 対象タブを最初に記録（以後のフォーカス移動で変えない）
    const url = tab.url ?? '';
    await save({
      ...EMPTY,
      targetTabId: tab.id,
      targetTitle: tab.title ?? null,
      isMeet: url.startsWith('https://meet.google.com/'),
    });
    // 2) ユーザー操作起点で stream ID を取得し offscreen で即利用（音量確認のみ・送信はまだ）
    await armTarget(tab.id);
    // 3) 本人用の独立ウィンドウを開く
    const win = await chrome.windows.create({ url: COPILOT_URL, type: 'popup', width: 440, height: 720, focused: true });
    await save({ copilotWindowId: win?.id ?? null });
  })();
});

chrome.windows.onRemoved.addListener((windowId) => {
  void (async () => {
    const st = await load();
    if (st.copilotWindowId !== windowId) return;
    // ウィンドウを閉じたら終了（見えない状態で取得を続けない）
    await toOffscreen({ target: 'offscreen', type: 'stop', reason: 'window_closed' });
    await save({ ...EMPTY });
    closeOffscreenLaterIfIdle();
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const st = await load();
    if (st.targetTabId !== tabId) return;
    await toOffscreen({ target: 'offscreen', type: 'stop', reason: 'tab_closed' });
    await save({ targetTabId: null, armed: false });
  })();
});

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const msg = raw as ToSw | FromOffscreen;
  if (!msg || msg.target !== 'sw') return false;
  switch (msg.type) {
    case 'ui.getTarget':
      void load().then((st) => {
        const info: TargetInfo = {
          tabId: st.targetTabId,
          title: st.targetTitle,
          isMeet: st.isMeet,
          armed: st.armed,
          armError: st.armError,
        };
        sendResponse(info);
      });
      return true;
    case 'ui.start':
      void (async () => {
        await ensureOffscreen();
        await toOffscreen({ target: 'offscreen', type: 'start', config: msg.config });
        sendResponse({ ok: true });
      })();
      return true;
    case 'ui.openOptions':
      void chrome.runtime.openOptionsPage();
      return false;
    case 'offscreen.stopped':
      void (async () => {
        await save({ armed: false });
        // UI が終了画面を出せるよう少し待ってから閉じる（新しい商談が始まっていれば閉じない）
        closeOffscreenLaterIfIdle();
      })();
      return false;
  }
  return false;
});
