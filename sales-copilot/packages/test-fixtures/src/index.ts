import { readdirSync, readFileSync } from 'node:fs';
import {
  AdviceLlmOutput,
  AdviceTrigger,
  ApprovedFact,
  AudioSource,
  type AdviceAction,
  type AdviceKind,
  type NextStepType,
} from '@sales-copilot/contracts';
import { z } from 'zod';

const DATA_DIR = new URL('../data/', import.meta.url);
const CONVERSATIONS_DIR = new URL('conversations/', DATA_DIR);
const REPLAY_DIR = new URL('replay/', DATA_DIR);

// ---------------------------------------------------------------------------
// 返答例 A〜R（SPEC §11・原文）
// ---------------------------------------------------------------------------

/** data/style-examples.ja.md の原文。 */
export function loadStyleExamplesText(): string {
  return readFileSync(new URL('style-examples.ja.md', DATA_DIR), 'utf8');
}

// ---------------------------------------------------------------------------
// 架空会話フィクスチャ（期待は「正確な文」ではなく判断の制約）
// ---------------------------------------------------------------------------

const FixtureUtterance = z
  .object({
    utteranceId: z.string().min(1),
    source: AudioSource,
    text: z.string(),
    flags: z.array(z.string()).optional(),
  })
  .strict();

