import { describe, expect, it } from 'vitest';
import { AdviceCard, type SessionStartMessage } from '@sales-copilot/contracts';
import type { AdviceLlmRequest } from '@sales-copilot/providers';
import { RuleBasedOfflineLlm } from '@sales-copilot/coaching';
import { loadConfig, providerStatus } from './config';
import { audioFrame, CountingLlm, runtimeHarness, sleep, testLogger, waitFor, type RuntimeHarness } from './test-support';

function start(h: RuntimeHarness, over: Partial<SessionStartMessage> = {}): string {
  h.runtime.handleMessage({
    type: 'session.start',
    purpose: '見積業務の効率化（架空）',
    appliedFacts: [],
    mode: 'LIVE',
    selfCaptureEnabled: true,
    consentConfirmed: true,
    storage: 'memory_only',
    ...over,
  });
  const id = h.runtime.currentSessionId;
  if (!id) throw new Error('session did not start');
  return id;
}

function final(h: RuntimeHarness, sid: string, source: 'SELF' | 'REMOTE', text: string, startMs: number, endMs = startMs + 1500) {
  h.runtime.handleAudio(audioFrame(sid, source, { startMs }));
  const r = h.rec(source);
  r.emitResult({ text: text.slice(0, 3), isFinal: false, speechFinal: false, startMs, endMs: startMs + 300 });
  r.emitResult({ text, isFinal: true, speechFinal: true, startMs, endMs });
}

/** 生成要求の本文（プロンプト）を記録する LLM。 */
function recordingLlm(): CountingLlm & { users: string[] } {
  const users: string[] = [];
  const llm = new CountingLlm(async (req: AdviceLlmRequest) => {
    users.push(req.user);
    return new RuleBasedOfflineLlm().complete(req);
  }) as CountingLlm & { users: string[] };
  llm.users = users;
  return llm;
}

describe('manual buttons use ANTHROPIC_MANUAL_MODEL (separate from automatic cards)', () => {
  it('config: ANTHROPIC_MODEL stays haiku for auto cards, ANTHROPIC_MANUAL_MODEL defaults to sonnet', () => {
    const c = loadConfig({});
    expect(c.anthropic.model).toBe('claude-haiku-5-5');
    expect(c.anthropic.manualModel).toBe('claude-sonnet-5-5');
    expect(c.advice.manualTimeoutMs).toBeGreaterThan(c.advice.timeoutMs);
    expect(loadConfig({ ANTHROPIC_MANUAL_MODEL: 'claude-opus-5-5' }).anthropic.manualModel).toBe('claude-opus-5-5');
    expect(providerStatus(c).llm).toEqual({ configured: false, provider: 'anthropic', model: 'claude-haiku-5-5', manualModel: 'claude-sonnet-5-5' });
  });

  it('config: manual unit prices are only reused when the manual model equals the auto model (never guessed)', () => {
    const priceEnv = {
      PRICE_CURRENCY: 'USD',
      PRICE_SOURCE: 'test',
      PRICE_CHECKED_DATE: '2026-11-17',
      PRICE_LLM_INPUT_PER_MTOK: '1',
      PRICE_LLM_OUTPUT_PER_MTOK: '2',
    };
    expect(loadConfig(priceEnv).priceTable?.llmManualInputPerMTok).toBeNull();
    expect(loadConfig({ ...priceEnv, ANTHROPIC_MANUAL_MODEL: 'claude-haiku-5-5' }).priceTable?.llmManualInputPerMTok).toBe(1);
    const explicit = loadConfig({ ...priceEnv, PRICE_LLM_MANUAL_INPUT_PER_MTOK: '20', PRICE_LLM_MANUAL_OUTPUT_PER_MTOK: '30' }).priceTable;
    expect([explicit?.llmManualInputPerMTok, explicit?.llmManualOutputPerMTok]).toEqual([20, 30]);
  });

  it('auto card → live (auto) model; closing button → manual model; usage counts both', async () => {
    const auto = recordingLlm();
    const manual = recordingLlm();
    const h = runtimeHarness({ llm: auto, manualLlm: manual });
    const sid = start(h);
    final(h, sid, 'REMOTE', '月額の費用はどれくらいかかりますか？', 1000);
    await waitFor(() => auto.calls === 1 && h.ofType('advice.card').length === 1);
    expect(manual.calls).toBe(0);

    h.runtime.handleMessage({ type: 'advice.request', kind: 'closing', requestId: 'c1' });
    await waitFor(() => h.ofType('advice.card').some((c) => c.card.trigger === 'manual_closing'));
    expect(manual.calls).toBe(1);
    expect(auto.calls).toBe(1);
    expect(manual.users[0]).toContain('［クロージング］');
    expect(manual.users[0]).toContain('<latest_customer_data>');
    const card = h.ofType('advice.card').find((c) => c.card.trigger === 'manual_closing')!.card;
    expect(AdviceCard.safeParse(card).success).toBe(true);
    expect(card.say ?? '').not.toMatch(/\d+\s*(万)?円/);
    await waitFor(() => (h.ofType('usage').at(-1)?.calls ?? 0) >= 2, 3000);
    expect(h.ofType('usage').at(-1)!.llmInputTokens).toBe(200);
    await h.runtime.end(false);
  });

  it('without a separate manual LLM, manual buttons fall back to the live LLM', async () => {
    const auto = recordingLlm();
    const h = runtimeHarness({ llm: auto });
    start(h);
    h.runtime.handleMessage({ type: 'advice.request', kind: 'rebuttal', requestId: 'r1' });
    await waitFor(() => auto.calls === 1);
    await h.runtime.end(false);
  });

  it('pause stops manual (closing) LLM calls too', async () => {
    const manual = recordingLlm();
    const h = runtimeHarness({ manualLlm: manual });
    start(h);
    h.runtime.handleMessage({ type: 'analysis.pause' });
    await sleep(20);
    h.runtime.handleMessage({ type: 'advice.request', kind: 'closing', requestId: 'c1' });
    await sleep(50);
    expect(manual.calls).toBe(0);
    expect(h.ofType('error').at(-1)?.requestId).toBe('c1');
    await h.runtime.end(false);
  });
});

