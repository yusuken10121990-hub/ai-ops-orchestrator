// サーバーと補助スクリプト（pnpm pair / autostart）が共有する「本人用データフォルダ」の決め方。
// apps/server/src/config.ts の userDataDirFor と同じ規則（テストで一致を確認している）。
import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_DIR_NAME = 'ZEROSYS-SalesCopilot';
export const LOCAL_ADMIN_FILE = 'local-admin.json';

/** USER_DATA_DIR があればそれ。無ければ OS ごとの本人用フォルダ。 */
export function userDataDirFor(env = process.env, platform = process.platform, home = homedir()) {
  const v = env.USER_DATA_DIR?.trim();
  if (v) return v;
  if (platform === 'win32') return join(env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local'), APP_DIR_NAME);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR_NAME);
  return join(env.XDG_STATE_HOME?.trim() || join(home, '.local', 'state'), APP_DIR_NAME);
}
