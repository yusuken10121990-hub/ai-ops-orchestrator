import { describe, expect, it } from 'vitest';
import { AdviceCard, ServerMessage, type SessionStartMessage } from '@sales-copilot/contracts';
import { audioFrame, CountingLlm, failingLlm, hangingLlm, runtimeHarness, sleep, waitFor, type RuntimeHarness } from './test-support';

function start(h: RuntimeHarness, over: Partial<SessionStartMessage> = {}): string {
  h.runtime.handleMessage({
    type: 'session.start',
    purpose: '業務診断の初回商談（架空）',
    appliedFacts: [],
    mode: 'LIVE',
    selfCaptureEnabled: true,
    consentConfirmed: true,
    storage: 'memory_only',
    ...over,
  });
  const id = h.runtime.currentSessionId;
  if (!id) throw new Error(`session did not start: ${JSON.stringify(h.ofType('error'))}`);
  return id;
}

/** 会議側の確定発話を流す（音声1フレーム→認識器生成→結果）。 */
function remoteFinal(h: RuntimeHarness, sid: string, text: string, startMs: number, gen?: number) {
  h.runtime.handleAudio(audioFrame(sid, 'REMOTE', { startMs }));
  const r = h.rec('REMOTE');
  r.emitResult({ text: text.slice(0, 3), isFinal: false, speechFinal: false, startMs, endMs: startMs + 400, streamGeneration: gen });
  r.emitResult({ text, isFinal: true, speechFinal: true, startMs, endMs: startMs + 1500, streamGeneration: gen });
}

