/**
 * 表示前検証・自動契機・メモ抽出で共有する、決定論的な日本語テキスト規則。
 * LLM に任せず、コードで数値と条件の出所を確かめるための部品（SPEC §12）。
 */

const KANJI_DIGITS: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const KANJI_POS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };

export function parseKanjiNumber(s: string): number | null {
  let total = 0;
  let cur = -1;
  for (const ch of s) {
    if (ch in KANJI_DIGITS) {
      cur = KANJI_DIGITS[ch]!;
    } else if (ch in KANJI_POS) {
      total += (cur < 0 ? 1 : cur) * KANJI_POS[ch]!;
      cur = -1;
    } else {
      return null;
    }
  }
  if (cur >= 0) total += cur;
  return total;
}

/** 全角→半角（NFKC）と、数字間のカンマ除去。 */
export function normalizeForRules(text: string): string {
  return text.normalize('NFKC').replace(/(\d),(?=\d{3})/g, '$1');
}

export type NumericCategory = 'money' | 'usd' | 'pct' | 'year' | 'month' | 'week' | 'day' | 'hour' | 'min' | 'count' | 'large';

export interface NumericExpr {
  /** 正規化した比較キー（例 money:30000 / month:12）。 */
  key: string;
  category: NumericCategory;
  value: number;
  /** 元の表記（正規化後）。 */
  raw: string;
  kanji: boolean;
}

const NUM_RE =
  /(\d+(?:\.\d+)?|[〇零一二三四五六七八九十百千]+)\s*(万|億)?\s*(円|ドル|%|パーセント|割|年間|年|ヶ月|か月|カ月|ヵ月|ケ月|箇月|週間|営業日|日間|日|時間|分|人|名|件|社|台|回)?/g;

const UNIT_CATEGORY: Record<string, NumericCategory> = {
  円: 'money',
  ドル: 'usd',
  '%': 'pct',
  パーセント: 'pct',
  割: 'pct',
  年間: 'year',
  年: 'year',
  ヶ月: 'month',
  か月: 'month',
  カ月: 'month',
  ヵ月: 'month',
  ケ月: 'month',
  箇月: 'month',
  週間: 'week',
  営業日: 'day',
  日間: 'day',
  日: 'day',
  時間: 'hour',
  分: 'min',
  人: 'count',
  名: 'count',
  件: 'count',
  社: 'count',
  台: 'count',
  回: 'count',
};

/**
 * 金額・割合・期間・日数・時間・人数/件数の数値表現を抜き出す。
 * - 単位も「万/億」も無い裸の数字は対象外（「2つ」「3点」など）
 * - 漢数字は金額・割合・期間系のみ対象（「一件」「一人」「一緒」は対象外）
 */
export function extractNumericExprs(text: string): NumericExpr[] {
  const t = normalizeForRules(text);
  const out: NumericExpr[] = [];
  for (const m of t.matchAll(NUM_RE)) {
    const [raw, numStr, mult, unit] = m;
    if (!numStr) continue;
    const kanji = !/^\d/.test(numStr);
    if (!mult && !unit) continue;
    let value = kanji ? parseKanjiNumber(numStr) : Number(numStr);
    if (value === null || Number.isNaN(value)) continue;
    if (mult === '万') value *= 10_000;
    if (mult === '億') value *= 100_000_000;
    let category: NumericCategory = unit ? UNIT_CATEGORY[unit]! : 'large';
    if (kanji && category === 'count') continue;
    // 「十分（じゅうぶん）」を10分と誤読しない
    if (kanji && unit === '分') continue;
    // 「1件で確認」「1回」などの検証単位は約束ではない
    if (category === 'count' && value === 1) continue;
    if (unit === '割') value *= 10;
    let key: string;
    if (category === 'count') key = `count:${unit}:${value}`;
    else if (category === 'large') {
      // 「3万」だけ → 金額とみなす
      category = 'money';
      key = `money:${value}`;
    } else key = `${category}:${value}`;
    out.push({ key, category, value, raw: raw.trim(), kanji });
  }
  return out;
}

