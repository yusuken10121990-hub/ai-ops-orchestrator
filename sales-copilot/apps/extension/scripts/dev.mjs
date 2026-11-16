// 開発用: 拡張機能を監視ビルド（本体 + AudioWorklet）。dist は起動時に一度だけ消す。
// `vite build --watch` を本体だけで回すと dist が空にされ capture-worklet.js が消えるため、両方をここで監視する。
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(join(root, 'dist'), { recursive: true, force: true });
const common = { root, mode: 'development', build: { emptyOutDir: false, watch: {} } };
await build({ ...common, configFile: join(root, 'vite.config.ts') });
await build({ ...common, configFile: join(root, 'vite.worklet.config.ts') });
console.log('[extension] watching… chrome://extensions で「再読み込み」すると反映されます（dist: apps/extension/dist）');