describe('SessionRuntime LIVE pipeline (fake STT + counting LLM)', () => {
  it('all outgoing messages satisfy the ServerMessage schema; a validated advice card is sent', async () => {
    const llm = new CountingLlm();
    const h = runtimeHarness({ llm });
    const sid = start(h);
    remoteFinal(h, sid, '月額の費用はどれくらいかかりますか？', 1000);
    await waitFor(() => h.ofType('advice.card').length > 0);
    for (const m of h.messages) expect(ServerMessage.safeParse(JSON.parse(JSON.stringify(m))).success).toBe(true);
    const card = h.ofType('advice.card')[0]!.card;
    expect(AdviceCard.safeParse(card).success).toBe(true);
    expect(card.sessionId).toBe(sid);
    // interim と final は同じ segment を更新（重複発言にならない）
    const segs = h.ofType('transcript.segment');
    expect(new Set(segs.map((s) => s.segmentId)).size).toBe(1);
    expect(llm.calls).toBe(1);
    // 価格未承認: 金額を発明しない（SPEC §16-1 #8）
    expect(card.say ?? '').not.toMatch(/\d+\s*(万)?円/);
    await h.runtime.end(false);
  });

  it('pause stops STT forwarding and LLM calls; end stops everything and nothing is sent externally afterwards (§16-1 #5)', async () => {
    const llm = hangingLlm();
    const h = runtimeHarness({ llm });
    const sid = start(h);
    remoteFinal(h, sid, '保守の範囲はどこまで入っていますか？', 1000);
    await waitFor(() => llm.calls === 1 && llm.inflight === 1);
    const remote = h.rec('REMOTE');
    const sentBefore = remote.sent.length;

    h.runtime.handleMessage({ type: 'analysis.pause' });
    await waitFor(() => llm.inflight === 0); // 実行中の生成は AbortSignal で中止される
    expect(remote.isStopped).toBe(true);
    h.runtime.handleAudio(audioFrame(sid, 'REMOTE', { startMs: 5000 }));
    h.runtime.handleMessage({ type: 'advice.request', kind: 'rebuttal', requestId: 'r1' });
    await sleep(50);
    expect(remote.sent.length).toBe(sentBefore);
    expect(llm.calls).toBe(1);
    expect(h.ofType('status').at(-1)!.lifecycle).toBe('paused');
    expect(h.ofType('status').at(-1)!.externalSending).toBe(false);

    h.runtime.handleMessage({ type: 'analysis.resume' });
    remoteFinal(h, sid, '解約はいつでもできますか？', 7000);
    await waitFor(() => llm.calls === 2 && llm.inflight === 1);

    await h.runtime.end(false);
    await waitFor(() => llm.inflight === 0);
    const allRecs = [...h.recognizers.values()].flat();
    const sentAtEnd = allRecs.reduce((s, r) => s + r.sent.length, 0);
    expect(allRecs.every((r) => r.isStopped)).toBe(true);
    // 終了後に音声・発話・ボタンが来ても外部へは何も送らない
    for (let i = 0; i < 5; i++) h.runtime.handleAudio(audioFrame(sid, 'REMOTE', { startMs: 9000 + i * 100 }));
    h.runtime.handleMessage({ type: 'advice.request', kind: 'next_step', requestId: 'r2' });
    await sleep(80);
    expect(allRecs.reduce((s, r) => s + r.sent.length, 0)).toBe(sentAtEnd);
    expect([...h.recognizers.values()].flat().length).toBe(allRecs.length); // 新しい接続も作らない
    expect(llm.calls).toBe(2);
    expect(h.runtime.guard.llmAfterStop).toBe(0);
    expect(h.ofType('status').at(-1)!.lifecycle).toBe('ended');
  });

  it('self capture OFF stops SELF forwarding independently of the meeting mute', async () => {
    const h = runtimeHarness();
    const sid = start(h);
    h.runtime.handleAudio(audioFrame(sid, 'SELF', { startMs: 100 }));
    const self = h.rec('SELF');
    expect(self.sent.length).toBe(1);
    h.runtime.handleMessage({ type: 'source.state', source: 'SELF', state: 'off' });
    h.runtime.handleAudio(audioFrame(sid, 'SELF', { startMs: 200 }));
    expect(self.isStopped).toBe(true);
    expect(h.recognizers.get('SELF')!.length).toBe(1);
    expect(h.ofType('warning').some((w) => w.code === 'degraded_capture')).toBe(true);
    await h.runtime.end(false);
  });

  it('reconnect + duplicate finals: no duplicate transcript, usage, or advice (§16-1 #17)', async () => {
    const llm = new CountingLlm();
    const h = runtimeHarness({ llm });
    const sid = start(h);
    for (let i = 1; i <= 10; i++) h.runtime.handleAudio(audioFrame(sid, 'REMOTE', { gen: 0, seq: i, startMs: i * 100 }));
    // 同じフレームの再送（重複 sequence）は計上しない
    for (let i = 1; i <= 10; i++) h.runtime.handleAudio(audioFrame(sid, 'REMOTE', { gen: 0, seq: i, startMs: i * 100 }));
    const r = h.rec('REMOTE');
    r.emitResult({ text: '導入までの期間はどれくらいですか？', isFinal: true, speechFinal: true, startMs: 100, endMs: 1000 });
    await waitFor(() => llm.calls === 1 && h.ofType('advice.card').length === 1);
    // 同じ final の再配送（同世代）
    r.emitResult({ text: '導入までの期間はどれくらいですか？', isFinal: true, speechFinal: true, startMs: 100, endMs: 1000 });
    // 再接続後に同じ区間の final が再配送される（世代が変わる）
    r.simulateReconnect();
    r.emitResult({ text: '導入までの期間はどれくらいですか？', isFinal: true, speechFinal: true, startMs: 110, endMs: 1000 });
    await sleep(80);
    expect(h.ofType('transcript.segment').filter((s) => s.isFinal)).toHaveLength(1);
    expect(llm.calls).toBe(1);
    expect(h.ofType('advice.card')).toHaveLength(1);
    await h.runtime.end(false);
    const usage = h.ofType('usage').at(-1)!;
    expect(usage.sttSecondsBySource.REMOTE).toBeCloseTo(1.0, 5);
    expect(usage.calls).toBe(1);
  });

  it('a revised final ("できます" → "できません") invalidates advice that depended on it (§16-1 #2)', async () => {
    const llm = new CountingLlm();
    const h = runtimeHarness({ llm });
    const sid = start(h);
    remoteFinal(h, sid, '今のデータのままでもできますか？', 1000);
    await waitFor(() => h.ofType('advice.card').length === 1);
    const card = h.ofType('advice.card')[0]!.card;
    expect(card.evidenceUtteranceIds.length).toBeGreaterThan(0);
    h.rec('REMOTE').emitResult({ text: '今のデータのままではできません。', isFinal: true, speechFinal: true, startMs: 1000, endMs: 2500 });
    await waitFor(() => h.ofType('advice.invalidated').length > 0);
    expect(h.ofType('advice.invalidated')[0]).toMatchObject({ adviceId: card.adviceId, reason: 'transcript_revised' });
    await h.runtime.end(false);
  });
});

