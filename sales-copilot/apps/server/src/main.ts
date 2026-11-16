import path from 'node:path';
import type { CaptureSource } from '@sales-copilot/contracts';
import { AnthropicAdviceLlm, DeepgramStreamingRecognizer } from '@sales-copilot/providers';
import { buildApp, type AppHandle } from './app';
import { coachingBinding } from './coaching-binding';
import { assertBindAllowed, loadConfig, type ServerConfig } from './config';
import { createLogger } from './logger';
import { listOfflineScripts, loadReplay } from './offline-scripts';
import { Store } from './store';

export { loadReplay } from './offline-scripts';

/**
 * 起動: 設定読込 → bind 先の検査 → アプリ構築 → listen → ペアリングコードを TTY にだけ表示。
 * 起動時に外部 API（有料）へは一切接続しない（STT/LLM はセッション開始＋音声/発話があって初めて使う）。
 */
export async function startServer(config: ServerConfig = loadConfig()): Promise<AppHandle & { close: () => Promise<void> }> {
  assertBindAllowed(config);
  const logger = createLogger({ level: config.logLevel });
  const store = new Store(path.join(config.dataDir, 'sales-copilot.sqlite'));
  const liveLlm = config.anthropic.apiKey
    ? new AnthropicAdviceLlm({
        apiKey: config.anthropic.apiKey,
        model: config.anthropic.model,
        effort: config.anthropic.effort,
        timeoutMs: config.advice.timeoutMs,
      })
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
    loadReplay,
    listOfflineScripts,
  });
  await handle.app.listen({ host: config.host, port: config.port });
  const addr = handle.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  handle.setPort(port);
  logger.info(
    { host: config.host, port, stt: Boolean(config.deepgram.apiKey), llm: Boolean(config.anthropic.apiKey) },
    'server listening',
  );

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
    logger.warn('stdout is not a TTY: pairing code is not displayed. Start the server in a terminal to pair.');
  }

  return {
    ...handle,
    close: async () => {
      await handle.app.close();
      store.close();
    },
  };
}
