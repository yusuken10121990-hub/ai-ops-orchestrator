import { defineConfig } from 'vitest/config';

// ルートで全ワークスペースのテストを実行する。
// 拡張機能など DOM 環境が必要なテストは、ファイル先頭の `// @vitest-environment jsdom` で個別に指定する。
export default defineConfig({
  test: {
    include: ['apps/*/src/**/*.test.ts', 'apps/*/src/**/*.test.tsx', 'apps/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    // CI と通常テストは実APIを呼ばない（SPEC §15）。実APIテストは別コマンド・明示許可でのみ。
    passWithNoTests: false,
  },
});
