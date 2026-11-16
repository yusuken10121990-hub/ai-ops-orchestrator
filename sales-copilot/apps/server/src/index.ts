import { loadConfig, loadDotEnv } from './config';
import { startServer } from './main';

loadDotEnv();

startServer(loadConfig()).then(
  (h) => {
    const shutdown = () => {
      void h.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  },
  (e: unknown) => {
    // 設定エラー等。値（キー）を含めない
    process.stderr.write(`failed to start: ${e instanceof Error ? e.message : 'unknown error'}\n`);
    process.exit(1);
  },
);
