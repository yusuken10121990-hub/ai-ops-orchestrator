import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// MV3 拡張のマルチエントリビルド（@crxjs は使わず、静的 manifest を public/ からコピー）。
// AudioWorklet は vite.worklet.config.ts で単一ファイルとして別ビルドする。
const root = __dirname;

export default defineConfig({
  root,
  base: '/',
  plugins: [react()],
  publicDir: resolve(root, 'public'),
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: false,
    minify: false,
    modulePreload: false,
    rollupOptions: {
      input: {
        copilot: resolve(root, 'copilot.html'),
        options: resolve(root, 'options.html'),
        offscreen: resolve(root, 'offscreen.html'),
        'service-worker': resolve(root, 'src/background/service-worker.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'service-worker' ? 'service-worker.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
