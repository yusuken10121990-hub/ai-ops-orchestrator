/**
 * ペアリングとサーバー起動の事前確認（Meet ポップアップ・設定画面・カンペ画面で同じ文言を使う）。
 * 行き止まりにしない: どの表示も「何が起きたか → どうすれば直るか」を 1 行で出す。
 */
import type { SessionToken } from '@sales-copilot/contracts';
import type { ApiClient } from './api';

export const PAIRING_EXPIRED_LINE = 'ペアリングが切れました → 設定画面で再ペアリング';
export const NOT_PAIRED_LINE = 'まだペアリングしていません → 設定画面でペアリング';
export const SERVER_DOWN_LINE = 'サーバーが起動していません → PCを再起動（自動起動を入れている場合）か、sales-copilot フォルダで pnpm start';
/** 設定画面へのボタンの文言。 */
export const REPAIR_BUTTON_LABEL = '設定画面で再ペアリング';
/** 設定画面のコード欄の説明。 */
export const PAIRING_CODE_HELP = 'sales-copilot フォルダで pnpm pair を実行すると表示されます（数字6桁・10分・一度限り）';

export type PairingCheck =
  | { kind: 'ok'; expiresAt: number }
  | { kind: 'not_paired' }
  | { kind: 'pairing_expired' }
  | { kind: 'server_down' }
  /** サーバーは応答したが確認できなかった（推測で通さない・止めない。開いた先の画面で詳しく出す）。 */
  | { kind: 'unknown' };

/** サーバーの起動 → トークンの有効性、の順に確かめる。 */
export async function checkPairing(api: Pick<ApiClient, 'health' | 'authCheck'>, session: SessionToken | null): Promise<PairingCheck> {
  const h = await api.health();
  if (!h.ok && h.error.kind === 'network') return { kind: 'server_down' };
  if (!session) return { kind: 'not_paired' };
  const r = await api.authCheck();
  if (r.ok) return { kind: 'ok', expiresAt: r.data.expiresAt };
  if (r.error.kind === 'unauthorized') return { kind: 'pairing_expired' };
  if (r.error.kind === 'network') return { kind: 'server_down' };
  return { kind: 'unknown' };
}

export type PairingProblem = 'not_paired' | 'pairing_expired' | 'server_down';

export function pairingProblemLine(p: PairingProblem): string {
  return p === 'server_down' ? SERVER_DOWN_LINE : p === 'not_paired' ? NOT_PAIRED_LINE : PAIRING_EXPIRED_LINE;
}