describe('SessionRuntime degrades safely (§16-1 #16)', () => {
  it('LIVE without keys → not_configured status + error (not silent idle), no external calls', async () => {
    const h = runtimeHarness({ llm: null, withStt: false });
    const sid = start(h);
    h.runtime.handleAudio(audioFrame(sid, 'REMOTE'));
    const st = h.ofType('status').at(-1)!;
    expect(st.pipelines.stt).toMatchObject({ state: 'not_configured', reason: 'not_configured' });
    expect(st.pipelines.advice).toMatchObject({ state: 'not_configured', reason: 'not_configured' });
    expect(h.ofType('error').filter((e) => e.code === 'not_configured')).toHaveLength(2);
    expect(h.recognizers.size).toBe(0);
    h.runtime.handleMessage({ type: 'advice.request', kind: 'rebuttal', requestId: 'x' });
    expect(h.ofType('error').at(-1)).toMatchObject({ code: 'not_configured', requestId: 'x' });
    await h.runtime.end(false);
  });

  it.each([
    ['rate_limited', 'rate_limited'],
    ['auth_failed', 'auth_failed'],
    ['network', 'disconnected'],
  ] as const)('LLM %s → no unsafe card, advice status reason %s', async (kind, reason) => {
    const llm = failingLlm(kind);
    const h = runtimeHarness({ llm });
    const sid = start(h);
    remoteFinal(h, sid, '初期費用はいくらですか？', 1000);
    await waitFor(() => h.ofType('status').some((s) => s.pipelines.advice.reason === reason));
    // 表示されたとしても安全側（hold/none・言い切りなし）のカードだけ
    for (const c of h.ofType('advice.card')) {
      expect(AdviceCard.safeParse(c.card).success).toBe(true);
      expect(c.card.say ?? '').not.toMatch(/\d+\s*(万)?円/);
    }
    const callsAfterFirst = llm.calls;
    if (kind === 'auth_failed') {
      // 認証失敗は以後呼ばない（キー確認が必要）
      h.runtime.handleMessage({ type: 'advice.request', kind: 'next_question', requestId: 'm1' });
      await sleep(50);
      expect(llm.calls).toBe(callsAfterFirst);
      expect(h.ofType('error').at(-1)?.requestId).toBe('m1');
    }
    if (kind === 'rate_limited') {
      // 429 直後はバックオフ中なので再要求しても外部へ出ない
      h.runtime.handleMessage({ type: 'advice.request', kind: 'next_question', requestId: 'm2' });
      await sleep(50);
      expect(llm.calls).toBe(callsAfterFirst);
    }
    await h.runtime.end(false);
  });

  it('invalid JSON from the LLM is never displayed as-is (bounded retries then safe fallback)', async () => {
    const llm = new CountingLlm(async () => ({ text: '{"action":"show","say":"必ず月1万円で', usage: { inputTokens: 1, outputTokens: 1 }, model: 'fake' }));
    const h = runtimeHarness({ llm });
    const sid = start(h);
    remoteFinal(h, sid, '月額はいくらになりますか？', 1000);
    await waitFor(() => h.ofType('status').some((s) => s.pipelines.advice.reason === 'invalid_output'));
    expect(llm.calls).toBeLessThanOrEqual(1 + h.config.advice.maxRetries);
    for (const c of h.ofType('advice.card')) expect(c.card.say ?? '').not.toContain('1万円');
    await h.runtime.end(false);
  });

  it('timeout → advice delayed (timeout), generation aborted, session keeps running', async () => {
    const llm = hangingLlm();
    const h = runtimeHarness({ llm, config: { advice: { ...runtimeHarness().config.advice, timeoutMs: 80, maxRetries: 0, cooldownMs: 0, manualMinIntervalMs: 0 } } });
    const sid = start(h);
    remoteFinal(h, sid, '運用は誰が担当することになりますか？', 1000);
    await waitFor(() => h.ofType('status').some((s) => s.pipelines.advice.reason === 'timeout'), 3000);
    await waitFor(() => llm.inflight === 0);
    expect(h.runtime.isActive).toBe(true);
    await h.runtime.end(false);
  });

  it('applied facts must be approved at the given version', () => {
    const h = runtimeHarness();
    const f = h.store.createFact({ category: 'price_monthly', value: '月額 50,000円（税別）', scope: '標準プラン', sourceNote: '架空' });
    h.runtime.handleMessage({
      type: 'session.start',
      purpose: 'x',
      appliedFacts: [{ factId: f.factId, version: f.version }],
      mode: 'LIVE',
      selfCaptureEnabled: true,
      consentConfirmed: true,
      storage: 'memory_only',
    });
    expect(h.runtime.currentSessionId).toBeNull();
    expect(h.ofType('error').at(-1)!.message).toContain('not_approved');
  });
});
