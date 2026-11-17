import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Meet ページに入れるスクリプト（manifest の content_scripts）は ES モジュールにできないため、
// import を含まない単一ファイル（IIFE）として 1 本ずつビルドする。
//   vite build -c vite.content.config.ts --mode meet-content  → dist/meet-content.js（隔離 world: ポップアップ）
//   vite build -c vite.content.config.ts --mode meet-page     → dist/meet-page.js（MAIN world: 音声取得）
const root = __dirname;
const ENTRIES: Record<string, string> = {
  'meet-content': 'src/meet/content-main.ts',
  'meet-page': 'src/meet/page-main.ts',
};

export default defineConfig(({ mode }) => {
  const entry = ENTRIES[mode];
  if (!entry) throw new Error(`vite.content.config.ts: unknown mode ${mode} (use ${Object.keys(ENTRIES).join(' / ')})`);
  return {
    root,
    publicDir: false,
    build: {
      outDir: resolve(root, 'dist'),
      emptyOutDir: false,
      target: 'chrome116',
      minify: false,
      lib: {
        entry: resolve(root, entry),
        formats: ['iife'],
        name: mode.replace(/-/g, '_'),
        fileName: () => `${mode}.js`,
      },
    },
  };
});
