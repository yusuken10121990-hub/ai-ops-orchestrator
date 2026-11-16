/** 比較用の正規化（空白・句読点の揺れを吸収）。 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\s、。，．,.!！?？…・「」『』（）()ー〜~]/g, '')
    .toLowerCase();
}

/**
 * 相づち・短い反応だけの発話（SPEC §8-1: 「はい」「なるほど」ごとに LLM を呼ばない）。
 * 生成のトリガーにも、実行中生成の中止理由にもしない。
 */
const BACKCHANNEL_TOKENS = [
  'はい',
  'はいはい',
  'ええ',
  'えー',
  'ええと',
  'えっと',
  'うん',
  'うんうん',
  'なるほど',
  'なるほどですね',
  'そうですね',
  'そうですか',
  'そうなんですね',
  'そうなんですか',
  'たしかに',
  '確かに',
  'ですね',
  'ですよね',
  'あー',
  'あ',
  'へえ',
  'へー',
  'ほう',
  'おお',
  '了解です',
  'わかりました',
  '分かりました',
  'ありがとうございます',
  'はいわかりました',
  'はい分かりました',
];
const BACKCHANNEL_SET = new Set(BACKCHANNEL_TOKENS.map(normalizeText));

export function isBackchannel(text: string): boolean {
  const n = normalizeText(text);
  if (n.length === 0) return true;
  if (BACKCHANNEL_SET.has(n)) return true;
  // 「はいはいなるほど」のような相づちの連結
  let rest = n;
  const tokens = [...BACKCHANNEL_SET].sort((a, b) => b.length - a.length);
  while (rest.length > 0) {
    const t = tokens.find((tok) => tok.length > 0 && rest.startsWith(tok));
    if (!t) return false;
    rest = rest.slice(t.length);
  }
  return true;
}

/** 質問らしさ（句点・語尾ベースの簡易判定。最終判断は LLM/会話状態で行う）。 */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  return /[?？]$/.test(t) || /(ですか|ますか|でしょうか|ませんか|のか|かな|んですか|か)[。]?$/.test(t);
}

/** 否定・訂正・見送りの手がかり（前提が変わる可能性が高い発話）。 */
export function looksLikeCorrectionOrNegation(text: string): boolean {
  return /(ません|ないです|じゃない|ではない|ではなく|じゃなく|違い|ちがい|いや|やめ|見送|結構です|不要|必要ない|難しい)/.test(text);
}
