/**
 * Meet ポップアップの「接続」1 タップで開いたカンペ画面の自動開始判断（純粋関数）。
 * - タップ自体が「商談相手への説明・同意」（開始前画面の②）の確認。
 * - モードは前回使ったもの。ただし LIVE はサーバーで文字起こし・助言生成の両方が設定済みのときだけ。
 *   使えなければ OFFLINE テスト。どちらも使えなければ開始しない（開始前画面で直し方を出す）。
 * - 商談目的は会議名を既定値にして開始を止めない（商談中に変更できる）。
 */
import type { ConfigStatusResponse, SessionMode } from '@sales-copilot/contracts';
import type { LocalSourceState } from '../shared/runtime-messages';

export type ModeConfig = Pick<ConfigStatusResponse, 'modes' | 'stt' | 'llm'>;

export function chooseAutoMode(last: SessionMode | null, cfg: ModeConfig): SessionMode | null {
  const liveOk = cfg.modes.LIVE && cfg.stt.configured && cfg.llm.configured;
  if (last === 'OFFLINE' && cfg.modes.OFFLINE) return 'OFFLINE';
  if (liveOk) return 'LIVE';
  return cfg.modes.OFFLINE ? 'OFFLINE' : null;
}

/** 会議側の音声がページ内取得でつながるのを待つ上限。 */
export const AUTO_START_REMOTE_WAIT_MS = 10_000;

export interface AutoStartInput {
  paired: boolean;
  health: 'checking' | 'ok' | 'ng';
  config: ModeConfig | null;
  /** /config/status を取得できなかった理由（取得中なら null）。 */
  configError: string | null;
  lastMode: SessionMode | null;
  remote: LocalSourceState;
  /** 「接続」からの経過時間。 */
  elapsedMs: number;
}

export type AutoStartDecision =
  | { kind: 'wait' }
  | { kind: 'start'; mode: SessionMode }
  /** 自動では開始しない。message は「何が足りないか＋どう直すか」。 */
  | { kind: 'fail'; message: string };

export function decideAutoStart(i: AutoStartInput): AutoStartDecision {
  if (!i.paired) return { kind: 'fail', message: 'ペアリングがまだです。下の「設定画面」でペアリングしてから「開始の確認へ」を押してください。' };
  if (i.health === 'checking') return { kind: 'wait' };
  if (i.health === 'ng')
    return { kind: 'fail', message: 'ローカルサーバーにつながりません。PCでサーバーを起動（pnpm start）してから「再確認」→「開始の確認へ」を押してください。' };
  if (!i.config) {
    if (i.configError) return { kind: 'fail', message: `サーバーの設定状態を確認できません（${i.configError}）。「再確認」を押してください。` };
    return { kind: 'wait' };
  }
  const mode = chooseAutoMode(i.lastMode, i.config);
  if (!mode) return { kind: 'fail', message: 'LIVE も OFFLINE テストも使えない設定です。サーバーの APIキー設定を確認してください。' };
  if (mode === 'LIVE' && i.remote !== 'armed') {
    if (i.elapsedMs < AUTO_START_REMOTE_WAIT_MS && i.remote === 'off') return { kind: 'wait' };
    return {
      kind: 'fail',
      message: '会議の音声につながりませんでした。Meet のページを再読み込みしてポップアップの「接続」をもう一度押すか、会議タブで拡張アイコンを押してください。',
    };
  }
  return { kind: 'start', mode };
}
