import { describe, expect, it } from 'vitest';
import { AUTO_START_REMOTE_WAIT_MS, chooseAutoMode, decideAutoStart, type AutoStartInput, type ModeConfig } from './auto-start';

const cfg = (live: boolean, stt = live, llm = live): ModeConfig => ({
  modes: { LIVE: live, OFFLINE: true },
  stt: { configured: stt, provider: 'deepgram', model: 'nova-3', language: 'ja' },
  llm: { configured: llm, provider: 'anthropic', model: 'm' },
});

describe('chooseAutoMode（前回のモード／API設定）', () => {
  it('前回 LIVE で文字起こし・助言生成が設定済みなら LIVE', () => {
    expect(chooseAutoMode('LIVE', cfg(true))).toBe('LIVE');
  });
  it('初回（前回なし）も設定済みなら LIVE', () => {
    expect(chooseAutoMode(null, cfg(true))).toBe('LIVE');
  });
  it('API 未設定なら OFFLINE（前回 LIVE でも）', () => {
    expect(chooseAutoMode('LIVE', cfg(false))).toBe('OFFLINE');
    expect(chooseAutoMode(null, cfg(true, true, false))).toBe('OFFLINE');
  });
  it('前回 OFFLINE なら OFFLINE のまま', () => {
    expect(chooseAutoMode('OFFLINE', cfg(true))).toBe('OFFLINE');
  });
  it('どちらも使えなければ null', () => {
    expect(chooseAutoMode(null, { ...cfg(false), modes: { LIVE: false, OFFLINE: false } })).toBeNull();
  });
});

const base: AutoStartInput = {
  paired: true,
  health: 'ok',
  config: cfg(true),
  configError: null,
  lastMode: 'LIVE',
  remote: 'armed',
  elapsedMs: 500,
};

describe('decideAutoStart', () => {
  it('条件がそろえば確認画面なしで開始', () => {
    expect(decideAutoStart(base)).toEqual({ kind: 'start', mode: 'LIVE' });
  });
  it('サーバー確認中・設定取得中・会議音声の接続待ちは待つ', () => {
    expect(decideAutoStart({ ...base, health: 'checking' }).kind).toBe('wait');
    expect(decideAutoStart({ ...base, config: null }).kind).toBe('wait');
    expect(decideAutoStart({ ...base, remote: 'off' }).kind).toBe('wait');
  });
  it('会議音声が待っても来なければ、直し方つきで止まる', () => {
    const d = decideAutoStart({ ...base, remote: 'off', elapsedMs: AUTO_START_REMOTE_WAIT_MS + 1 });
    expect(d.kind).toBe('fail');
    if (d.kind === 'fail') expect(d.message).toMatch(/接続」をもう一度|拡張アイコン/);
    expect(decideAutoStart({ ...base, remote: 'error' }).kind).toBe('fail');
  });
  it('OFFLINE は会議音声を待たない', () => {
    expect(decideAutoStart({ ...base, config: cfg(false), remote: 'off' })).toEqual({ kind: 'start', mode: 'OFFLINE' });
  });
  it('未ペアリング・サーバー停止・設定取得失敗は、何をすればよいかを返す', () => {
    const a = decideAutoStart({ ...base, paired: false });
    const b = decideAutoStart({ ...base, health: 'ng' });
    const c = decideAutoStart({ ...base, config: null, configError: '認証エラー' });
    for (const d of [a, b, c]) expect(d.kind).toBe('fail');
    if (a.kind === 'fail') expect(a.message).toMatch(/設定画面/);
    if (b.kind === 'fail') expect(b.message).toMatch(/サーバーを起動/);
    if (c.kind === 'fail') expect(c.message).toMatch(/再確認/);
  });
});
