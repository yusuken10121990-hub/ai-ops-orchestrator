import type { AdviceLlmOutput } from '@sales-copilot/contracts';
import { DECLINE_RE, normalizeForRules } from './text-rules';
import type { AdviceWindowUtterance } from './types';

/**
 * 手動ボタン（切り返し・クロージング）が「相手の直近の発言」に答えるための純粋ロジック。
 * - 相手（REMOTE）の直近の発言の取り出しと、反論・懸念の種類の推定（キーワード）
 * - 見送り（明確な拒否）の検出
 * - 出力がその発言の論点に触れているかの判定（関係ない切り返しを表示前に止める）
 * - 生成が失敗・不合格だったときの、会話本文を埋め込まない固定の安全な案
 */

export type ObjectionType =
  | 'decline'
  | 'price'
  | 'price_question'
  | 'no_need'
  | 'compare'
  | 'timing'
  | 'authority'
  | 'consider'
  | 'other';

/** プロンプトに添える論点の名前（固定文。会話本文を含まない）。 */
export const OBJECTION_LABEL: Record<ObjectionType, string> = {
  decline: '見送り・お断り',
  price: '価格が高いという懸念',
  price_question: '費用の質問',
  no_need: '今は困っていない・必要性が低いという反応',
  compare: '他社と比較してから決めたいという反応',
  timing: '今は時期・余裕がないという反応',
  authority: '自分だけでは決められないという反応',
  consider: '検討したいという反応',
  other: '直近の発言そのもの',
};

const CLASSIFIERS: Array<[Exclude<ObjectionType, 'other' | 'decline'>, RegExp]> = [
  ['compare', /比較|他社|比べ|相見積|あいみつ|ほかの(会社|サービス|ところ)|他の(会社|サービス|ところ)/],
  ['price', /高い|高く|高め|お高|予算|コストが|費用が(かか|高|厳)|お金が|値段が|手が出|安ければ|安く(なら|でき)|もう少し安/],
  ['price_question', /いくら|月額は|料金は(どれ|いくら)|費用は(どれ|いくら)|値段は|価格は/],
  ['no_need', /困って(い)?ない|困ってはいない|間に合って|今のままで|今のやり方で|特に(問題|不便|不満)|必要性|必要(は)?(感じ|ない)/],
  ['timing', /忙し|時期|タイミング|時間がな|時間がありません|余裕がな|余裕がありません|来期|来年度|落ち着いたら/],
  ['authority', /上司|部長|社長|決裁|一人では決め|自分(だけ|一人)では|相談して(から|み)/],
  ['consider', /検討/],
];

/** 1つの発言の論点。見送りが最優先（引き止めない）。 */
export function classifyObjection(text: string): ObjectionType {
  const t = normalizeForRules(text);
  if (DECLINE_RE.test(t)) return 'decline';
  for (const [type, re] of CLASSIFIERS) if (re.test(t)) return type;
  return 'other';
}

/** 相手（REMOTE）の直近 n 件の確定発言（古い→新しい）。帰属不明（UNKNOWN）と自分（SELF）は含めない。 */
export function latestCustomerTurns(window: readonly AdviceWindowUtterance[], n = 2): AdviceWindowUtterance[] {
  return window.filter((u) => u.source === 'REMOTE' && u.text.trim().length > 0).slice(-n);
}

export interface ManualAnchor {
  /** 相手の直近の発言（古い→新しい、最大2件）。 */
  turns: AdviceWindowUtterance[];
  /** 返答が答える対象の発言（論点が読み取れた最新のもの。無ければ最新の発言）。 */
  target: AdviceWindowUtterance | null;
  type: ObjectionType;
}

/** 手動ボタンの返答が答えるべき発言と論点。最新の発言が相づち等で論点が無ければ1つ前を見る。 */
export function manualAnchor(window: readonly AdviceWindowUtterance[]): ManualAnchor {
  const turns = latestCustomerTurns(window, 2);
  for (let i = turns.length - 1; i >= 0; i--) {
    const type = classifyObjection(turns[i]!.text);
    if (type !== 'other') return { turns, target: turns[i]!, type };
  }
  return { turns, target: turns[turns.length - 1] ?? null, type: 'other' };
}

export interface DeclineDetection {
  declined: boolean;
  /** 見送りを示した発言ID（古い→新しい）。 */
  evidenceUtteranceIds: string[];
}

/** 相手の直近 lookback 件の発言に、明確な見送り・連絡不要が含まれるか。 */
export function detectDecline(window: readonly AdviceWindowUtterance[], lookback = 3): DeclineDetection {
  const hits = latestCustomerTurns(window, lookback).filter((u) => DECLINE_RE.test(normalizeForRules(u.text)));
  return { declined: hits.length > 0, evidenceUtteranceIds: hits.map((u) => u.utteranceId) };
}

