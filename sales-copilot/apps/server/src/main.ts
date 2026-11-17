import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { CaptureSource } from '@sales-copilot/contracts';
import { AnthropicAdviceLlm, DeepgramStreamingRecognizer } from '@sales-copilot/providers';
import { buildApp, type AppHandle } from './app';
import { coachingBinding } from './coaching-binding';
import { assertBindAllowed, loadConfig, LOCAL_ADMIN_FILE, type ServerConfig } from './config';
import { createLogger, RollingFileStream } from './logger';
import { listOfflineScripts, loadReplay } from './offline-scripts';
import { Store } from './store';
import { FileTokenStore, writeFileAtomicPrivate } from './token-store';

export { loadReplay } from './offline-scripts';

/**
 * 起動: 設定読込 → bind 先の検査 → ペアリング記録の読込 → アプリ構築 → listen
 * → pnpm pair 用の秘密を本人だけが読めるファイルへ → ペアリングコードを TTY にだけ表示。
 * 起動時に外部 API（有料）へは一切接続しない（STT/LLM はセッション開始＋音声/発話があって初めて使う）。
 */
export async function startServer(config: ServerConfig = loadConfig()): Promise<AppHandle & { close: () => Promise<void> }> {
  assertBindAllowed(config);
  const logStream = config.logFile ? new RollingFileStream(config.logFile) : undefined;
  const logger = createLogger({ level: config.logLevel, destination: logStream });
  if (config.legacyTokenTtlIgnored) {
    logger.warn('SESSION_TOKEN_TTL_MS in .env is no longer used (pairing now lasts SESSION_TOKEN_TTL_DAYS, default 180 days, extended on use)');
  }
  const tokenStore = new FileTokenStore(config.tokenStoreFile);
  // 起動ごとに作り直す秘密（pnpm pair 用）。メモリと本人だけが読めるファイルにだけ置く
  const localAdminSecret = randomBytes(32).toString('base64url');
  const store = new Store(path.join(config.dataDir, 'sales-copilot.sqlite'));
  const liveLlm = config.anthropic.apiKey
    ? new AnthropicAdviceLlm({
        apiKey: config.anthropic.apiKey,
        model: config.anthropic.model,
        effort: config.anthropic.effort,
        timeoutMs: config.advice.timeoutMs,
      })
    : null;
  // 手動ボタン（切り返し・次に聞く・次の約束・クロージング）用。押したときだけ呼ぶので、遅延より質を優先したモデル・長めの上限
  const manualLlm = config.anthropic.apiKey
    ? config.anthropic.manualModel === config.anthropic.model
      ? liveLlm
      : new AnthropicAdviceLlm({
          apiKey: config.anthropic.apiKey,
          model: config.anthropic.manualModel,
          effort: config.anthropic.effort,
          timeoutMs: config.advice.manualTimeoutMs,
        })
    : null;
  // 改善案づくり（options 画面のボタンを押したときだけ）。同じキー・同じモデル、長めのタイムアウト。
  const proposalLlm = config.anthropic.apiKey
    ? new AnthropicAdviceLlm({ apiKey: config.anthropic.apiKey, model: config.anthropic.model, effort: 'low', timeoutMs: 40_000 })
    : null;
  const createLiveRecognizer = (source: CaptureSource) =>
    config.deepgram.apiKey
      ? new DeepgramStreamingRecognizer({
          source,
          apiKey: config.deepgram.apiKey,
          model: config.deepgram.model,
          language: config.deepgram.language,
          endpointingMs: config.deepgram.endpointingMs,
          utteranceEndMs: config.deepgram.utteranceEndMs,
          smartFormat: config.deepgram.smartFormat,
          punctuate: config.deepgram.punctuate,
          maxQueueMs: config.maxAudioQueueMs,
        })
      : null;

  const handle = await buildApp({
    config,
    logger,
    store,
    coaching: coachingBinding,
    createLiveRecognizer,
    liveLlm,
    manualLlm,
    proposalLlm,
    loadReplay,
    listOfflineScripts,
    tokenStore,
    localAdminSecret,
  });
  logger.info({ pairedTokens: handle.auth.tokenCount, storeIssue: tokenStore.lastLoadIssue }, 'pairing store loaded');
  await handle.app.listen({ host: config.host, port: config.port });
  const addr = handle.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  handle.setPort(port);
  logger.info(
    { host: config.host, port, stt: Boolean(config.deepgram.apiKey), llm: Boolean(config.anthropic.apiKey) },
    'server listening',
  );

  const adminFile = path.join(config.userDataDir, LOCAL_ADMIN_FILE);
  try {
    writeFileAtomicPrivate(adminFile, JSON.stringify({ host: config.host, port, pid: process.pid, secret: localAdminSecret }) + '\n');
  } catch (e) {
    logger.error({ err: e }, 'could not write local admin file (pnpm pair will not work)');
  }
  const removeAdminFile = () => {
    try {
      // 別の起動が上書きしていたら消さない
      const cur = JSON.parse(readFileSync(adminFile, 'utf8')) as { secret?: string };
      if (cur.secret === localAdminSecret) rmSync(adminFile, { force: true });
    } catch {
      /* 無い・読めない */
    }
  };

  const code = handle.auth.issuePairingCode(config.pairingCodeForTest);
  if (config.pairingCodeForTest) {
    // 自動テスト（NODE_ENV=test）専用。コード自体はログに出さない
    logger.warn('test pairing code is active (NODE_ENV=test only)');
  } else if (process.stdout.isTTY) {
    // ログ（ファイル/パイプ）ではなく端末にだけ表示する
    process.stdout.write(
      `\n  ZEROSYS Sales Copilot  http://${config.host}:${port}\n  ペアリングコード: ${code}  （${Math.round(config.pairingCodeTtlMs / 60000)}分有効・1回限り）\n\n`,
    );
  } else {
    logger.info('stdout is not a TTY: pairing code is not displayed. To pair, run "pnpm pair" in the sales-copilot folder.');
  }

  return {
    ...handle,
    close: async () => {
      await handle.app.close();
      store.close();
      removeAdminFile();
      logStream?.end();
    },
  };
}