describe('speaker echo: customer voice duplicated on SELF is not used for advice', () => {
  it('SELF final arriving after the REMOTE original is dropped (not stored, not in the prompt)', async () => {
    const manual = recordingLlm();
    const h = runtimeHarness({ manualLlm: manual });
    const sid = start(h);
    final(h, sid, 'REMOTE', '他社さんとも比較してから決めたいと思っています。', 1000);
    final(h, sid, 'SELF', '他社さんとも比較してから決めたいと思っています', 1100);
    // 本人の発言（相手の発言とは別の内容）は残る
    final(h, sid, 'SELF', 'ぜひ比べてください。重視したい点はどこですか？', 3500, 5000);
    await sleep(20);
    const selfFinals = h.ofType('transcript.segment').filter((s) => s.source === 'SELF' && s.isFinal);
    expect(selfFinals.map((s) => s.text)).toEqual(['', 'ぜひ比べてください。重視したい点はどこですか？']);

    h.runtime.handleMessage({ type: 'advice.request', kind: 'rebuttal', requestId: 'r1' });
    await waitFor(() => manual.calls === 1);
    const transcript = manual.users[0]!.split('<transcript_data>')[1]!.split('</transcript_data>')[0]!;
    const rows = JSON.parse(transcript) as Array<{ source: string; text: string }>;
    expect(rows.filter((r) => r.source === 'SELF').map((r) => r.text)).toEqual(['ぜひ比べてください。重視したい点はどこですか？']);
    await h.runtime.end(false);
  });

  it('SELF final arriving BEFORE the REMOTE original is excluded from the advice context afterwards', async () => {
    const manual = recordingLlm();
    const h = runtimeHarness({ manualLlm: manual });
    const sid = start(h);
    final(h, sid, 'SELF', 'ちょっと高いですね、正直なところ', 1100);
    final(h, sid, 'REMOTE', 'ちょっと高いですね、正直なところ。', 1000);
    h.runtime.handleMessage({ type: 'advice.request', kind: 'rebuttal', requestId: 'r1' });
    await waitFor(() => manual.calls === 1);
    const transcript = manual.users[0]!.split('<transcript_data>')[1]!.split('</transcript_data>')[0]!;
    const rows = JSON.parse(transcript) as Array<{ source: string }>;
    expect(rows.map((r) => r.source)).toEqual(['REMOTE']);
    await h.runtime.end(false);
  });

  it('logs only counts, never the utterance text', async () => {
    const { logger, capture } = testLogger('debug');
    const h = runtimeHarness({ logger });
    const sid = start(h);
    final(h, sid, 'REMOTE', '今回は見送りにさせてください。', 1000);
    final(h, sid, 'SELF', '今回は見送りにさせてください', 1050);
    await sleep(10);
    expect(capture.text).toContain('"selfEchoDropped":1');
    expect(capture.text).not.toContain('見送り');
    await h.runtime.end(false);
  });
});
