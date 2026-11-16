import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// AudioWorklet プロセッサーは import を含まない単一ファイルにする（addModule で読み込む）。
const root = __dirname;

export default defineConfig({
  root,
  publicDir: false,
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: false,
    target: 'chrome116',
    minify: false,
    lib: {
      entry: resolve(root, 'src/audio/worklet/capture-processor.ts'),
      formats: ['es'],
      fileName: () => 'capture-worklet.js',
    },
  },
});
