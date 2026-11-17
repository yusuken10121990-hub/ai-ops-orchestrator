import { describe, expect, it } from 'vitest';
import { base64ToPcm, parseToOffscreenPort, pcmToBase64 } from './wire';

describe('PCM16 の base64 往復（content script → offscreen）', () => {
  it('値と長さが変わらない（負数・端の値・奇数長を含む）', () => {
    for (const n of [0, 1, 2, 3, 320, 641]) {
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = ((i * 7919) % 65536) - 32768;
      if (n > 1) {
        pcm[0] = 32767;
        pcm[1] = -32768;
      }
      const back = base64ToPcm(pcmToBase64(pcm));
      expect(back).not.toBeNull();
      expect(Array.from(back!)).toEqual(Array.from(pcm));
    }
  });
  it('リトルエンディアンの標準 base64（Node の Buffer と一致）', () => {
    const pcm = Int16Array.from([1, -2, 300, -32768, 32767]);
    expect(pcmToBase64(pcm)).toBe(Buffer.from(pcm.buffer).toString('base64'));
  });
  it('不正な文字列は null（音声として扱わない）', () => {
    expect(base64ToPcm('abc')).toBeNull();
    expect(base64ToPcm('ab$=')).toBeNull();
    expect(base64ToPcm('AA==')).toBeNull(); // 2 バイト単位にならない（1 バイト）
  });
});

describe('parseToOffscreenPort', () => {
  it('形の正しいものだけ通す', () => {
    expect(parseToOffscreenPort({ type: 'pcm', source: 'REMOTE', b64: 'AAA=', levelDb: -20 })).toMatchObject({ type: 'pcm' });
    expect(parseToOffscreenPort({ type: 'pcm', source: 'OTHER', b64: '', levelDb: 0 })).toBeNull();
    expect(parseToOffscreenPort({ type: 'pcm', source: 'SELF', b64: 'x'.repeat(70_000), levelDb: 0 })).toBeNull();
    expect(parseToOffscreenPort({ type: 'self.error', name: 'NotAllowedError' })).toEqual({ type: 'self.error', name: 'NotAllowedError' });
    expect(parseToOffscreenPort({ type: 'transcript', text: 'x' })).toBeNull();
    expect(parseToOffscreenPort(null)).toBeNull();
  });
});
