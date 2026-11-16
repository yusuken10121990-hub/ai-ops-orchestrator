// pnpm setup:first — 初回セットアップの補助。
// 1) Node のバージョン確認  2) .env が無ければ .env.example をコピー（既存の .env は絶対に上書きしない）
// 3) ビルド（拡張機能 dist）  4) 次にやることを表示
// 外部 API には接続しない。APIキーは入力させない（.env を自分で編集する）。
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, runPnpm } from './lib.mjs';

// node:sqlite がフラグなしで使えるのは Node 22.13 以降
const [major, minor] = process.versions.node.split('.').map(Number);
if (!(major > 22 || (major === 22 && minor >= 13))) {
  console.error(`Node ${process.versions.node} は古すぎます。Node 22 LTS（22.13 以上）を入れてください（https://nodejs.org/）。`);
  process.exit(1);
}
console.log(`✔ Node ${process.versions.node}`);

const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  console.log('✔ .env は既にあります（上書きしません）');
} else {
  copyFileSync(join(ROOT, '.env.example'), envPath);
  console.log('✔ .env.example から .env を作成しました（APIキーは空のままです）');
}

if (!existsSync(join(ROOT, 'node_modules'))) {
  console.log('… 依存関係をインストールします（pnpm install）');
  if ((await runPnpm(['install', '--frozen-lockfile'])) !== 0) {
    console.error('pnpm install に失敗しました。');
    process.exit(1);
  }
}

console.log('… ビルドします（pnpm build）');
if ((await runPnpm(['build'])) !== 0) {
  console.error('ビルドに失敗しました。上のエラーを確認してください。');
  process.exit(1);
}

console.log(`
✔ 準備できました。次の手順:
  1. サーバーを起動:            pnpm start
     （端末に「ペアリングコード: 123456」の形で6桁が表示されます）
  2. Chrome で chrome://extensions を開き、右上「デベロッパーモード」をON
     →「パッケージ化されていない拡張機能を読み込む」→ ${join(ROOT, 'apps', 'extension', 'dist')}
  3. 拡張機能の「オプション」を開き、6桁のコードで「ペアリング」→「マイクを許可してテスト」
  4. APIキーなしで試す: 普通の Web ページのタブで拡張アイコン → 「OFFLINEテスト」で開始（README 9章）
  5. 実際の商談で使う場合は .env に DEEPGRAM_API_KEY と ANTHROPIC_API_KEY を書いてサーバーを再起動
     （再起動したら、もう一度ペアリングが必要です）
詳しくは README.md を参照してください。
`);
