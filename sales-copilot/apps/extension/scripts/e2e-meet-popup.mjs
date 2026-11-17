// Playwright: Meet ポップアップ「接続／拒否」のワンタップ接続（偽の Meet ページ × モックサーバー）。
// 本物の meet.google.com には接続しない（context.route で偽ページを返す）。偽ページは本物の WebRTC
// （ページ内 2 本の RTCPeerConnection のループバック）で相手側の音声トラックを受信する。
// 確認すること:
// - 会議コードのページで、相手の音声トラックが届いたら（＝参加）ポップアップが出る。会議以外のページでは出ない
// - 「接続」1 回で: カンペ画面が開く／確認画面なしで開始／同意 consentConfirmed=true／前回モード（初回は API 設定で LIVE）
//   ／商談目的＝会議名／REMOTE（相手）と SELF（自分）が別系統の 16kHz フレームで届く（REMOTE は無音でない）
// - 拡張アイコン（tabCapture）は使わない（chrome.tabCapture を呼べない自動化でも開始できる＝1 タップで足りる）
// - 商談目的を変更 → session.update ／ 一時停止で両系統が止まる ／ 終了で WS が切れる
// - 「拒否」: 何も接続しない・同じ会議では再読み込みしても出ない
// - 切れても終わらせない（2026-11-17 実商談）: 画面共有の開始（新しい接続＋トラックの置き換え・古い接続の close）、
//   タブ切替、ウィンドウ切替、カンペ画面のタイマー停止（隠れた画面の間引きの再現）、サーバーとの WS 切断
//   → LIVE のまま・音声フレームが届き続ける・同じ商談で再接続。通話から退出したときだけ終わる（理由 call_left）
// 実際の Google Meet・Windows の Chrome での確認は docs/manual-checklist.md（自動化できない）。
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const req = createRequire('/opt/node-tools/node_modules/');
    return req('playwright');
  }
}

const TOKEN = 'm'.repeat(48);
const log = { connections: 0, starts: [], frames: [], json: [], closed: 0, authChecks: 0, resumes: [] };
/** true の間は WS をすぐ切る（サーバーとの通信断の再現）。 */
let refuseWs = false;

const http = createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/health') return send(200, { ok: true });
  if (req.url === '/auth/check') {
    log.authChecks++;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
    const now = Date.now();
    return send(200, { ok: true, issuedAt: now - 1000, expiresAt: now + 180 * 86400_000, scopes: ['session', 'settings'] });
  }
  if (req.url === '/config/status')
    return send(200, {
      version: 'mock',
      protocolVersion: 1,
      stt: { configured: true, provider: 'deepgram', model: 'nova-3', language: 'ja' },
      llm: { configured: true, provider: 'anthropic', model: 'mock' },
      modes: { LIVE: true, OFFLINE: true },
      offlineAnthropicAvailable: false,
      priceTable: { configured: false, currency: null, checkedDate: null },
      retentionMs: 600000,
      budget: { maxSttSeconds: null, maxLlmCalls: null, maxLlmInputTokens: null, maxLlmOutputTokens: null, maxCost: null },
    });
  if (req.url === '/facts') return send(200, { facts: [] });
  if (req.url === '/offline/scripts') return send(200, { scripts: [], defaultId: null });
  send(404, {});
});
const wss = new WebSocketServer({ noServer: true });
http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws)));
wss.on('connection', (ws) => {
  log.connections++;
  if (refuseWs) {
    ws.close(1011, 'down');
    return;
  }
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const b = Buffer.from(data);
      const hlen = b.readUInt32LE(0);
      const header = JSON.parse(b.subarray(4, 4 + hlen).toString('utf8'));
      const pcm = new Int16Array(b.buffer.slice(b.byteOffset + 4 + hlen, b.byteOffset + b.length));
      let peak = 0;
      for (const v of pcm) peak = Math.max(peak, Math.abs(v));
      log.frames.push({ header, peak, at: Date.now() });
      return;
    }
    const m = JSON.parse(String(data));
    log.json.push(m);
    if (m.type === 'hello') {
      if (m.token !== TOKEN) return ws.close(1008);
      ws.send(JSON.stringify({ type: 'hello.ack', protocolVersion: 1, serverVersion: 'mock' }));
    }
    if (m.type === 'session.resume') {
      log.resumes.push(m.sessionId);
      const known = m.sessionId === `sess-meet-${log.starts.length}`;
      ws.send(JSON.stringify({ type: 'session.resumed', sessionId: m.sessionId, ok: known }));
      return;
    }
    if (m.type === 'session.start') {
      log.starts.push(m);
      const now = Date.now();
      const st = { state: 'active', reason: null, since: now };
      ws.send(
        JSON.stringify({
          type: 'status',
          sessionId: `sess-meet-${log.starts.length}`,
          lifecycle: 'capturing',
          mode: m.mode,
          externalSending: m.mode === 'LIVE',
          storage: 'memory_only',
          pipelines: { capture: { SELF: st, REMOTE: st }, stt: st, advice: { state: 'waiting', reason: 'cooldown', since: now } },
          at: now,
        }),
      );
    }
  });
  ws.on('close', () => log.closed++);
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const port = http.address().port;