/** 論点ごとに、返答が触れているべき語（どれか1つ）。other・decline は検査しない（decline は別の規則で扱う）。 */
export const OBJECTION_ANCHOR_RE: Partial<Record<ObjectionType, RegExp>> = {
  price: /費用|価格|金額|料金|値段|高い|高く|高め|予算|コスト|見合|投資|お金/,
  price_question: /費用|価格|金額|料金|値段|額|円|見積|条件|予算|プラン/,
  no_need: /困って|今のやり方|今の運用|今のまま|今の進め方|現状|無理に|課題|不便|必要(は|性|ない|あり)/,
  // 「手間と比べて」のような一般的な比べ方は比較の論点に数えない
  compare: /比較|比べる(とき|際|上|うえ|なら)|比べてみ|他社|ほかの|他の|判断材料|違い|基準|観点|重視|ポイント/,
  timing: /時期|タイミング|忙し|落ち着|時間|余裕|負担|急ぎ|急が/,
  authority: /上司|部長|社長|社内|相談|共有|決裁|ご判断|判断|確認|まとめ/,
  consider: /検討|判断|情報|確認|材料/,
};

/** 表示文（headline + say）が論点に触れているか。検査対象外の論点なら true。 */
export function respondsToObjection(o: Pick<AdviceLlmOutput, 'headline' | 'say'>, type: ObjectionType): boolean {
  const re = OBJECTION_ANCHOR_RE[type];
  if (!re) return true;
  return re.test(normalizeForRules(`${o.headline}\n${o.say ?? ''}`));
}

// ---------------------------------------------------------------------------
// クロージング
// ---------------------------------------------------------------------------

/** 見送り後に引き止める・急かす言い回し。 */
export const PRESSURE_RE =
  /今(決め|ご決断|ご判断)|今日中|本日中|今だけ|今なら|今月中|お急ぎ|せっかく|もったいない|ぜひ一度|もう一度だけ|考え直|再考|そこを何とか/;

/** 次の一歩の依頼（質問・依頼の形）があるか。 */
export function hasNextStepAsk(say: string | null): boolean {
  if (!say) return false;
  const t = normalizeForRules(say);
  return /[？?]|いただけますか|いただけませんか|いかがでしょう|しませんか|ましょうか|よろしいでしょうか|可能でしょうか|どうでしょう|させてください|させていただけ/.test(t);
}

function base(o: Partial<AdviceLlmOutput>): AdviceLlmOutput {
  return {
    action: 'show',
    kind: 'clarify',
    headline: '',
    say: null,
    avoid: null,
    briefReason: '',
    evidenceUtteranceIds: [],
    approvedFactIds: [],
    missingItems: [],
    evidenceLevel: 'tentative',
    nextStepType: 'clarify',
    ...o,
  };
}

/** 見送り後のクロージング: お礼を伝え、扉は開けたまま、引き止めない（質問・日程・資料の押し付けなし）。 */
export function politeCloseOutput(evidence: string[]): AdviceLlmOutput {
  return base({
    kind: 'next_step',
    headline: 'お礼を伝えて気持ちよく終える',
    say: '承知しました。本日はお時間をいただき、ありがとうございました。また状況が変わったときは、お気軽にお声がけください。',
    avoid: '日程・資料・値引きで引き止める',
    briefReason: '顧客が見送りの意思を示している。引き止めずに関係を残す',
    evidenceUtteranceIds: evidence.slice(0, 12),
    evidenceLevel: evidence.length > 0 ? 'supported' : 'tentative',
    nextStepType: 'defer',
  });
}

/** 通常のクロージング: 締めの一言＋具体的な次の一歩の依頼（数値・価格・無料は含めない）。 */
export function closingAskOutput(type: ObjectionType, evidence: string[]): AdviceLlmOutput {
  const priceFirst = type === 'price' || type === 'price_question';
  return base({
    kind: 'next_step',
    headline: priceFirst ? '費用は正式に確認し、次の場を決める' : '次の一歩を決めて締める',
    say: priceFirst
      ? '費用の点は、正式な条件をそろえてからお伝えします。そのうえで、来週どこかで今日の内容を御社の業務に当てはめて整理するお時間をいただけますか？'
      : '本日はありがとうございました。今日の内容を御社の業務に当てはめて整理したいので、来週どこかで少しお時間をいただけますか？',
    avoid: priceFirst ? '未承認の金額・値引きを言う' : '契約や申し込みを迫る',
    briefReason: priceFirst ? '費用の懸念が残っている。条件確認を約束してから次の場を依頼' : '締めとして、判断のための次の場を一つ依頼する',
    evidenceUtteranceIds: evidence.slice(0, 12),
    nextStepType: 'clarify',
  });
}