/** 出所照合用のキー集合（年↔月の換算も含める）。 */
export function numericKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const n of extractNumericExprs(text)) {
    keys.add(n.key);
    if (n.category === 'year') keys.add(`month:${n.value * 12}`);
    if (n.category === 'month' && n.value % 12 === 0) keys.add(`year:${n.value / 12}`);
    if (n.category === 'week') keys.add(`day:${n.value * 7}`);
  }
  return keys;
}

// ---- 保証・断言 ----

const GUARANTEE_PATTERNS: RegExp[] = [
  /絶対(?!とは|では|じゃ|に?ない)/,
  /必ず(?!しも)/,
  /(全部|全て|すべて|何でも|なんでも)(対応)?(でき|可能)/,
  /保証(します|いたします|できます|です|しております|しています)/,
  /いつでも(解約|やめ|辞め|止め|退会)/,
  /誰も損(し|は|を)/,
  /損はさせ/,
  /(漏洩|漏えい|流出)(しません|はしません|はありません|することはありません|の心配はありません|しない)/,
  /漏れ(ません|ることはありません)/,
  /確実に/,
  /間違いなく/,
  /100\s*(%|パーセント)|百パーセント/,
  /リスクは(ありません|ゼロ|ない)/,
  /失敗(しません|はありません|することはありません)/,
  /無制限/,
];

export function findGuarantee(text: string): boolean {
  const t = normalizeForRules(text);
  return GUARANTEE_PATTERNS.some((re) => re.test(t));
}

export const FREE_RE = /無料|タダ|ただで|0円|ゼロ円|費用はかかりません|お金はかかりません/;

/** 値引き・特別価格の約束（承認済み条件に無ければ出さない）。 */
export const DISCOUNT_RE = /値引|割引|値下げ|特別価格|特別料金|お安く|安くし(ます|ておき|てお)|安くでき|勉強させ|キャンペーン価格|サービスします/;

/**
 * 「30分ほどお時間をいただけますか」のような、打ち合わせの長さの依頼（60分以下）。
 * 価格・期間・効果の約束ではないので、次の約束・クロージングの台詞では数値の出所検査から外す。
 */
