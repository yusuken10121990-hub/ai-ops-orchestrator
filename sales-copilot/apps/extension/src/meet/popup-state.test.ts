import { describe, expect, it } from 'vitest';
import {
  initialPopupState,
  isDeclined,
  isPopupVisible,
  parseMeetingCode,
  popupReducer,
  purposeFromMeetTitle,
  rememberDeclined,
  type DecisionStore,
  type PopupEvent,
  type PopupState,
} from './popup-state';

const run = (events: PopupEvent[], s: PopupState = initialPopupState) => events.reduce(popupReducer, s);
const seen = (code: string | null, joined = true, declined = false): PopupEvent => ({ type: 'observe', code, joined, declined });

function memStore(): DecisionStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

describe('parseMeetingCode', () => {
  it('会議コードの URL だけを会議とみなす', () => {
    expect(parseMeetingCode('https://meet.google.com/abc-defg-hij')).toBe('abc-defg-hij');
    expect(parseMeetingCode('https://meet.google.com/abc-defg-hij/?authuser=0&pli=1')).toBe('abc-defg-hij');
    expect(parseMeetingCode('https://meet.google.com/')).toBeNull();
    expect(parseMeetingCode('https://meet.google.com/landing')).toBeNull();
    expect(parseMeetingCode('https://meet.google.com/new')).toBeNull();
    expect(parseMeetingCode('http://meet.google.com/abc-defg-hij')).toBeNull();
    expect(parseMeetingCode('https://evil.example/abc-defg-hij')).toBeNull();
    expect(parseMeetingCode('not a url')).toBeNull();
  });
});

describe('popupReducer（接続／拒否ポップアップ）', () => {
  it('会議ページでも参加前は出さず、参加を確認したら出す', () => {
    let s = run([seen('abc-defg-hij', false)]);
    expect(isPopupVisible(s)).toBe(false);
    s = popupReducer(s, seen('abc-defg-hij', true));
    expect(s).toEqual({ kind: 'prompt', code: 'abc-defg-hij' });
    expect(isPopupVisible(s)).toBe(true);
  });

  it('会議以外のページでは出さない', () => {
    expect(isPopupVisible(run([seen(null)]))).toBe(false);
  });

  it('接続: 接続中 → 接続済み（以後この会議では出し直さない）', () => {
    let s = run([seen('abc-defg-hij'), { type: 'connect' }]);
    expect(s.kind).toBe('connecting');
    s = popupReducer(s, { type: 'connect.ok' });
    expect(s.kind).toBe('connected');
    expect(isPopupVisible(s)).toBe(false);
    s = run([seen('abc-defg-hij'), seen('abc-defg-hij')], s);
    expect(s.kind).toBe('connected');
  });

  it('接続失敗: 理由つきで出し直し、もう一度接続できる', () => {
    let s = run([seen('abc-defg-hij'), { type: 'connect' }, { type: 'connect.fail', message: 'x' }]);
    expect(s).toEqual({ kind: 'error', code: 'abc-defg-hij', message: 'x' });
    expect(isPopupVisible(s)).toBe(true);
    s = popupReducer(s, { type: 'connect' });
    expect(s.kind).toBe('connecting');
  });

  it('拒否: 消えて、同じ会議では二度と出さない', () => {
    const s = run([seen('abc-defg-hij'), { type: 'decline' }, seen('abc-defg-hij'), seen('abc-defg-hij')]);
    expect(s.kind).toBe('declined');
    expect(isPopupVisible(s)).toBe(false);
  });

  it('×で閉じても拒否と同じ（何も取得しない・出し直さない）', () => {
    const s = run([seen('abc-defg-hij'), { type: 'dismiss' }, seen('abc-defg-hij')]);
    expect(s.kind).toBe('declined');
  });

  it('拒否済みの会議（再読み込み後）は最初から出さない', () => {
    const s = run([seen('abc-defg-hij', true, true)]);
    expect(s.kind).toBe('declined');
    expect(isPopupVisible(s)).toBe(false);
  });

  it('別の会議へ移ったら、その会議ではまた 1 回出す', () => {
    const s = run([seen('abc-defg-hij'), { type: 'decline' }, seen('xyz-wxyz-xyz')]);
    expect(s).toEqual({ kind: 'prompt', code: 'xyz-wxyz-xyz' });
  });

  it('接続後に終了したら、同じページでは勝手に出し直さない', () => {
    const s = run([seen('abc-defg-hij'), { type: 'connect' }, { type: 'connect.ok' }, { type: 'capture.ended' }, seen('abc-defg-hij')]);
    expect(s.kind).toBe('ended');
    expect(isPopupVisible(s)).toBe(false);
  });

  it('表示されていないときの接続・拒否は無視する', () => {
    expect(run([{ type: 'connect' }])).toBe(initialPopupState);
    expect(run([{ type: 'decline' }])).toBe(initialPopupState);
  });

  it('同じ観測では状態オブジェクトを変えない（再描画しない）', () => {
    const s = run([seen('abc-defg-hij')]);
    expect(popupReducer(s, seen('abc-defg-hij'))).toBe(s);
  });
});

describe('拒否の記憶（タブが開いている間）', () => {
  it('会議コードごとに覚える', () => {
    const st = memStore();
    expect(isDeclined(st, 'abc-defg-hij')).toBe(false);
    rememberDeclined(st, 'abc-defg-hij');
    expect(isDeclined(st, 'abc-defg-hij')).toBe(true);
    expect(isDeclined(st, 'xyz-wxyz-xyz')).toBe(false);
  });
  it('保存先が使えなくても例外にしない', () => {
    const broken: DecisionStore = {
      get: () => {
        throw new Error('blocked');
      },
      set: () => {
        throw new Error('blocked');
      },
    };
    expect(() => rememberDeclined(broken, 'abc-defg-hij')).not.toThrow();
    expect(isDeclined(broken, 'abc-defg-hij')).toBe(false);
  });
});

describe('purposeFromMeetTitle（商談目的の既定値）', () => {
  it('Meet のタイトルから会議名を取り出す', () => {
    expect(purposeFromMeetTitle('Meet - A社 業務診断の結果共有', 'abc-defg-hij')).toBe('A社 業務診断の結果共有');
    expect(purposeFromMeetTitle('A社 定例 - Google Meet', 'abc-defg-hij')).toBe('A社 定例');
  });
  it('会議名が無ければ会議コード入りの既定文', () => {
    expect(purposeFromMeetTitle('Meet - abc-defg-hij', 'abc-defg-hij')).toBe('Google Meet の商談（abc-defg-hij）');
    expect(purposeFromMeetTitle('Google Meet', 'abc-defg-hij')).toBe('Google Meet の商談（abc-defg-hij）');
    expect(purposeFromMeetTitle('', null)).toBe('Google Meet の商談');
  });
  it('500 文字までに切る（サーバーの上限）', () => {
    expect(purposeFromMeetTitle('あ'.repeat(800), null)).toHaveLength(500);
  });
});
