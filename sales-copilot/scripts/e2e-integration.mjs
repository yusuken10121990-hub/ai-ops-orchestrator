// 実サーバー × 実拡張機能の結合テスト（ブラウザ自動化・OFFLINE・APIキー不要）。
//
// 1. 実サーバー（apps/server, tsx）を一時データディレクトリ・空の API キー・NODE_ENV=test で起動し、
//    PAIRING_CODE_FOR_TEST でペアリングコードを固定する（NODE_ENV=test 以外では起動拒否される）。
// 2. ビルド済み拡張機能（apps/extension/dist）を Chromium（--headless=new + --load-extension）に読み込む。
// 3. 設定画面でサーバーURL・ペアリング・マイク許可 → copilot 画面から OFFLINE セッションを開始し、確認する:
//    文字起こしが届く / 検証済みカード（今の一手・次に言う一言）が出る / 手動ボタン3つが応答（または「確認が先」）を返す /
//    表示報告（advice.displayed）がサーバーの遅延統計に入る / 解析一時停止で文字起こしが止まる /
//    終了で session.ended を受け取り、出力を頼まなければ何も書かない / 頼めばファイルを書く /
//    サーバーログに会話本文・顧客名・商談目的・トークン・ペアリングコードが出ない。
//    学習（承認制）: カードを「ずれた」と評価 → 設定画面に件数と「データ不足」が出る / 本文・顧客名は保存されない /
//    改善案の承認（危ないルール文は理由と直し方を表示して拒否）→ 次のセッションのカードに版が記録される。
//    改善案づくり自体はモデル呼び出しが要るので、ここでは承認待ちの案を DB に直接置いて代用する。
// tabCapture（拡張アイコンのクリック）と実 Meet は自動化できないため対象外（docs/manual-checklist.md）。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXT_DIR, ROOT, SERVER_DIR, tsxCli } from './lib.mjs';

const DIST = join(EXT_DIR, 'dist');
if (!existsSync(join(DIST, 'manifest.json'))) {
  console.error('apps/extension/dist がありません。先に pnpm build（または pnpm test:e2e）を実行してください。');
  process.exit(1);
}

async function loadPlaywright() {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
  try {
    return await import('playwright');
  } catch {
    try {
      return createRequire('/opt/node-tools/node_modules/')('playwright');
    } catch {
      console.error('playwright が見つかりません（npm i -g playwright && npx playwright install chromium）。');
      process.exit(1);
    }
  }
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(150);
  }
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------- server
const work = mkdtempSync(join(tmpdir(), 'zerosys-int-'));
const dataDir = join(work, 'data');
const exportDir = join(work, 'exports');
const userDir = join(work, 'chrome');
const port = await freePort();
const pairingCode = String(100000 + Math.floor(Math.random() * 900000));
const PURPOSE = '結合テスト用の架空の業務診断ミーティング';
const CUSTOMER = '架空結合商事 試験花子';
const SCRIPT_1 = 'demo-next-step';
const SCRIPT_2 = 'decline-respect';