// 偽の Meet ページ: 本物の WebRTC で「相手側」の音声（440Hz）を受信し、Meet と同じく <audio> で再生する。
// 参加ボタン等の DOM は置かない（ポップアップは RTCPeerConnection のフックで参加を検知できること）。
const FAKE_MEET = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>
<p>fake meet</p>
<script>
(async () => {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  osc.frequency.value = 440;
  const g = ctx.createGain(); g.gain.value = 0.5;
  const dest = ctx.createMediaStreamDestination();
  osc.connect(g); g.connect(dest); osc.start();
  const pc1 = new RTCPeerConnection();
  const pc2 = new RTCPeerConnection();
  pc1.onicecandidate = (e) => e.candidate && pc2.addIceCandidate(e.candidate);
  pc2.onicecandidate = (e) => e.candidate && pc1.addIceCandidate(e.candidate);
  pc2.ontrack = (e) => {
    const a = document.createElement('audio');
    a.srcObject = e.streams[0] || new MediaStream([e.track]);
    a.autoplay = true;
    document.body.appendChild(a);
    window.__remoteTrack = true;
  };
  const sender = pc1.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
  const offer = await pc1.createOffer();
  await pc1.setLocalDescription(offer);
  await pc2.setRemoteDescription(offer);
  const answer = await pc2.createAnswer();
  await pc2.setLocalDescription(answer);
  await pc1.setRemoteDescription(answer);
  window.__pcs = [pc1, pc2];
  // 画面共有の開始の再現: Meet は発表時に新しい接続を作り、送信トラックを置き換え、古い接続を閉じることがある
  window.__present = async () => {
    const osc2 = ctx.createOscillator();
    osc2.frequency.value = 660;
    const g2 = ctx.createGain(); g2.gain.value = 0.5;
    const dest2 = ctx.createMediaStreamDestination();
    osc2.connect(g2); g2.connect(dest2); osc2.start();
    await sender.replaceTrack(dest2.stream.getAudioTracks()[0]);
    const pc3 = new RTCPeerConnection();
    const pc4 = new RTCPeerConnection();
    pc3.onicecandidate = (e) => e.candidate && pc4.addIceCandidate(e.candidate);
    pc4.onicecandidate = (e) => e.candidate && pc3.addIceCandidate(e.candidate);
    pc4.ontrack = (e) => {
      const a = document.createElement('audio');
      a.srcObject = e.streams[0] || new MediaStream([e.track]);
      a.autoplay = true;
      document.body.appendChild(a);
      window.__presentTrack = true;
    };
    pc3.addTrack(dest2.stream.getAudioTracks()[0], dest2.stream);
    const o = await pc3.createOffer();
    await pc3.setLocalDescription(o);
    await pc4.setRemoteDescription(o);
    const a2 = await pc4.createAnswer();
    await pc4.setLocalDescription(a2);
    await pc3.setRemoteDescription(a2);
    window.__pcs.push(pc3, pc4);
  };
  window.__closeFirst = () => { pc1.close(); pc2.close(); };
  // 通話から退出: 全ての接続を閉じ、再生も止める
  window.__leave = () => {
    for (const pc of window.__pcs) pc.close();
    for (const a of document.querySelectorAll('audio')) { a.srcObject = null; a.remove(); }
  };
})();
</script></body></html>`;

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
const { chromium } = await loadPlaywright();
const userDir = mkdtempSync(join(tmpdir(), 'zerosys-e2e-meet-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 10000) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await sleep(100);
  return cond();
}
const popupOf = (page) => page.locator('#zerosys-copilot-popup');

let context;
try {
  context = await chromium.launchPersistentContext(userDir, {
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  await context.route('https://meet.google.com/**', (route) => {
    const u = new URL(route.request().url());
    const code = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/.exec(u.pathname)?.[1];
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: code ? FAKE_MEET('Meet - E2E 商談テスト') : FAKE_MEET('Google Meet') });
  });
  // Meet のページがマイクを使える状態（本番では Meet 参加時に許可済み）
  await context.grantPermissions(['microphone'], { origin: 'https://meet.google.com' });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  await sw.evaluate(
    async ({ port, token }) => {
      const now = Date.now();
      await chrome.storage.local.set({
        settings: {
          serverUrl: `http://127.0.0.1:${port}`,
          session: { token, tokenType: 'Bearer', issuedAt: now, expiresAt: now + 3600_000, scopes: ['session'] },
          // 事故の再現: 試験で使った OFFLINE が「前回のモード」として残っている
          lastMode: 'OFFLINE',
        },
      });
    },
    { port, token: TOKEN },
  );

  // --- 会議以外のページでは出ない
  const landing = await context.newPage();
  await landing.goto('https://meet.google.com/');
  await sleep(2500);
  check('会議コードの無いページではポップアップを出さない', (await popupOf(landing).count()) === 0);
  await landing.close();

  // --- 接続（1 タップ）
  const meet = await context.newPage();
  await meet.goto('https://meet.google.com/abc-defg-hij');
  await meet.waitForFunction(() => window.__remoteTrack === true, null, { timeout: 15000 });
  const connectBtn = meet.getByRole('button', { name: '接続', exact: true });
  await connectBtn.waitFor({ timeout: 10000 });
  check('相手の音声トラック受信（参加）でポップアップが出る', true);
  check('同意の一文を表示', (await meet.getByText('相手に説明・同意済みの場合のみ接続してください').count()) === 1);
  check('ポップアップは Shadow DOM 内', await meet.evaluate(() => !!document.getElementById('zerosys-copilot-popup')?.shadowRoot));
  check('接続前は何も接続しない', log.connections === 0 && log.frames.length === 0);

  const pagePromise = context.waitForEvent('page', { timeout: 15000 });
  await connectBtn.click();
  const copilot = await pagePromise;
  check('「接続」でカンペ画面が開く', copilot.url().endsWith('/copilot.html'), copilot.url());
  await until(() => log.starts.length === 1, 15000);
  const st = log.starts[0];
  check('確認画面を挟まずに開始（1 タップ）', !!st);
  check('タップ＝同意の確認（consentConfirmed=true・保存なし）', st?.consentConfirmed === true && st?.storage === 'memory_only');
  check('前回 OFFLINE（試験）が残っていても、API 設定済みならワンタップは LIVE（事故の再発防止）', st?.mode === 'LIVE', st?.mode);
  await copilot.getByTestId('mode-banner').waitFor({ timeout: 8000 });
  check('開始直後にモードを大きく表示（LIVE）', /LIVE/.test(await copilot.getByTestId('mode-banner').innerText()));
  check('商談目的＝会議名（入力不要）', st?.purpose === 'E2E 商談テスト', st?.purpose);
  check('自分の音声取得 ON で開始', st?.selfCaptureEnabled === true);

  await until(() => log.frames.filter((f) => f.header.source === 'REMOTE').length >= 5 && log.frames.filter((f) => f.header.source === 'SELF').length >= 5, 15000);
  const remote = log.frames.filter((f) => f.header.source === 'REMOTE');
  const self = log.frames.filter((f) => f.header.source === 'SELF');
  check('相手側（ページ内の WebRTC 受信音声）→ REMOTE フレーム', remote.length >= 5, `${remote.length} frames`);
  check('REMOTE は無音ではない（440Hz が届く）', remote.some((f) => f.peak > 1000), `max peak ${Math.max(0, ...remote.map((f) => f.peak))}`);
  check('自分（ページに許可済みのマイク）→ SELF フレーム（別系統）', self.length >= 5, `${self.length} frames`);
  const h = remote[0]?.header;
  check('16kHz/PCM16/モノラル・sequence 連番', !!h && h.sampleRate === 16000 && h.channels === 1 && h.encoding === 'pcm16le' && remote.slice(0, 3).every((f, i) => f.header.sequence === i));

  await copilot.getByText('商談目的: E2E 商談テスト').waitFor({ timeout: 10000 });
  check('カンペ画面に商談目的を表示', true);
  await copilot.getByRole('button', { name: '変更' }).click();
  await copilot.getByRole('textbox', { name: '商談目的' }).fill('A社 業務診断の結果共有');
  await copilot.getByRole('button', { name: '保存' }).click();
  await until(() => log.json.some((m) => m.type === 'session.update'));
  check('商談目的を変更 → session.update', log.json.some((m) => m.type === 'session.update' && m.purpose === 'A社 業務診断の結果共有'));

  // ================= 切れても終わらせない（画面共有・タブ／ウィンドウ切替・通信断） =================
  const remoteSince = (t0) => log.frames.filter((f) => f.header.source === 'REMOTE' && f.at > t0);
  const loudSince = (t0) => remoteSince(t0).some((f) => f.peak > 1000);
  const endsBefore = log.json.filter((m) => m.type === 'session.end').length;
  const isLiveOnScreen = async () => (await copilot.getByText(/^(LIVE|OFFLINEテスト)・/).count()) >= 1;

  // 1) 画面共有の開始: 新しい接続＋トラックの置き換え、その後に古い接続を閉じる（ended イベントなしで終わる）
  await meet.evaluate(() => window.__present());
  await meet.waitForFunction(() => window.__presentTrack === true, null, { timeout: 10000 });
  await sleep(1000);
  await meet.evaluate(() => window.__closeFirst());
  const tPresent = Date.now();
  await sleep(4500); // 拾い直し（2 秒ごと）を 2 回以上
  check('画面共有の開始（新しい接続・トラック置き換え・古い接続を閉じる）でも REMOTE が届き続ける', loudSince(tPresent + 2500), `${remoteSince(tPresent).length} frames`);
  check('画面共有の開始で商談は終わらない（session.end を送らない・WS は 1 本のまま）', log.json.filter((m) => m.type === 'session.end').length === endsBefore && log.closed === 0);

  // 2) タブ切替: Meet のタブが隠れる
  const otherTab = await context.newPage();
  await otherTab.goto('about:blank');
  await otherTab.bringToFront();
  // headless では本当には隠れないことがあるため、隠れたときのイベント（visibilitychange=hidden・blur）も発火させる
  const fireHidden = (pg) =>
    pg.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('blur'));
    });
  await fireHidden(meet);
  await fireHidden(copilot);
  const hidden = await meet.evaluate(() => document.visibilityState);
  const tTab = Date.now();
  await sleep(3000);
  check('タブ切替（Meet が隠れる）でも LIVE のまま・REMOTE/SELF が届き続ける', remoteSince(tTab).length >= 5 && log.frames.some((f) => f.header.source === 'SELF' && f.at > tTab), `visibility=${hidden}`);

  // 3) ウィンドウ切替: 別のウィンドウを前面に（カンペ画面・Meet ともにフォーカスを失う）
  const winId = await sw.evaluate(async () => (await chrome.windows.create({ url: 'about:blank', focused: true, type: 'normal' })).id);
  const tWin = Date.now();
  await sleep(3000);
  check('ウィンドウ切替（カンペ画面がフォーカスを失う）でも LIVE のまま・音声が届き続ける', remoteSince(tWin).length >= 5 && (await isLiveOnScreen()));

  // 4) カンペ画面のタイマーが止まる（隠れた・覆われたウィンドウを Chrome が間引く状態の再現）。以前は 10 秒で止まっていた
  const cdp = await context.newCDPSession(copilot);
  await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
  const tFrozen = Date.now();
  await sleep(14000);
  await cdp.send('Page.setWebLifecycleState', { state: 'active' });
  check(
    'カンペ画面が 14 秒止まっても（旧: 10 秒で heartbeat_lost）商談は続き、音声が届き続ける',
    remoteSince(tFrozen).length >= 30 && log.json.filter((m) => m.type === 'session.end').length === endsBefore,
    `${remoteSince(tFrozen).length} frames`,
  );
  await sw.evaluate(async (id) => chrome.windows.remove(id), winId);
  await otherTab.close();
  await meet.bringToFront();

  // 5) サーバーとの WS が切れる（3 秒間つながらない）→「再接続中」→ 同じ商談で再開
  refuseWs = true;
  for (const c of wss.clients) c.terminate();
  await copilot.getByText(/再接続中/).first().waitFor({ timeout: 8000 });
  check('WS が切れたらカンペ画面に「再接続中」（終了画面にしない）', (await copilot.getByText('商談の支援を終了しました').count()) === 0);
  await sleep(3000);
  refuseWs = false;
  await until(() => log.resumes.length >= 1, 20000);
  const tResume = Date.now();
  await until(() => remoteSince(tResume).length >= 5, 15000);
  check('再接続は session.resume で同じ商談（sess-meet-1）を続ける', log.resumes.every((id) => id === 'sess-meet-1') && log.starts.length === 1, log.resumes.join(','));
  check('再接続後も REMOTE が新しい世代で届く', remoteSince(tResume).length >= 5 && remoteSince(tResume)[0].header.streamGeneration > remote[0].header.streamGeneration);
  for (let i = 0; i < 50 && (await copilot.getByText(/再接続中/).count()) > 0; i++) await sleep(100);
  check('再接続後は「再接続中」が消える', (await copilot.getByText(/再接続中/).count()) === 0);

  // 6) 商談中に Meet を再読み込み → 「再接続中」→ 出てきた「接続」で同じ商談につなぎ直す（新しい商談・新しい画面にしない）
  const startsBeforeReload = log.starts.length;
  const pagesBeforeReload = context.pages().length;
  await meet.reload();
  await meet.waitForFunction(() => window.__remoteTrack === true, null, { timeout: 15000 });
  await copilot.getByText(/再接続中/).first().waitFor({ timeout: 8000 });
  await meet.getByRole('button', { name: '接続', exact: true }).click();
  const tReload = Date.now();
  await until(() => remoteSince(tReload).length >= 5, 15000);
  check(
    '商談中に Meet を再読み込みしても「接続」で同じ商談を続ける（新しい商談・画面を作らない）',
    remoteSince(tReload).length >= 5 && log.starts.length === startsBeforeReload && context.pages().length === pagesBeforeReload && remoteSince(tReload)[0].header.sessionId === 'sess-meet-1',
  );

  await copilot.getByRole('button', { name: /解析一時停止/ }).click();
  await sleep(800);
  const paused = log.frames.length;
  await sleep(1500);
  check('解析一時停止で両系統の送信が止まる', log.frames.length === paused, `${log.frames.length - paused} frames after pause`);
  check('analysis.pause を送る', log.json.some((m) => m.type === 'analysis.pause'));

  await copilot.getByRole('button', { name: /^終了/ }).click();
  await copilot.getByRole('button', { name: '終了する' }).click();
  await until(() => log.closed >= 1, 10000);
  check('終了で session.end と WS 切断', log.closed >= 1 && log.json.some((m) => m.type === 'session.end'));
  await sleep(1500);
  check('終了後はポップアップを勝手に出し直さない', (await meet.getByRole('button', { name: '接続', exact: true }).count()) === 0);
  // 終了画面のカンペウィンドウは開いたままにしておく（次の「接続」で開き直されること）

  // --- 拒否
  const conns = log.connections;
  const other = await context.newPage();
  await other.goto('https://meet.google.com/xyz-wxyz-xyz');
  const declineBtn = other.getByRole('button', { name: '拒否', exact: true });
  await declineBtn.waitFor({ timeout: 15000 });
  const pagesBefore = context.pages().length;
  await declineBtn.click();
  await sleep(1500);
  check('「拒否」でポップアップが消える', (await popupOf(other).count()) === 0);
  check('「拒否」では何も開かない・接続しない', context.pages().length === pagesBefore && log.connections === conns);
  await other.reload();
  await other.waitForFunction(() => window.__remoteTrack === true, null, { timeout: 15000 });
  await sleep(2500);
  check('同じ会議は再読み込みしても再表示しない', (await popupOf(other).count()) === 0);

  // --- 前の商談の終了画面が残っていても、別の会議の「接続」1 回で新しく始まる
  const third = await context.newPage();
  await third.goto('https://meet.google.com/qrs-tuvw-xyz');
  const again = third.getByRole('button', { name: '接続', exact: true });
  await again.waitFor({ timeout: 15000 });
  const nextPage = context.waitForEvent('page', { timeout: 15000 });
  await again.click();
  const copilot2 = await nextPage;
  await until(() => log.starts.length === 2, 15000);
  check('2 回目の商談も「接続」1 回で開始（前回モード LIVE）', log.starts[1]?.mode === 'LIVE' && log.starts[1]?.consentConfirmed === true);
  await until(() => copilot.isClosed(), 5000);
  check('前の終了画面のウィンドウは閉じて開き直す', copilot.isClosed() && !copilot2.isClosed());
  check('「接続」の前にサーバーでペアリングを確認（/auth/check）', log.authChecks >= 2, `${log.authChecks} checks`);

  // --- 通話から退出したときだけ終わる（理由 call_left をサーバーへ・終了画面に表示）
  await until(() => log.frames.some((f) => f.header.sessionId === 'sess-meet-2'), 15000);
  const endsBeforeLeave = log.json.filter((m) => m.type === 'session.end').length;
  await third.evaluate(() => window.__leave());
  await until(() => log.json.filter((m) => m.type === 'session.end').length > endsBeforeLeave, 20000);
  const leftEnd = log.json.filter((m) => m.type === 'session.end').at(-1);
  check('通話から退出 → 商談を終える（session.end の理由 call_left）', leftEnd?.reason === 'call_left', JSON.stringify(leftEnd));
  await copilot2.getByText('通話から退出したため終了しました', { exact: false }).waitFor({ timeout: 8000 });
  check('終了画面に「通話から退出したため終了しました」', true);
  const slid = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.session?.expiresAt ?? 0);
  check('サーバーが延長した期限を拡張側にも反映', slid > Date.now() + 170 * 86400_000);

  // --- ペアリング切れ: カンペ画面を開かず、1 行の直し方＋設定画面へのボタン
  const setSettings = (patch) =>
    sw.evaluate(async (p) => {
      const r = await chrome.storage.local.get('settings');
      const cur = r.settings;
      await chrome.storage.local.set({ settings: { ...cur, ...p, session: p.token ? { ...cur.session, token: p.token } : cur.session } });
    }, patch);
  await setSettings({ token: 'x'.repeat(48) });
  const startsBefore = log.starts.length;
  const exp = await context.newPage();
  await exp.goto('https://meet.google.com/exp-ired-abc');
  await exp.getByRole('button', { name: '接続', exact: true }).waitFor({ timeout: 15000 });
  const pagesBeforeExp = context.pages().length;
  await exp.getByRole('button', { name: '接続', exact: true }).click();
  await exp.getByText('ペアリングが切れました → 設定画面で再ペアリング').waitFor({ timeout: 10000 });
  check('ペアリング切れ: ポップアップに「ペアリングが切れました → 設定画面で再ペアリング」', true);
  check('ペアリング切れ: カンペ画面を開かない・開始しない', context.pages().length === pagesBeforeExp && log.starts.length === startsBefore);
  const optPage = context.waitForEvent('page', { timeout: 10000 });
  await exp.getByRole('button', { name: '設定画面で再ペアリング' }).click();
  const opened = await optPage;
  check('「設定画面で再ペアリング」で設定画面が開く（行き止まりにしない）', opened.url().includes('/options.html'), opened.url());
  await opened.getByText('ペアリングが切れました → 下のペアリングコード欄で再ペアリング').waitFor({ timeout: 10000 });
  check('設定画面にも切れたことと直し方を表示', true);
  check('設定画面にコードの出し方（pnpm pair）を表示', (await opened.getByText(/pnpm pair を実行すると表示されます/).count()) >= 1);
  await opened.close();

  // --- サーバー未起動: 直し方の 1 行
  await setSettings({ token: TOKEN, serverUrl: 'http://127.0.0.1:9' });
  const down = await context.newPage();
  await down.goto('https://meet.google.com/dwn-serv-abc');
  await down.getByRole('button', { name: '接続', exact: true }).waitFor({ timeout: 15000 });
  await down.getByRole('button', { name: '接続', exact: true }).click();
  await down.getByText(/^サーバーが起動していません → /).waitFor({ timeout: 15000 });
  check('サーバー未起動: ポップアップに「サーバーが起動していません → 直し方」', true);
  check('サーバー未起動: 「もう一度接続」で押し直せる', (await down.getByRole('button', { name: 'もう一度接続' }).count()) === 1);
} catch (e) {
  check('例外なし', false, e instanceof Error ? e.message : String(e));
} finally {
  await context?.close().catch(() => {});
  http.close();
  wss.close();
  rmSync(userDir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
