import { describe, expect, it } from 'vitest';
import { LEFT_CONFIRM_MS, LeaveDetector, RECONNECT_MAX_MS, reconnectDelay } from './link-policy';

describe('Meet ページ側: 切れても終わらせないルール', () => {
  it('つなぎ直しは 250ms から倍々・上限 4 秒。諦めるまでに 10 回以上は試す', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelay)).toEqual([250, 500, 1000, 2000, 4000, 4000, 4000]);
    let total = 0;
    let n = 0;
    while (total + reconnectDelay(n) <= RECONNECT_MAX_MS) total += reconnectDelay(n++);
    expect(n).toBeGreaterThanOrEqual(10);
  });

  it('タブを隠す・画面共有・Meet 内の画面遷移（URL が一時的に会議コードでなくなる）では退出にしない', () => {
    const d = new LeaveDetector();
    // 画面共有中も相手のトラックはある
    expect(d.observe({ now: 0, code: 'abc-defg-hij', liveCode: 'abc-defg-hij', inCall: true })).toBe('in_call');
    // URL が一時的に変わった（会議コードなし）が、通話は続いている
    expect(d.observe({ now: 1000, code: null, liveCode: 'abc-defg-hij', inCall: true })).toBe('in_call');
    // 接続の作り直しで一瞬トラックが 0 本になっても、すぐ戻れば退出にしない
    expect(d.observe({ now: 2000, code: 'abc-defg-hij', liveCode: 'abc-defg-hij', inCall: false })).toBe('maybe_left');
    expect(d.observe({ now: 2000 + LEFT_CONFIRM_MS - 1, code: 'abc-defg-hij', liveCode: 'abc-defg-hij', inCall: true })).toBe('in_call');
    expect(d.observe({ now: 30_000, code: 'abc-defg-hij', liveCode: 'abc-defg-hij', inCall: true })).toBe('in_call');
  });

  it('相手のトラックも退出ボタンも無い状態が続いたら退出', () => {
    const d = new LeaveDetector();
    expect(d.observe({ now: 0, code: 'abc-defg-hij', liveCode: 'abc-defg-hij', inCall: false })).toBe('maybe_left');
    expect(d.observe({ now: LEFT_CONFIRM_MS, code: 'abc-defg-hij', liveCode: 'abc-defg-hij', inCall: false })).toBe('left');
  });

  it('別の会議へ移ったらすぐ退出', () => {
    const d = new LeaveDetector();
    expect(d.observe({ now: 0, code: 'xyz-wxyz-xyz', liveCode: 'abc-defg-hij', inCall: true })).toBe('left');
  });
});
