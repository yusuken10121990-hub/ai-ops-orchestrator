// Playwright スモーク: ビルド済み拡張を Chromium（new headless）に読み込み、
// モックのローカルサーバー（HTTP + WS）に対して（実サーバーとの結合はルートの scripts/e2e-integration.mjs） copilot 画面から OFFLINE で開始し、
// - hello がトークンを最初のメッセージで送る（URL クエリに載らない）
// - session.start に明示同意が入る
// - 偽マイク（--use-fake-device-for-media-stream）→ offscreen の AudioWorklet → 16kHz PCM16 フレームが届く
// - advice.card が描画され、XSS 文字列がテキストとして出る
// - 表示固定ショートカットで card.pin が届く
// - 画面を閉じるとハートビート切れで session.end と WS 切断が起きる
// を確認する。tabCapture（拡張アイコンのクリック）は自動化できないため対象外（docs/manual-checklist.md）。
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

const TOKEN = 'e'.repeat(48);
const XSS = '<img src=x onerror="document.title=\'pwned\'">次回、月額の前提を確認させてください。';
const log = { hello: null, start: null, frames: [], json: [], closed: false, upgradeUrl: null, authHeaders: [] };

const http = createServer((req, res) => {
  log.authHeaders.push(req.headers.authorization ?? null);
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/health') return send(200, { ok: true });
  // 形は @sales-copilot/contracts の ConfigStatusResponse / FactsListResponse / OfflineScriptsResponse と同じ
  if (req.url === '/config/status')
    return send(200, {
      version: 'mock',
      protocolVersion: 1,
      stt: { configured: false, provider: 'deepgram', model: 'nova-3', language: 'ja' },
      llm: { configured: false, provider: 'anthropic', model: 'mock' },
      modes: { LIVE: false, OFFLINE: true },
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
http.on('upgrade', (req, socket, head) => {
  log.upgradeUrl = req.url;
  log.origin = req.headers.origin;
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});
wss.on('connection', (ws) => {
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const b = Buffer.from(data);
      const hlen = b.readUInt32LE(0);
      const header = JSON.parse(b.subarray(4, 4 + hlen).toString('utf8'));
      log.frames.push({ header, pcmBytes: b.length - 4 - hlen });
      return;
    }
    const m = JSON.parse(String(data));
    log.json.push(m);
    if (m.type === 'hello') {
      log.hello = m;
      if (m.token !== TOKEN) return ws.close(1008);
      ws.send(JSON.stringify({ type: 'hello.ack', protocolVersion: 1, serverVersion: 'mock' }));
    }
    if (m.type === 'session.start') {
      log.start = m;
      const now = Date.now();
      const st = { state: 'active', reason: null, since: now };
      ws.send(
        JSON.stringify({
          type: 'status',
          sessionId: 'sess-e2e',
          lifecycle: 'capturing',
          mode: 'OFFLINE',
          externalSending: false,
          storage: 'memory_only',
          pipelines: { capture: { SELF: st, REMOTE: { state: 'idle', reason: null, since: now } }, stt: st, advice: { state: 'waiting', reason: 'cooldown', since: now } },
          at: now,
        }),
      );
      setTimeout(() => {
        ws.send(
          JSON.stringify({
            type: 'advice.card',
            card: {
              action: 'show',
              kind: 'clarify',
              headline: '月額の前提を確認',
              say: XSS,
              avoid: '金額の断定',
              briefReason: '価格が未承認',
              evidenceUtteranceIds: [],
              approvedFactIds: [],
              missingItems: ['月額の承認'],
              evidenceLevel: 'tentative',
              nextStepType: 'clarify',
              adviceId: 'adv-1',
              sessionId: 'sess-e2e',
              contextRevision: 1,
              promptVersion: 'mock',
              createdAt: Date.now(),
              expiresAt: Date.now() + 600_000,
              trigger: 'auto',
              status: 'current',
              warnings: [],
            },
          }),
        );
      }, 300);
    }
  });
  ws.on('close', () => (log.closed = true));
});
await new Promise((r) => http.listen(0, '127.0.0.1', r));
const port = http.address().port;

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
const { chromium } = await loadPlaywright();
const userDir = mkdtempSync(join(tmpdir(), 'zerosys-e2e-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
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
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  check('service worker 起動', !!extId, extId);
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

  const page = await context.newPage();
  // マイク許可（拡張の可視ページで先に許可する運用の再現。fake-ui で自動許可）
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.getByRole('button', { name: /マイクを(許可して)?テスト/ }).click();
  await page.getByText('許可済み').waitFor({ timeout: 10000 });
  check('設定画面でマイク許可', true);

  await page.goto(`chrome-extension://${extId}/copilot.html`);
  await page.getByText('接続OK').waitFor({ timeout: 10000 });
  check('API設定状態の表示（API未設定を区別）', (await page.getByText(/文字起こし（deepgram \/ nova-3 \/ ja）: API未設定/).count()) === 1);
  check('LIVE 不可の理由を表示', (await page.getByText(/LIVE: 利用できません/).count()) === 1);
  await page.getByLabel('商談目的（任意）').fill('E2E 動作確認');
  await page.getByText('OFFLINEテスト（APIキー不要').click();
  await page.getByText('① ブラウザのマイク許可').click();
  await page.getByText('② 商談相手への説明・同意').click();
  await page.getByRole('button', { name: '開始の確認へ' }).click();
  await page.getByRole('button', { name: '開始する' }).click();
  await page.locator('.say').waitFor({ timeout: 15000 });
  const sayText = await page.locator('.say').textContent();
  check('advice.card を描画', sayText === XSS);
  check('XSS: img 要素が生成されない', (await page.locator('.card img').count()) === 0);
  check('XSS: スクリプト未実行', (await page.title()) !== 'pwned');
  check('hello はトークンを最初のメッセージで送る', log.json[0]?.type === 'hello' && log.hello?.token === TOKEN);
  check('WS URL にトークンが無い', log.upgradeUrl === '/ws', String(log.upgradeUrl));
  check('WS Origin は拡張機能', log.origin === `chrome-extension://${extId}`, String(log.origin));
  check('HTTP は Authorization ヘッダーで認証', log.authHeaders.includes(`Bearer ${TOKEN}`));
  check('session.start に明示同意', log.start?.consentConfirmed === true && log.start?.mode === 'OFFLINE');

  await page.waitForTimeout(1500);
  const self = log.frames.filter((f) => f.header.source === 'SELF');
  const h = self[0]?.header;
  check('偽マイク → worklet → SELF フレーム受信', self.length >= 3, `${self.length} frames`);
  check(
    'フレームは 16kHz/PCM16/モノラル・200ms・バイト長一致',
    !!h && h.sampleRate === 16000 && h.channels === 1 && h.encoding === 'pcm16le' && h.durationMs === 200 && self[0].pcmBytes === 6400,
    JSON.stringify(h),
  );
  check(
    'sequence 連番・audioStartMs 連続',
    self.slice(0, 3).every((f, i) => f.header.sequence === i && Math.abs(f.header.audioStartMs - (h.audioStartMs + i * 200)) < 0.01),
  );
  const levelText = await page.evaluate(() => document.body.textContent);
  check('状態バー OFFLINE 表示', levelText.includes('OFFLINEテスト'));

  await page.keyboard.press('p');
  await page.waitForTimeout(300);
  check('表示固定ショートカット → card.pin', log.json.some((m) => m.type === 'card.pin' && m.adviceId === 'adv-1'));
  check('表示固定中ラベル', (await page.getByText('表示固定中').count()) > 0);

  await page.keyboard.press('m');
  await page.waitForTimeout(500);
  check('自分の音声取得OFF → source.state SELF off', log.json.some((m) => m.type === 'source.state' && m.source === 'SELF' && m.state === 'off' && m.reason === 'self_capture_off'));
  const before = log.frames.filter((f) => f.header.source === 'SELF').length;
  await page.waitForTimeout(800);
  check('OFF 後は SELF フレームが止まる', log.frames.filter((f) => f.header.source === 'SELF').length === before);

  // 画面を閉じる → ハートビート切れ（10秒）で offscreen が停止
  await page.close();
  const t0 = Date.now();
  while (!log.closed && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 250));
  check('画面が消えたら session.end と WS 切断', log.closed && log.json.some((m) => m.type === 'session.end'), `${Date.now() - t0}ms`);
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