// ---------------------------------------------------------------------------
// 切り返しの安全な案（生成が不合格だったとき用。会話本文を埋め込まない）
// ---------------------------------------------------------------------------

const REBUTTAL_TEMPLATES: Record<Exclude<ObjectionType, 'decline'>, Pick<AdviceLlmOutput, 'headline' | 'say' | 'avoid' | 'briefReason' | 'kind' | 'nextStepType'>> = {
  price: {
    kind: 'clarify',
    headline: '高いと感じた点を確認する',
    say: '率直に言っていただけて助かります。今の作業の手間と比べて、どのあたりが見合わないと感じられましたか？',
    avoid: '値引きや未承認の金額を出す',
    briefReason: '価格の懸念。何と比べて高いのかを先に確かめる',
    nextStepType: 'clarify',
  },
  price_question: {
    kind: 'answer',
    headline: '費用は確認して正確に伝える',
    say: '費用は、今回の内容に合わせた正式な条件をそろえてから、正確にお伝えします。',
    avoid: '最安プランの金額を今回の価格のように言う',
    briefReason: '費用の質問。承認済みの条件が無いので確認を約束する',
    nextStepType: 'quote_review',
  },
  no_need: {
    kind: 'clarify',
    headline: '今のやり方で困っていない点を受け止める',
    say: 'そうなんですね、今のやり方で回っているなら無理に変える必要はないと思います。ちなみに、今の作業で少しでも手間に感じている部分はありますか？',
    avoid: '不安をあおって売り込む',
    briefReason: '困っていないという反応。押さずに小さな手間の有無だけ確かめる',
    nextStepType: 'clarify',
  },
  compare: {
    kind: 'clarify',
    headline: '比較の観点を確認する',
    say: 'ぜひ比較してください。比べるときに、御社として一番重視したい点はどこですか？',
    avoid: '他社を否定する・他社の価格を作る',
    briefReason: '比較したいという反応。判断の基準をそろえる',
    nextStepType: 'clarify',
  },
  timing: {
    kind: 'clarify',
    headline: '今は時期ではない点を受け止める',
    say: 'お忙しい時期ですよね。今すぐ決める必要はないので、落ち着かれたころに判断できるよう、要点だけまとめておきましょうか？',
    avoid: '今決めるよう急かす',
    briefReason: '時期・余裕の懸念。急かさずに判断材料を残す',
    nextStepType: 'clarify',
  },
  authority: {
    kind: 'clarify',
    headline: '社内で相談する前の整理を聞く',
    say: 'もちろんです。社内でご相談される前に、今回の話でまだ整理しておきたいところはありますか？',
    avoid: '担当者を飛ばして決裁者に連絡する',
    briefReason: '一人では決められないという反応。社内確認の材料を整える',
    nextStepType: 'stakeholder_review',
  },
  consider: {
    kind: 'clarify',
    headline: '検討に必要な情報を聞く',
    say: '承知しました。ご検討の前に、こちらから出しておいた方がいい情報はありますか？',
    avoid: '日程や契約を迫る',
    briefReason: '検討の表明。判断に足りない情報を確かめる',
    nextStepType: 'clarify',
  },
  other: {
    kind: 'clarify',
    headline: '今の発言の意図を確認する',
    say: '大事な点なので、もう少し詳しく伺ってもいいですか？',
    avoid: '確認前に言い切る',
    briefReason: '直近の発言の意図を確かめてから答える',
    nextStepType: 'clarify',
  },
};

/** 切り返しの安全な案（論点別の固定文）。見送りなら引き止めない終わり方。 */
export function objectionRebuttalOutput(type: ObjectionType, evidence: string[]): AdviceLlmOutput {
  if (type === 'decline') {
    return base({
      kind: 'next_step',
      headline: '見送りの意思を尊重して終える',
      say: '承知しました。無理に進める必要はないので、今回はここまでにしておきましょう。',
      avoid: '日程・資料送付・デモで引き止める',
      briefReason: '顧客が見送りや連絡不要の意思を示している',
      evidenceUtteranceIds: evidence.slice(0, 12),
      evidenceLevel: evidence.length > 0 ? 'supported' : 'tentative',
      nextStepType: 'defer',
    });
  }
  return base({ ...REBUTTAL_TEMPLATES[type], evidenceUtteranceIds: evidence.slice(0, 12) });
}
