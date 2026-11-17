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
const log = { connections: 0, starts: [], frames: [], json: [], closed: 0 };

const http = createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/health') return send(200, { ok: true });
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
  pc1.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
  const offer = await pc1.createOffer();
  await pc1.setLocalDescription(offer);
  await pc2.setRemoteDescription(offer);
  const answer = await pc2.createAnswer();
  await pc2.setLocalDescription(answer);
  await pc1.setRemoteDescription(answer);
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
  check('初回は API 設定済みなので LIVE', st?.mode === 'LIVE', st?.mode);
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
