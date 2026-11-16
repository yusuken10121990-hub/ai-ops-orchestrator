import type { OfflineScriptInfo } from '@sales-copilot/contracts';
import { listReplayScripts, loadReplayScript } from '@sales-copilot/test-fixtures';
import type { ReplayScript } from './replay';

/** OFFLINE 再生スクリプトを読む。name=null なら先頭（名前順）。存在しなければ例外。 */
export function loadReplay(name: string | null): ReplayScript {
  const names = listReplayScripts();
  const pick = name ?? names[0];
  if (!pick) throw new Error('no replay scripts available');
  if (!names.includes(pick)) throw new Error('unknown replay script');
  return loadReplayScript(pick);
}

/** GET /offline/scripts 用の一覧（本文は含めない: タイトル・説明・長さだけ）。 */
export function listOfflineScripts(): OfflineScriptInfo[] {
  return listReplayScripts().map((id) => {
    const s = loadReplayScript(id);
    return { id, title: s.title, description: s.description, durationMs: s.durationMs };
  });
}