const FixtureMemoItem = z
  .object({
    itemId: z.string().min(1),
    text: z.string(),
    status: z.enum(['fact', 'hypothesis', 'unverified']),
    evidenceUtteranceIds: z.array(z.string()),
    resolved: z.boolean(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const SafetyExpectation = z
  .object({
    forbiddenNextStepTypes: z.array(z.string()).optional(),
    /** say と headline に当ててはいけない正規表現。 */
    forbiddenPatterns: z.array(z.string()).optional(),
    /** say に、allowedNumbers 以外の数値表現（数字・金額/期間の漢数字）を含めない。 */
    mustNotInventNumbers: z.boolean().optional(),
    allowedNumbers: z.array(z.string()).optional(),
    maxQuestions: z.number().int().nonnegative().optional(),
  })
  .strict();

const QualityExpectation = z
  .object({
    allowedActions: z.array(z.string()).optional(),
    allowedKinds: z.array(z.string()).optional(),
    allowedNextStepTypes: z.array(z.string()).optional(),
    requireFactIds: z.array(z.string()).optional(),
    requiredPatternsAny: z.array(z.string()).optional(),
    requireSay: z.boolean().optional(),
  })
  .strict();

const ConversationFixtureSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    /** SPEC §16-1 の項目番号。 */
    specItems: z.array(z.number().int()),
    /** 同じ顧客発言で文脈だけ違うフィクスチャのグループ。 */
    contextGroup: z.string().nullable(),
    description: z.string(),
    purpose: z.string(),
    trigger: AdviceTrigger,
    degraded: z.boolean().optional(),
    approvedFacts: z.array(ApprovedFact),
    window: z.array(FixtureUtterance),
    memo: z.record(z.string(), z.array(FixtureMemoItem)),
    expect: z.object({ safety: SafetyExpectation, quality: QualityExpectation }).strict(),
    candidates: z
      .object({
        good: z.array(AdviceLlmOutput),
        bad: z.array(z.object({ note: z.string(), output: AdviceLlmOutput }).strict()),
      })
      .strict(),
  })
  .strict();

export type ConversationFixture = z.infer<typeof ConversationFixtureSchema>;
export type SafetyExpectation = z.infer<typeof SafetyExpectation>;
export type QualityExpectation = z.infer<typeof QualityExpectation>;
export type FixtureMemoItem = z.infer<typeof FixtureMemoItem> & { field: string };

export function listConversationFixtures(): string[] {
  return readdirSync(CONVERSATIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function loadConversationFixture(id: string): ConversationFixture {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid fixture id: ${id}`);
  const raw: unknown = JSON.parse(readFileSync(new URL(`${id}.json`, CONVERSATIONS_DIR), 'utf8'));
  return ConversationFixtureSchema.parse(raw);
}

export function loadAllConversationFixtures(): ConversationFixture[] {
  return listConversationFixtures().map(loadConversationFixture);
}

/** fixture.memo を ConversationState#snapshot() 互換の形にする（field を補う）。 */
export function fixtureMemoSnapshot(f: ConversationFixture): { memo: Record<string, FixtureMemoItem[]> } {
  const memo: Record<string, FixtureMemoItem[]> = {};
  for (const [field, items] of Object.entries(f.memo)) {
    memo[field] = items.map((i) => ({ ...i, field }));
  }
  return { memo };
}

export interface JudgementCheck {
  ok: boolean;
  failures: string[];
}

const KANJI_NUMBER_WITH_UNIT = /[〇一二三四五六七八九十百千]+(万|億|円|年|ヶ月|か月|カ月|ヵ月|週間|日|パーセント|割)/;

/**
 * 出力が判断の制約を満たすか（coaching の検証器とは独立した簡易実装で評価する）。
 * level=safety は安全制約のみ、full は品質制約も含む。
 */
export function checkJudgement(
  output: AdviceLlmOutput,
  expect: ConversationFixture['expect'],
  level: 'safety' | 'full' = 'full',
): JudgementCheck {
  const failures: string[] = [];
  const s = expect.safety;
  const say = output.say ?? '';
  const visible = `${output.headline}\n${say}`;
  if (s.forbiddenNextStepTypes?.includes(output.nextStepType)) failures.push(`forbidden nextStepType ${output.nextStepType}`);
  for (const p of s.forbiddenPatterns ?? []) {
    if (new RegExp(p).test(visible)) failures.push(`forbidden pattern /${p}/`);
  }
  if (s.maxQuestions !== undefined) {
    const q = (say.match(/[？?]/g) ?? []).length;
    if (q > s.maxQuestions) failures.push(`too many questions (${q})`);
  }
  if (s.mustNotInventNumbers) {
    let rest = say.normalize('NFKC').replace(/(\d),(?=\d{3})/g, '$1');
    for (const a of s.allowedNumbers ?? []) rest = rest.split(a.normalize('NFKC').replace(/(\d),(?=\d{3})/g, '$1')).join('');
    if (/\d/.test(rest) || KANJI_NUMBER_WITH_UNIT.test(rest)) failures.push('invented number');
  }
  if (level === 'full') {
    const q = expect.quality;
    if (q.allowedActions && !q.allowedActions.includes(output.action)) failures.push(`action ${output.action} not allowed`);
    if (q.allowedKinds && !q.allowedKinds.includes(output.kind)) failures.push(`kind ${output.kind} not allowed`);
    if (q.allowedNextStepTypes && !q.allowedNextStepTypes.includes(output.nextStepType))
      failures.push(`nextStepType ${output.nextStepType} not allowed`);
    for (const id of q.requireFactIds ?? []) {
      if (!output.approvedFactIds.includes(id)) failures.push(`missing fact id ${id}`);
    }
    if (q.requireSay && (output.action !== 'show' || !output.say)) failures.push('say required');
    if (q.requiredPatternsAny && !q.requiredPatternsAny.some((p) => new RegExp(p).test(say)))
      failures.push('none of requiredPatternsAny matched');
  }
  return { ok: failures.length === 0, failures };
}

// 型の再輸出（フィクスチャ利用側の便宜）
export type { AdviceAction, AdviceKind, NextStepType };

// ---------------------------------------------------------------------------
// OFFLINE 再生スクリプト（タイムド STT 行）
// ---------------------------------------------------------------------------

export const ReplayLine = z
  .object({
    /** スクリプト開始からの経過 ms。 */
    atMs: z.number().int().nonnegative(),
    source: AudioSource,
    text: z.string(),
    /** false = interim（同じ発言の途中経過）。true = 区間確定（発話終了として扱ってよい）。 */
    isFinal: z.boolean(),
  })
  .strict();
export type ReplayLine = z.infer<typeof ReplayLine>;

export const ReplayScript = z
  .object({
    name: z.string().min(1),
    title: z.string(),
    description: z.string(),
    durationMs: z.number().int().nonnegative(),
    lines: z.array(ReplayLine).min(1),
  })
  .strict();
export type ReplayScript = z.infer<typeof ReplayScript>;

export function listReplayScripts(): string[] {
  return readdirSync(REPLAY_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function loadReplayScript(name: string): ReplayScript {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid replay script name: ${name}`);
  const raw: unknown = JSON.parse(readFileSync(new URL(`${name}.json`, REPLAY_DIR), 'utf8'));
  const script = ReplayScript.parse(raw);
  for (let i = 1; i < script.lines.length; i++) {
    if (script.lines[i]!.atMs < script.lines[i - 1]!.atMs) throw new Error(`replay script ${name}: lines not sorted by atMs`);
  }
  return script;
}