export function isMeetingDurationRequest(text: string, raw: string): boolean {
  const t = normalizeForRules(text);
  const m = raw.match(/^(\d{1,2})\s*分$/);
  if (!m || Number(m[1]) > 60 || Number(m[1]) <= 0) return false;
  const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${esc}(ほど|程度|だけ|くらい|ぐらい)?(の)?(お時間|時間を|ほど時間|お打ち合わせ|打ち合わせ|ミーティング|面談|オンライン|いただ|頂)`).test(t);
}

export const REDUCTION_RE = /削減|減らせ|減らし|減ります|減る|短縮|浮きます|浮く|ゼロに|なくせ|なくなります|半分に|半減|節約/;

export const CAPABILITY_RE =
  /(判断|読み取|読取|認識|処理|対応|連携|自動化|実現|解析|判定|抽出|識別|計測)(も|は)?(でき|可能)(ます|です)(?!か)/;
export const ACCURACY_CLAIM_RE = /精度(は|が|も)?[^。？?]{0,12}(出ます|出せます|高い|高く|問題(あり|ない)|大丈夫|十分)/;
export const FEASIBILITY_TOPIC_RE = /精度|データ|3D|3d|図面|形式|判断|読み取|認識|連携|できますか|可能ですか|対応できますか|いけますか/;

/** 二者択一を迫る（自社更新の質問に内製か外注かを迫る）。 */
export function findForcedBinary(text: string): boolean {
  const t = normalizeForRules(text);
  const asks = /どちら|どっち|二択|それとも/.test(t);
  const inhouse = /内製|自社で|自分たち|御社で|御社内|社内で/.test(t);
  const outsource = /外注|丸投げ|うちに|弊社に|ZEROSYSに|任せ|お任せ/.test(t);
  return asks && inhouse && outsource;
}

export const DECLINE_RE =
  /今回は(やめ|見送|結構|遠慮)|見送(ります|らせ|り)|やめておきます|やめます|結構です|連絡(は|も)?(不要|いらない|要らない|大丈夫です|しないで|結構)|困っていません|困ってない|必要ありません|必要ないです|検討しません|お断り/;

export const STRONG_INTENT_RE = /契約|発注|申し込|申込|導入したい|導入します|進めたい|進めましょう|進めてください|お願いしたい|お願いします|決めました|手続き/;

export const WEAK_POSITIVE_RE = /便利そう|いいですね|良いですね|よさそう|良さそう|なるほど|面白い|おもしろい|すごい|興味/;

export const CONTRACT_PUSH_RE = /ご契約|契約(の|を|手続|書)|お申し込み|申込書|発注書|ご発注|手続き/;

export const CONTACT_PUSH_RE = /日程|ご予定|予定を|次回|改めてご連絡|お電話|お打ち合わせ|ミーティング|デモ/;

export const CANCELLATION_CLAIM_RE =
  /いつでも(やめ|解約|辞め|止め)|(解約|やめ|辞め)[^。]{0,8}いつでも|縛り(は|が|も)?(ない|無い|なし|ありません)|最低(契約)?期間(は|が|も)?(ない|無い|なし|ありません)|違約金(は|が|も)?(ない|無い|なし|かからない)|(前に|以前|前回)[^。]{0,20}(聞いた|言われ|伺った)/;
export const CANCELLATION_TOPIC_RE = /解約|やめられ|辞められ|契約期間|縛り|最低期間|違約金/;
export const RESTRICTIVE_TERM_RE = /最低|年|ヶ月|か月|カ月|違約|残|不可|できません|一括|支払/;

export const PER_PERSON_RE = /(1|一|１)人(あたり|当たり|当り)|ひとり(あたり|当たり)|1名(あたり|当たり)/;
export const COMPANY_WIDE_RE = /全社|会社全体|全体で|全員|合計|トータル/;
export const WAITING_TIME_RE = /待ち時間|待ち|待機|手待ち/;
export const WORK_TIME_RE = /作業時間|実作業|手作業|作業/;

/** 1〜3文・質問は最大一つ（SPEC §4-1）。 */
export function countSentences(text: string): number {
  return text
    .split(/[。！!？?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

export function countQuestions(text: string): number {
  return (text.match(/[？?]/g) ?? []).length;
}

/** 会話本文を埋め込まずに使える、未解決事項の固定ラベル。 */
export function topicLabel(text: string): string {
  const t = normalizeForRules(text);
  if (/月額|月々|毎月/.test(t)) return '月額費用';
  if (/初期費用|導入費/.test(t)) return '初期費用';
  if (/いくら|料金|費用|価格|値段|金額|見積/.test(t)) return '費用';
  if (/解約|やめられ|辞められ|違約/.test(t)) return '途中解約の条件';
  if (/契約期間|最低|縛り/.test(t)) return '契約期間';
  if (/納期|いつまで|いつから|期間/.test(t)) return '期間と納期';
  if (/精度/.test(t)) return '精度';
  if (/3D|データ|図面|形式/.test(t)) return 'データ対応';
  if (/保守|運用|更新|サポート/.test(t)) return '運用・保守';
  if (/セキュリティ|漏洩|漏えい|情報/.test(t)) return '情報の扱い';
  if (/上司|部長|社長|決裁|承認|稟議/.test(t)) return '社内の確認';
  if (/時間|手間|工数/.test(t)) return '作業時間';
  return 'さきほどのご質問';
}