const serverEnv = {
  ...process.env,
  NODE_ENV: 'test',
  PAIRING_CODE_FOR_TEST: pairingCode,
  HOST: '127.0.0.1',
  PORT: String(port),
  DATA_DIR: dataDir,
  EXPORT_DIR: exportDir,
  // ペアリング記録・pnpm pair 用の秘密は一時フォルダへ（本物の %LOCALAPPDATA% 等に書かない）
  USER_DATA_DIR: join(work, 'user'),
  LOG_FILE: '',
  // 実 API は使わない（.env にキーがあっても上書きで空にする。loadEnvFile は既存の値を上書きしない）
  DEEPGRAM_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  OFFLINE_USE_ANTHROPIC: '',
  OFFLINE_SCRIPT: SCRIPT_1,
  OFFLINE_REPLAY_SPEED: '3',
  ADVICE_COOLDOWN_MS: '1500',
  ADVICE_MANUAL_MIN_INTERVAL_MS: '300',
  LOG_LEVEL: 'debug',
};
const serverLog = [];
const server = spawn(process.execPath, [tsxCli(), 'src/index.ts'], { cwd: SERVER_DIR, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (d) => serverLog.push(d.toString('utf8')));
server.stderr.on('data', (d) => serverLog.push(d.toString('utf8')));
let serverExited = null;
server.on('exit', (code, sig) => (serverExited = { code, sig }));

const base = `http://127.0.0.1:${port}`;
let context;
let token = null;
let extId = null;
try {
  await until(async () => {
    if (serverExited) throw new Error(`server exited early: ${serverLog.join('').slice(-800)}`);
    try {
      return (await fetch(`${base}/health`)).ok;
    } catch {
      return false;
    }
  }, 30000, 'server /health');
  check('実サーバー起動（127.0.0.1・APIキーなし）', true, base);

  // ---------------------------------------------------------------- browser
  const { chromium } = await loadPlaywright();
  context = await chromium.launchPersistentContext(userDir, {
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  extId = new URL(sw.url()).host;
  check('拡張機能（service worker）起動', !!extId, extId);

  // 設定画面: サーバーURL → ペアリング → マイク許可
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.getByLabel('サーバーURL').fill(base);
  await opt.locator('#url').locator('xpath=..').getByRole('button', { name: '保存' }).click();
  await opt.getByText('保存しました').waitFor({ timeout: 5000 });
  await opt.getByLabel(/ペアリングコード/).fill('000000');
  await opt.getByRole('button', { name: 'ペアリング', exact: true }).click();
  await opt.getByText(/コードが違います/).waitFor({ timeout: 5000 });
  check('誤ったペアリングコードは拒否', true);
  await opt.getByLabel(/ペアリングコード/).fill(pairingCode);
  await opt.getByRole('button', { name: 'ペアリング', exact: true }).click();
  await opt.getByText('ペアリングしました').waitFor({ timeout: 5000 });
  check('設定画面でペアリング（実サーバー）', true);
  await opt.getByRole('button', { name: /マイクを(許可して)?テスト/ }).click();
  await opt.getByText('許可済み').first().waitFor({ timeout: 10000 });
  check('設定画面でマイク許可', true);
  await opt.close();

  token = await sw.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.session?.token ?? null);
  check('トークンは拡張機能の storage にだけ保存', typeof token === 'string' && token.length >= 32);
  const authed = { origin: `chrome-extension://${extId}`, authorization: `Bearer ${token}` };

  // ---------------------------------------------------------------- session 1
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/copilot.html`);
  await page.getByText('接続OK').waitFor({ timeout: 10000 });
  await page.getByText(/ペアリング: 済み/).waitFor({ timeout: 10000 });
  check('開始前: API未設定を表示（実サーバーの /config/status）', (await page.getByText(/文字起こし（deepgram \/ nova-3 \/ ja）: API未設定/).count()) === 1);
  check('開始前: LIVE 不可の理由を表示', (await page.getByText(/LIVE: 利用できません/).count()) === 1);
  await page.getByLabel('商談目的（必須）').fill(PURPOSE);
  await page.getByLabel('顧客名（任意）').fill(CUSTOMER);
  await page.getByText('OFFLINEテスト（APIキー不要').click();
  const scriptSelect = page.getByLabel('再生する架空会話');
  await scriptSelect.waitFor({ timeout: 5000 });
  const optionValues = await scriptSelect.locator('option').evaluateAll((os) => os.map((o) => o.value));
  check('OFFLINE 台本の一覧（GET /offline/scripts）', optionValues.includes(SCRIPT_1) && optionValues.includes(SCRIPT_2), optionValues.join(','));
  await scriptSelect.selectOption(SCRIPT_1);
  await page.getByText('① ブラウザのマイク許可').click();
  await page.getByText('② 商談相手への説明・同意').click();
  await page.getByRole('button', { name: '開始の確認へ' }).click();
  await page.getByText('OFFLINEテストを開始します（外部送信なし）').waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: '開始する' }).click();

  const segCount = async () => {
    const t = await page.locator('details.transcript > summary').textContent().catch(() => null);
    const m = t && /（(\d+)件）/.exec(t);
    return m ? Number(m[1]) : 0;
  };
  await until(async () => (await segCount()) >= 2, 20000, 'transcript segments');
  check('文字起こしが届く（OFFLINE 再生 → 実サーバー → 画面）', true, `${await segCount()} segments`);
  await page.locator('details.transcript > summary').click();
  const firstFinal = JSON.parse(readFileSync(join(ROOT, 'packages/test-fixtures/data/replay', `${SCRIPT_1}.json`), 'utf8')).lines.find((l) => l.isFinal).text;
  check('選んだ台本の発言が表示される', (await page.locator('details.transcript').textContent()).includes(firstFinal));

  const sessionId = await until(async () => {
    const r = await fetch(`${base}/sessions/active/latency`, { headers: authed });
    const j = await r.json();
    return j.sessions?.[0]?.sessionId ?? null;
  }, 5000, 'active session');

  const card = page.locator('section.card[data-advice-id]');
  await until(async () => (await card.count()) > 0 && (await card.locator('.say').count()) > 0, 30000, 'advice card with say');
  const headline = (await card.locator('.headline').textContent())?.trim();
  const say = (await card.locator('.say').textContent())?.trim();
  check('検証済みカードを表示（今の一手・次に言う一言）', !!headline && !!say && headline !== '待機', `${headline} / ${say}`);
  check('カードに【次に言う一言】ラベル', (await page.getByText('【次に言う一言】').count()) > 0);

  // 表示報告（advice.displayed）がサーバーの遅延統計に入る
  const acked = await until(async () => {
    const j = await (await fetch(`${base}/sessions/active/latency`, { headers: authed })).json();
    const c = j.sessions?.[0]?.latency?.counts;
    return c && c.displayAcked > 0 ? c : null;
  }, 8000, 'displayAcked').catch(() => null);
  check('advice.displayed → サーバーが表示ステップを記録', !!acked, acked ? `displayed=${acked.displayed} displayAcked=${acked.displayAcked}` : '');

  // 手動ボタン（切り返し / 次に聞く / 次の約束）
  const TRIG = { 切り返し: '切り返し（手動）', 次に聞く: '次に聞く（手動）', 次の約束: '次の約束（手動）' };
  for (const [button, label] of Object.entries(TRIG)) {
    const before = await card.getAttribute('data-advice-id');
    const errBefore = await page.locator('.notice.error').count();
    await page.getByRole('toolbar', { name: '操作' }).getByRole('button', { name: new RegExp(`^${button}`) }).click();
    const outcome = await until(async () => {
      const id = await card.getAttribute('data-advice-id').catch(() => null);
      if (id && id !== before && (await card.textContent()).includes(label)) return { kind: 'card', text: (await card.locator('.headline').textContent())?.trim() };
      if ((await page.locator('.notice.error').count()) > errBefore) return { kind: 'error', text: await page.locator('.notice.error').last().textContent() };
      return null;
    }, 10000, `manual ${button}`).catch(() => null);
    const clarifyFirst = outcome?.kind === 'card' && /確認が先/.test(outcome.text ?? '');
    check(
      `手動ボタン「${button}」→ 応答カード${button === '次の約束' ? '（未解決があれば「確認が先」）' : ''}`,
      outcome?.kind === 'card',
      outcome ? `${outcome.kind}: ${outcome.text}${clarifyFirst ? '（確認を優先）' : ''}` : 'no response',
    );
    await sleep(400);
  }

  // 学習: 今のカードを「ずれた」と評価（カンペ画面のボタン）
  await page.getByRole('toolbar', { name: '操作' }).getByRole('button', { name: /^ずれた/ }).click();
  await page.getByText('「ずれた」を送りました').waitFor({ timeout: 5000 });
  check('カンペ画面で「ずれた」を送れる', true);

  // 解析一時停止 → 文字起こしが増えない
  await page.getByRole('toolbar', { name: '操作' }).getByRole('button', { name: /^解析一時停止/ }).click();
  await page.getByRole('toolbar', { name: '操作' }).getByRole('button', { name: /^解析再開/ }).waitFor({ timeout: 5000 });
  await sleep(500);
  const atPause = await segCount();
  await sleep(4000);
  const afterPause = await segCount();
  check('解析一時停止で文字起こしが止まる', afterPause === atPause, `${atPause} → ${afterPause}（4秒・再生3倍速）`);

  // 終了（出力なし）
  await page.getByRole('toolbar', { name: '操作' }).getByRole('button', { name: /^終了/ }).click();
  await page.getByRole('button', { name: '終了する' }).click();
  await page.getByTestId('server-ended').waitFor({ timeout: 10000 });
  check('終了 → session.ended を受信（終了画面に表示）', true);
  check('出力を頼まなければ「何も保存していません」', (await page.getByTestId('no-export').count()) === 1);
  check('出力を頼まなければ exports/ に何も書かない', !existsSync(exportDir) || readdirSync(exportDir).length === 0);
  const review = await (await fetch(`${base}/sessions/${sessionId}/review`, { headers: authed })).json();
  check(
    '振り返り API（フォールバック）: 出力なし・表示報告の統計あり',
    review.exportPath === null && review.latency?.counts?.displayAcked >= 1,
    `displayAcked=${review.latency?.counts?.displayAcked} sentToDisplayed p50=${review.latency?.sentToDisplayedMs?.p50}ms`,
  );
  const active = await (await fetch(`${base}/sessions/active/latency`, { headers: authed })).json();
  check('終了後はサーバー側に実行中セッションが無い（取得・処理の停止）', Array.isArray(active.sessions) && active.sessions.length === 0);
  await page.close();

  // ---------------------------------------------------------------- 学習（承認制）
  {
    const dbFile = join(dataDir, 'sales-copilot.sqlite');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile);
    const rows = db.prepare('SELECT * FROM feedback').all();
    const dump = JSON.stringify(rows);
    check(
      '評価の記録: カードの文面・場面・商談目的あり／顧客名・会話本文なし',
      rows.length === 1 && rows[0].rating === 'off' && !!rows[0].headline && rows[0].rules_version === 0 &&
        !dump.includes('架空結合商事') && !dump.includes('試験花子') && !dump.includes(firstFinal.slice(0, 8)),
      rows[0] ? `headline=${rows[0].headline} purpose=${rows[0].purpose}` : 'no rows',
    );
    // 改善案（モデル出力の代わり）を承認待ちとして置く
    const now = Date.now();
    db.prepare("INSERT INTO rule_proposals (proposal_id, rule, reason, scope, status, created_at, decided_at) VALUES (?, ?, ?, ?, 'pending', ?, NULL)").run(
      'prop_e2e_1', '価格を聞かれたら即答せず、規模を1つ質問してから概算の幅を伝える', '#1 ずれた', 'answer', now,
    );
    db.close();

    const lp = await context.newPage();
    await lp.goto(`chrome-extension://${extId}/options.html`);
    const sec = lp.locator('section', { has: lp.getByRole('heading', { name: '学習（承認制）' }) });
    await sec.getByText('使える評価 1件').waitFor({ timeout: 10000 });
    check('設定画面: 学習欄に評価の件数', true);
    check('設定画面: n<10 は「データ不足」', (await sec.getByText(/データ不足（1件/).count()) === 1);
    check('設定画面: 文面保存は既定ON', await sec.getByLabel('学習のために評価したカンペの文面を保存する').isChecked());
    await sec.getByRole('button', { name: '改善案を作る' }).click();
    await sec.getByText(/評価が3件以上必要です（今1件）/).or(sec.getByText(/AIのキーが未設定です/)).waitFor({ timeout: 5000 });
    check('改善案づくり: 足りない／未設定なら理由と直し方を表示（外部送信なし）', true);
    await sec.getByRole('button', { name: '編集して承認' }).click();
    await sec.getByLabel(/^ルール/).fill('月額は3万円と伝える');
    await sec.getByRole('button', { name: 'この内容で承認' }).click();
    await sec.getByText(/金額・期間・割合などの数字はルールに入れられません/).waitFor({ timeout: 5000 });
    check('金額入りのルールは承認できず、直し方を表示', true);
    await sec.getByLabel(/^ルール/).fill('価格を聞かれたら規模を聞いてから幅で伝える');
    await sec.getByRole('button', { name: 'この内容で承認' }).click();
    await sec.getByText(/承認しました（版1）/).waitFor({ timeout: 5000 });
    check('編集して承認 → 版1・使用中', (await sec.getByText('使用中').count()) === 1, (await sec.locator('table').first().textContent())?.slice(0, 80));
    await lp.setViewportSize({ width: 360, height: 900 });
    const overflow = await lp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('設定画面: 幅360で横にはみ出さない', overflow <= 0, `${overflow}px`);
    if (process.env.E2E_SHOT_DIR) {
      for (const w of [360, 800, 1280]) {
        await lp.setViewportSize({ width: w, height: 900 });
        await sec.screenshot({ path: join(process.env.E2E_SHOT_DIR, `learning-${w}.png`) });
      }
    }
    await lp.close();
  }

  // ---------------------------------------------------------------- session 2（出力あり・自分の音声OFF・別台本）
  // 終了直後にすぐ再開始する（前回の offscreen の遅延クローズで新しい取得が切られない回帰確認を兼ねる）
  const page2 = await context.newPage();
  await page2.goto(`chrome-extension://${extId}/copilot.html`);
  await page2.getByText('接続OK').waitFor({ timeout: 10000 });
  await page2.getByLabel('商談目的（必須）').fill(PURPOSE);
  await page2.getByText('自分の音声を取得する').click();
  await page2.getByText('OFFLINEテスト（APIキー不要').click();
  await page2.getByLabel('再生する架空会話').selectOption(SCRIPT_2);
  await page2.getByText('② 商談相手への説明・同意').click();
  await page2.getByRole('button', { name: '開始の確認へ' }).click();
  await page2.getByRole('button', { name: '開始する' }).click();
  await until(async () => {
    const t = await page2.locator('details.transcript > summary').textContent().catch(() => '');
    const m = /（(\d+)件）/.exec(t ?? '');
    return m && Number(m[1]) >= 2;
  }, 20000, 'session 2 segments');
  await page2.getByRole('toolbar', { name: '操作' }).getByRole('button', { name: /^終了/ }).click();
  await page2.getByText('振り返りをこのPCのファイルへ出力する').click();
  await page2.getByRole('button', { name: '終了する' }).click();
  await page2.getByTestId('export-path').waitFor({ timeout: 10000 });
  const shownPath = (await page2.getByTestId('export-path').textContent())?.trim() ?? '';
  const files = existsSync(exportDir) ? readdirSync(exportDir) : [];
  const json = files.find((f) => f.endsWith('.json'));
  check('出力を頼むと exports/ に JSON と Markdown を書き、パスを表示', !!json && files.some((f) => f.endsWith('.md')) && shownPath.endsWith(json ?? '???'), shownPath);
  if (json) {
    const e = JSON.parse(readFileSync(join(exportDir, json), 'utf8'));
    check('出力内容: 台本の確定発言・使用量（LLM 0回）・自分の音声OFF', e.transcript.length >= 1 && e.usage.calls === 0 && e.transcript.every((u) => u.source !== 'SELF'), `${e.transcript.length} utterances`);
    check('次のセッションのカードに承認済みルールの版（rulesVersion=1）', e.advice.length === 0 || e.advice.every((c) => c.rulesVersion === 1), `${e.advice.length} cards`);
  }
  await page2.close();
} catch (e) {
  check('例外なし', false, e instanceof Error ? e.message : String(e));
  if (process.env.E2E_DEBUG) for (const p of context?.pages() ?? []) console.log('[page]', p.url(), (await p.evaluate(() => document.body.innerText).catch((e) => 'ERR ' + e.message)).slice(0, 3000));
} finally {
  await context?.close().catch(() => {});
  if (!serverExited) {
    server.kill('SIGTERM');
    await until(async () => serverExited, 8000, 'server exit').catch(() => server.kill('SIGKILL'));
  }
}

// ---------------------------------------------------------------- server log audit
const log = serverLog.join('');
check('サーバーログが出ている', log.includes('session started') && log.includes('session ended'), `${log.split('\n').length} lines`);
const leaks = [];
for (const s of [PURPOSE, CUSTOMER, '架空結合商事', '試験花子']) if (log.includes(s)) leaks.push(s);
if (new RegExp(`\\b${pairingCode}\\b`).test(log)) leaks.push('pairing code');
for (const name of [SCRIPT_1, SCRIPT_2]) {
  const script = JSON.parse(readFileSync(join(ROOT, 'packages/test-fixtures/data/replay', `${name}.json`), 'utf8'));
  for (const l of script.lines) {
    for (let i = 0; i + 8 <= l.text.length; i += 4) {
      const frag = l.text.slice(i, i + 8);
      if (log.includes(frag)) leaks.push(`transcript fragment「${frag}」`);
    }
  }
}
check('サーバーログに会話本文・顧客名・商談目的・ペアリングコードが無い', leaks.length === 0, leaks.slice(0, 5).join(' / '));
check('サーバーログにトークン・API キー名の値が無い', !/"token"\s*:\s*"[A-Za-z0-9_-]{20,}"|Bearer [A-Za-z0-9_-]{20,}|sk-ant-/.test(log));
check('サーバーが致命的エラーなく終了', serverExited && (serverExited.code === 0 || serverExited.sig === 'SIGTERM'), JSON.stringify(serverExited));
if (process.env.E2E_DUMP_LOG) console.log(log);

// ---------------------------------------------------------------- restart: ペアリングが残る・pnpm pair
{
  const env2 = { ...serverEnv };
  delete env2.PAIRING_CODE_FOR_TEST; // 2 回目の起動はテスト用の固定コードを使わない（pnpm pair の経路を確かめる）
  const log2 = [];
  const s2 = spawn(process.execPath, [tsxCli(), 'src/index.ts'], { cwd: SERVER_DIR, env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
  s2.stdout.on('data', (d) => log2.push(d.toString('utf8')));
  s2.stderr.on('data', (d) => log2.push(d.toString('utf8')));
  let exited2 = null;
  s2.on('exit', (code, sig) => (exited2 = { code, sig }));
  try {
    await until(async () => {
      if (exited2) throw new Error(`server(2) exited early: ${log2.join('').slice(-800)}`);
      try {
        return (await fetch(`${base}/health`)).ok;
      } catch {
        return false;
      }
    }, 30000, 'server(2) /health');
    const tokensFile = join(work, 'user', 'tokens.json');
    const stored = existsSync(tokensFile) ? readFileSync(tokensFile, 'utf8') : '';
    check('ペアリング記録を本人用フォルダに保存（平文トークンは含まない）', stored.includes('"hash"') && !!token && !stored.includes(token));
    const r = await fetch(`${base}/auth/check`, { headers: { authorization: `Bearer ${token}` } });
    const body = r.ok ? await r.json() : null;
    check('サーバー再起動後も同じトークンで認証できる（再ペアリング不要）', r.status === 200 && body?.expiresAt > Date.now() + 170 * 86400_000, `HTTP ${r.status}`);
    const facts = await fetch(`${base}/facts`, { headers: { origin: `chrome-extension://${extId}`, authorization: `Bearer ${token}` } });
    check('再起動後も拡張機能の Origin を許可（ペアリング済みとして復元）', facts.status === 200, `HTTP ${facts.status}`);
    const bad = await fetch(`${base}/auth/check`, { headers: { authorization: `Bearer ${'z'.repeat(43)}` } });
    check('知らないトークンは再起動後も拒否', bad.status === 401);

    const pairOut = await new Promise((resolve) => {
      const c = spawn(process.execPath, [join(ROOT, 'scripts', 'pair.mjs')], { cwd: ROOT, env: env2, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (out += d));
      c.on('exit', (code) => resolve({ code, out }));
    });
    const code2 = /ペアリングコード: (\d{6})/.exec(pairOut.out)?.[1];
    check('pnpm pair: 動いているサーバーから新しいコードを表示', pairOut.code === 0 && !!code2, pairOut.out.trim().split('\n')[0]);
    if (code2) {
      const pr = await fetch(`${base}/pair`, {
        method: 'POST',
        headers: { origin: `chrome-extension://${extId}`, 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode: code2, extensionId: extId, clientName: 'e2e' }),
      });
      check('pnpm pair のコードでペアリングできる', pr.status === 200, `HTTP ${pr.status}`);
      check('pnpm pair のコードはサーバーログに出ない', !log2.join('').includes(code2));
    }
    check('pnpm pair 用の秘密はログに出ない', !/"secret"\s*:\s*"[A-Za-z0-9_-]{20,}"/.test(log2.join('')));
  } catch (e) {
    check('再起動の確認で例外なし', false, e instanceof Error ? e.message : String(e));
  } finally {
    if (!exited2) {
      s2.kill('SIGTERM');
      await until(async () => exited2, 8000, 'server(2) exit').catch(() => s2.kill('SIGKILL'));
    }
  }
  check('サーバー終了で pnpm pair 用の秘密ファイルを消す', !existsSync(join(work, 'user', 'local-admin.json')));
}

rmSync(work, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
