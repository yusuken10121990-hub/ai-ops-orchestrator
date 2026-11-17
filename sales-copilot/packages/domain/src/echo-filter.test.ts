import { describe, expect, it } from 'vitest';
import { bigramDice, CrossChannelEchoFilter, isLikelyEcho, selfEchoSimilarity } from './echo-filter';

const t = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs });

describe('echo filter (speaker echo of REMOTE on SELF)', () => {
  it('bigram Dice is 1 for identical and 0 for disjoint text', () => {
    expect(bigramDice('ちょっと高い', 'ちょっと高い')).toBe(1);
    expect(bigramDice('ちょっと高い', 'まったく別')).toBe(0);
  });

  it('SELF that is a partial recognition of REMOTE counts as fully similar (containment)', () => {
    expect(selfEchoSimilarity('他社さんとも比較して', '他社さんとも比較してから決めたいです')).toBe(1);
    // 逆向き（本人が相手の言葉を引用して付け足した）は含有扱いしない
    expect(selfEchoSimilarity('他社さんとも比較してから決めたいということですね', '他社さんとも比較して')).toBeLessThan(1);
  });

  it('drops near-identical SELF text that overlaps or follows REMOTE within 2s', () => {
    const remote = t('ちょっと高いですね、他社さんだともう少し安かったので', 10_000, 13_000);
    expect(isLikelyEcho(t('ちょっと高いですね他社さんだともう少し安かったので', 10_200, 13_200), remote)).toBe(true);
    expect(isLikelyEcho(t('ちょっと高いですね 他社さんだと', 14_500, 15_000), remote)).toBe(true); // 終了 1.5s 後
    expect(isLikelyEcho(t('ちょっと高いですね 他社さんだと', 15_500, 16_000), remote)).toBe(false); // 2s 超
  });

  it('a paraphrase (オウム返し) after the customer finished is NOT dropped', () => {
    const remote = t('ちょっと高いですね', 10_000, 11_000);
    // 類似度は閾値付近だが、相手が話し終えた後に始まっている（実際の重なりなし）
    const self = t('ちょっと高いと感じられたんですね', 11_600, 13_000);
    expect(isLikelyEcho(self, remote)).toBe(false);
    // 似た本文が同時刻に重なっていれば回り込み
    expect(isLikelyEcho(t('ちょっと高いと感じられたんですね', 10_100, 11_000), t('ちょっと高いと感じられたんですね', 10_000, 11_000))).toBe(true);
  });

  it('short backchannels need exact text AND real time overlap', () => {
    const remote = t('はい', 5_000, 5_400);
    expect(isLikelyEcho(t('はい', 5_050, 5_450), remote)).toBe(true);
    expect(isLikelyEcho(t('はい', 6_500, 6_800), remote)).toBe(false); // 本人の相づち（後から）
    expect(isLikelyEcho(t('ええ', 5_050, 5_450), remote)).toBe(false);
    expect(isLikelyEcho(t('はい', 5_050, 5_450), t('はい、そうです', 5_000, 6_000))).toBe(false);
  });

  it('unrelated genuine SELF speech at the same time is kept', () => {
    const remote = t('今は特に困っていないんですよ', 20_000, 22_000);
    expect(isLikelyEcho(t('そうなんですね、ちなみに今の作業で手間なところは', 21_000, 24_000), remote)).toBe(false);
  });

  it('filter handles both arrival orders and counts drops', () => {
    const f = new CrossChannelEchoFilter();
    // REMOTE が先: SELF は取り込み前に捨てる
    f.recordRemote('r1', t('今回は見送りにさせてください', 1_000, 3_000));
    expect(f.shouldDropSelf(t('今回は見送りにさせてください', 1_100, 3_100))).toBe(true);
    expect(f.shouldDropSelf(t('承知しました、ありがとうございます', 4_000, 5_500))).toBe(false);
    // SELF が先に取り込まれていた: 後から来た REMOTE が一致 ID を返す
    f.recordSelf('s2', t('他社さんとも比較してから決めたい', 30_000, 32_000));
    f.recordSelf('s3', t('ありがとうございます', 33_000, 34_000));
    expect(f.recordRemote('r2', t('他社さんとも比較してから決めたいです', 29_900, 32_100))).toEqual(['s2']);
    expect(f.droppedCount).toBe(2);
  });

  it('forgets old utterances (no comparison beyond the retention window)', () => {
    const f = new CrossChannelEchoFilter({ retainMs: 5_000 });
    f.recordRemote('r1', t('ちょっと高いですね', 0, 1_000));
    f.recordRemote('r2', t('別の話題です', 20_000, 21_000));
    expect(f.shouldDropSelf(t('ちょっと高いですね', 20_500, 21_500))).toBe(false);
  });
});
