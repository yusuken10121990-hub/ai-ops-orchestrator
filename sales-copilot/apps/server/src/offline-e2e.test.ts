import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AdviceCard, OfflineScriptsResponse, parseServerMessage, SessionReviewResponse, type ServerMessage } from '@sales-copilot/contracts';
import { loadReplayScript } from '@sales-copilot/test-fixtures';
import { buildApp, type AppHandle } from './app';
import { coachingBinding } from './coaching-binding';
import type { ServerConfig } from './config';
import { listOfflineScripts, loadReplay } from './offline-scripts';
import { Store } from './store';
import {
  audioFrame,
  CountingLlm,
  FAKE_ANTHROPIC_KEY,
  FAKE_DEEPGRAM_KEY,
  ORIGIN,
  sleep,
  testConfig,
  testLogger,
  waitFor,
} from './test-support';

const handles: AppHandle[] = [];
afterEach(async () => {
  while (handles.length) await handles.pop()!.app.close();
});

interface Client {
  ws: WebSocket;
  msgs: ServerMessage[];
  invalid: string[];
  send(o: unknown): void;
  of<T extends ServerMessage['type']>(t: T): Extract<ServerMessage, { type: T }>[];
}

async function connectClient(port: number, token: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: ORIGIN });
  const client: Client = {
    ws,
    msgs: [],
    invalid: [],
    send: (o) => ws.send(JSON.stringify(o)),
    of: (t) => client.msgs.filter((m) => m.type === t) as never,
  };
  ws.on('message', (d) => {
    const p = parseServerMessage(String(d));
    if (p.ok) client.msgs.push(p.message);
    else client.invalid.push(String(d).slice(0, 80));
  });
  await new Promise<void>((r) => ws.on('open', () => r()));
  client.send({ type: 'hello', protocolVersion: 1, clientVersion: 'e2e', token });
  await waitFor(() => client.msgs.some((m) => m.type === 'hello.ack'));
  return client;
}

async function setup(cfg: Partial<ServerConfig>, liveLlm: CountingLlm | null) {
  const { logger, capture } = testLogger('debug');
  const store = new Store(':memory:');
  const config = testConfig(cfg);
  const h = await buildApp({ config, logger, store, coaching: coachingBinding, createLiveRecognizer: () => null, liveLlm, loadReplay, listOfflineScripts });
  handles.push(h);
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const addr = h.app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  h.setPort(port);
  const code = h.auth.issuePairingCode();
  const pr = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode: code, extensionId: ORIGIN.slice(19), clientName: 'e2e' }),
  });
  const token = ((await pr.json()) as { session: { token: string } }).session.token;
  const client = await connectClient(port, token);
  return { h, client, capture, token, code, port, store, config };
}

function startOffline(c: Client, over: Record<string, unknown> = {}) {
  c.send({
    type: 'session.start',
    purpose: '架空の業務診断（OFFLINE 再生）',
    customerName: '架空商事 テスト太郎',
    appliedFacts: [],
    mode: 'OFFLINE',
    selfCaptureEnabled: true,
    consentConfirmed: true,
    storage: 'memory_only',
    ...over,
  });
}

describe('OFFLINE session end-to-end over WebSocket', () => {
  it('works with zero API keys: replay → transcript → validated advice card labeled offline', async () => {
    const { client, h } = await setup({ offline: { script: 'demo-next-step', speed: 40, useAnthropic: false } }, null);
    startOffline(client);
    await waitFor(() => client.of('advice.card').length > 0, 8000);
    const st = client.of('status')[0]!;
    expect(st.mode).toBe('OFFLINE');
    expect(st.externalSending).toBe(false);
    expect(st.pipelines.stt).toMatchObject({ state: 'offline', reason: 'offline_mode' });
    const segs = client.of('transcript.segment');
    expect(segs.length).toBeGreaterThan(3);
    expect(segs.some((s) => s.isFinal && s.source === 'REMOTE')).toBe(true);
    const card = client.of('advice.card')[0]!.card;
    expect(AdviceCard.safeParse(card).success).toBe(true);
    expect(client.invalid).toEqual([]);
    client.send({ type: 'session.end', exportRequested: false });
    await waitFor(() => client.of('status').at(-1)?.lifecycle === 'ended');
    // OFFLINE ルールベースは外部呼び出しではないので使用量に計上しない
    expect(client.of('usage').at(-1)!.calls).toBe(0);
    expect(h.reviews.size).toBe(1);
  });

  it('start → replay → advice → pause stops external calls → resume → end → no further LLM calls (§16-1 #5)', async () => {
    const llm = new CountingLlm();
    const { client, h, config } = await setup(
      { offline: { script: 'demo-next-step', speed: 30, useAnthropic: true }, anthropic: { ...testConfig().anthropic, apiKey: FAKE_ANTHROPIC_KEY } },
      llm,
    );
    startOffline(client, { offlineUseAnthropic: true });
    await waitFor(() => client.of('advice.card').length > 0 && llm.calls > 0, 8000);
    expect(client.of('status').some((s) => s.externalSending)).toBe(true);
    const sid = client.of('status').at(-1)!.sessionId!;

    client.send({ type: 'analysis.pause' });
    await waitFor(() => client.of('status').at(-1)?.lifecycle === 'paused');
    await waitFor(() => llm.inflight === 0);
    const callsAtPause = llm.calls;
    const segsAtPause = client.of('transcript.segment').length;
    client.send({ type: 'advice.request', kind: 'rebuttal', requestId: 'p1' });
    await sleep(500);
    expect(llm.calls).toBe(callsAtPause);
    expect(client.of('transcript.segment').length).toBe(segsAtPause); // 再生も止まる
    expect(client.of('error').at(-1)).toMatchObject({ code: 'invalid_state', requestId: 'p1' });

    client.send({ type: 'analysis.resume' });
    await waitFor(() => client.of('transcript.segment').length > segsAtPause, 5000);

    client.send({ type: 'session.end', exportRequested: false });
    await waitFor(() => client.of('status').at(-1)?.lifecycle === 'ended');
    await waitFor(() => llm.inflight === 0);
    const callsAtEnd = llm.calls;
    const msgsAtEnd = client.msgs.length;
    client.send({ type: 'advice.request', kind: 'next_step', requestId: 'e1' });
    for (let i = 0; i < 3; i++) client.ws.send(audioFrame(sid, 'REMOTE', { seq: 10_000 + i, startMs: 500_000 + i * 100 }));
    await sleep(Math.ceil(5000 / config.offline.speed) + 300);
    expect(llm.calls).toBe(callsAtEnd);
    expect(client.msgs.slice(msgsAtEnd).filter((m) => m.type === 'transcript.segment' || m.type === 'advice.card')).toEqual([]);
    const runtime = [...h.runtimes][0];
    expect(runtime?.guard.llmAfterStop ?? 0).toBe(0);
    // usage は実 usage のみ（呼び出し単位で重複なし）
    const usage = client.of('usage').at(-1)!;
    expect(usage.calls).toBe(callsAtEnd);
    expect(usage.llmInputTokens).toBe(callsAtEnd * 100);
  });

  it('closing the socket with SESSION_RESUME_GRACE_MS=0 ends the session at once (no invisible capture)', async () => {
    const llm = new CountingLlm();
    const { client, h, capture } = await setup(
      {
        resumeGraceMs: 0,
        offline: { script: 'decline-respect', speed: 20, useAnthropic: true },
        anthropic: { ...testConfig().anthropic, apiKey: FAKE_ANTHROPIC_KEY },
      },
      llm,
    );
    startOffline(client, { offlineUseAnthropic: true });
    await waitFor(() => client.of('transcript.segment').length > 0, 5000);
    client.ws.close();
    await waitFor(() => h.reviews.size === 1, 3000);
    const calls = llm.calls;
    await sleep(800);
    expect(llm.calls).toBe(calls);
    expect(capture.text).toMatch(/"endReason":"connection_lost"/);
  });

  it('a dropped socket keeps the session; session.resume on a new socket continues the SAME session (screen share / window switch)', async () => {
    const { client, h, port, token, capture } = await setup({ resumeGraceMs: 5000, offline: { script: 'decline-respect', speed: 20, useAnthropic: false } }, null);
    startOffline(client);
    await waitFor(() => client.of('transcript.segment').length > 0, 5000);
    const sid = client.of('status').at(-1)!.sessionId!;
    client.ws.close();
    await sleep(300);
    expect(h.reviews.size).toBe(0); // まだ終わっていない
    const c2 = await connectClient(port, token);
    c2.send({ type: 'session.resume', sessionId: sid });
    await waitFor(() => c2.of('session.resumed').length === 1);
    expect(c2.of('session.resumed')[0]).toMatchObject({ sessionId: sid, ok: true });
    await waitFor(() => c2.of('status').length > 0);
    expect(c2.of('status').at(-1)).toMatchObject({ sessionId: sid, lifecycle: 'capturing' });
    // 同じ商談の続き: 新しい接続からの操作（手動ボタン）が同じ商談で処理される
    c2.send({ type: 'advice.request', kind: 'next_step', requestId: 'after-resume' });
    await waitFor(() => c2.of('advice.card').length > 0 || c2.of('error').length > 0, 4000);
    expect(c2.of('error').filter((e) => e.code === 'invalid_state')).toEqual([]);
    c2.send({ type: 'session.end', exportRequested: false, reason: 'user_end' });
    await waitFor(() => c2.of('session.ended').length === 1);
    expect(c2.of('session.ended')[0]).toMatchObject({ sessionId: sid, endReason: 'user_end' });
    expect(h.reviews.size).toBe(1);
    const log = capture.text;
    expect(log).toMatch(/session detached/);
    expect(log).toMatch(/session resumed/);
    expect(log).toMatch(/"endReason":"user_end"/);
  });

  it('two drops in a row: each session.resume moves the SAME session to the newest socket (messages go to the newest client only)', async () => {
    const { client, h, port, token } = await setup({ resumeGraceMs: 5000, offline: { script: 'decline-respect', speed: 20, useAnthropic: false } }, null);
    startOffline(client);
    await waitFor(() => client.of('status').some((s) => s.sessionId), 5000);
    const sid = client.of('status').at(-1)!.sessionId!;
    client.ws.close();
    await sleep(100);
    const c2 = await connectClient(port, token);
    c2.send({ type: 'session.resume', sessionId: sid });
    await waitFor(() => c2.of('session.resumed').length === 1);
    c2.ws.close();
    await sleep(100);
    expect(h.reviews.size).toBe(0);
    const c3 = await connectClient(port, token);
    c3.send({ type: 'session.resume', sessionId: sid });
    await waitFor(() => c3.of('session.resumed').length === 1);
    expect(c3.of('session.resumed')[0]!.ok).toBe(true);
    const c2Count = c2.msgs.length;
    c3.send({ type: 'session.end', exportRequested: false, reason: 'user_end' });
    await waitFor(() => c3.of('session.ended').length === 1);
    expect(c3.of('session.ended')[0]!.sessionId).toBe(sid);
    expect(c2.msgs.length).toBe(c2Count);
  });

  it('resume after the grace period is rejected and the session ended with endReason=connection_lost', async () => {
    const { client, h, port, token, capture } = await setup({ resumeGraceMs: 300, offline: { script: 'decline-respect', speed: 20, useAnthropic: false } }, null);
    startOffline(client);
    await waitFor(() => client.of('status').some((s) => s.sessionId), 5000);
    const sid = client.of('status').at(-1)!.sessionId!;
    client.ws.close();
    await waitFor(() => h.reviews.size === 1, 3000);
    expect(capture.text).toMatch(/"endReason":"connection_lost"/);
    const c2 = await connectClient(port, token);
    c2.send({ type: 'session.resume', sessionId: sid });
    await waitFor(() => c2.of('session.resumed').length === 1);
    expect(c2.of('session.resumed')[0]!.ok).toBe(false);
    expect(h.runtimes.size).toBe(1); // 新しい接続の分だけ
  });

  it('a half-open old socket is taken over by session.resume (the old socket is closed, the session keeps going)', async () => {
    const { client, port, token } = await setup({ resumeGraceMs: 5000, offline: { script: 'decline-respect', speed: 20, useAnthropic: false } }, null);
    startOffline(client);
    await waitFor(() => client.of('status').some((s) => s.sessionId), 5000);
    const sid = client.of('status').at(-1)!.sessionId!;
    const c2 = await connectClient(port, token);
    c2.send({ type: 'session.resume', sessionId: sid });
    await waitFor(() => c2.of('session.resumed').length === 1);
    expect(c2.of('session.resumed')[0]!.ok).toBe(true);
    await waitFor(() => client.ws.readyState === WebSocket.CLOSED, 3000);
    c2.send({ type: 'session.end', exportRequested: false, reason: 'call_left' });
    await waitFor(() => c2.of('session.ended').length === 1);
    expect(c2.of('session.ended')[0]!.endReason).toBe('call_left');
  });

  it('export only when requested: JSON + MD written to exports/, path available in review', async () => {
    const { client, config, port, token } = await setup({ offline: { script: 'decline-respect', speed: 40, useAnthropic: false } }, null);
    startOffline(client);
    await waitFor(() => client.of('transcript.segment').filter((s) => s.isFinal).length >= 3, 6000);
    const sid = client.of('status').at(-1)!.sessionId!;
    client.send({ type: 'session.end', exportRequested: true });
    await waitFor(() => client.of('session.ended').length === 1);
    const ended = client.of('session.ended')[0]!;
    expect(ended.sessionId).toBe(sid);
    expect(ended.exportPath).toMatch(/\.json$/);
    expect(ended.reviewAvailableUntil).toBeGreaterThan(Date.now());
    // session.ended は終了処理の最後（status ended の後）に届く
    expect(client.msgs.findIndex((m) => m.type === 'session.ended')).toBeGreaterThan(
      client.msgs.findIndex((m) => m.type === 'status' && m.lifecycle === 'ended'),
    );
    const files = readdirSync(config.exportDir);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.md'))).toHaveLength(1);
    const md = readFileSync(`${config.exportDir}/${files.find((f) => f.endsWith('.md'))}`, 'utf8');
    expect(md).toContain('機密情報を含む可能性');
    const review = await fetch(`http://127.0.0.1:${port}/sessions/${sid}/review`, { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } });
    expect(review.status).toBe(200);
    const body = SessionReviewResponse.parse(await review.json());
    expect(body.exportPath).toBe(ended.exportPath);
  });

  it('no export → nothing written', async () => {
    const { client, config } = await setup({ offline: { script: 'decline-respect', speed: 40, useAnthropic: false } }, null);
    startOffline(client);
    await waitFor(() => client.of('transcript.segment').length > 0, 5000);
    client.send({ type: 'session.end', exportRequested: false });
    await waitFor(() => client.of('session.ended').length === 1);
    expect(client.of('session.ended')[0]!.exportPath).toBeNull();
    expect(existsSync(config.exportDir)).toBe(false);
  });

  it('GET /offline/scripts lists scripts (no transcript text); offlineScriptId picks the script; unknown id is rejected', async () => {
    const { client, port, token, h } = await setup({ offline: { script: 'decline-respect', speed: 40, useAnthropic: false } }, null);
    const res = await fetch(`http://127.0.0.1:${port}/offline/scripts`, { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const list = OfflineScriptsResponse.parse(await res.json());
    expect(list.scripts.map((s) => s.id)).toEqual(['decline-respect', 'demo-next-step', 'price-and-cancellation']);
    expect(list.defaultId).toBe('decline-respect');
    const firstLine = loadReplayScript('demo-next-step').lines.find((l) => l.isFinal)!.text;
    expect(JSON.stringify(list)).not.toContain(firstLine);
    const noAuth = await fetch(`http://127.0.0.1:${port}/offline/scripts`, { headers: { origin: ORIGIN } });
    expect(noAuth.status).toBe(401);

    startOffline(client, { offlineScriptId: 'no-such-script' });
    await waitFor(() => client.of('error').length > 0);
    expect(client.of('error')[0]).toMatchObject({ code: 'invalid_message' });
    expect(client.of('status')).toEqual([]);

    startOffline(client, { offlineScriptId: 'demo-next-step' });
    await waitFor(() => client.of('transcript.segment').some((s) => s.isFinal), 5000);
    expect(client.of('transcript.segment').find((s) => s.isFinal)!.text).toBe(firstLine);
    expect(h.runtimes.size).toBe(1);
  });

  it('offlineUseAnthropic is ignored unless the server allows it (env) and has a key; LIVE rejects offline-only fields', async () => {
    const llm = new CountingLlm();
    const { client } = await setup(
      { offline: { script: 'demo-next-step', speed: 40, useAnthropic: false }, anthropic: { ...testConfig().anthropic, apiKey: FAKE_ANTHROPIC_KEY } },
      llm,
    );
    client.send({
      type: 'session.start',
      purpose: 'x',
      appliedFacts: [],
      mode: 'LIVE',
      selfCaptureEnabled: false,
      consentConfirmed: true,
      offlineScriptId: 'demo-next-step',
    });
    await waitFor(() => client.of('error').length > 0);
    expect(client.of('error')[0]).toMatchObject({ code: 'invalid_message' });

    startOffline(client, { offlineUseAnthropic: true });
    await waitFor(() => client.of('advice.card').length > 0, 8000);
    expect(llm.calls).toBe(0); // env が許可していないので外部 LLM は使わない
    expect(client.of('status').every((s) => !s.externalSending)).toBe(true);
    expect(client.of('advice.card')[0]!.card.briefReason).toContain('[OFFLINE規則]');
  });

  it('OFFLINE ignores the real mic speaking state (cards are not held back by the user talking during a replay)', async () => {
    const { client } = await setup({ offline: { script: 'demo-next-step', speed: 40, useAnthropic: false } }, null);
    startOffline(client);
    await waitFor(() => client.of('status').length > 0);
    client.send({ type: 'speaking.state', source: 'SELF', speaking: true, atMs: 0 });
    await waitFor(() => client.of('advice.card').some((c) => c.card.action === 'show'), 8000);
  });

  it('advice.displayed records the display step (server clock); audio.gap is recorded in the review', async () => {
    const { client, port, token } = await setup({ offline: { script: 'demo-next-step', speed: 40, useAnthropic: false } }, null);
    startOffline(client);
    await waitFor(() => client.of('advice.card').length > 0, 8000);
    const sid = client.of('status').at(-1)!.sessionId!;
    const card = client.of('advice.card')[0]!.card;
    client.send({ type: 'advice.displayed', adviceId: card.adviceId, at: Date.now() });
    client.send({ type: 'advice.displayed', adviceId: card.adviceId, at: Date.now() }); // 重複は数えない
    client.send({ type: 'advice.displayed', adviceId: 'adv_unknown', at: Date.now() });
    client.send({ type: 'audio.gap', source: 'SELF', fromMs: 1000, toMs: 1600, reason: 'client_backpressure' });
    client.send({ type: 'audio.gap', source: 'SELF', fromMs: 2000, toMs: 1000, reason: 'client_backpressure' }); // 不正
    await waitFor(() => client.of('error').length > 0);
    expect(client.of('error').at(-1)).toMatchObject({ code: 'invalid_message' });
    const live = await fetch(`http://127.0.0.1:${port}/sessions/active/latency`, { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } });
    const stats = ((await live.json()) as { sessions: Array<{ latency: { counts: { displayAcked: number }; sentToDisplayedMs: { n: number } } }> })
      .sessions[0]!.latency;
    expect(stats.counts.displayAcked).toBe(1);
    expect(stats.sentToDisplayedMs.n).toBe(1);
    client.send({ type: 'session.end', exportRequested: false });
    await waitFor(() => client.of('session.ended').length === 1);
    const review = SessionReviewResponse.parse(
      await (await fetch(`http://127.0.0.1:${port}/sessions/${sid}/review`, { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } })).json(),
    );
    expect(review.audioGaps).toEqual([{ source: 'SELF', fromMs: 1000, toMs: 1600, droppedMs: 600, origin: 'client', reason: 'client_backpressure' }]);
    expect(review.latency.counts.displayAcked).toBe(1);
  });
});

describe('log leak check (§16-1 #15)', () => {
  it('OFFLINE session logs contain no transcript text, customer name, purpose, tokens, pairing code or API keys', async () => {
    const llm = new CountingLlm();
    const { client, capture, token, code } = await setup(
      {
        offline: { script: 'price-and-cancellation', speed: 40, useAnthropic: true },
        anthropic: { ...testConfig().anthropic, apiKey: FAKE_ANTHROPIC_KEY },
        deepgram: { ...testConfig().deepgram, apiKey: FAKE_DEEPGRAM_KEY },
      },
      llm,
    );
    startOffline(client, { offlineUseAnthropic: true });
    await waitFor(() => client.of('advice.card').length > 0, 8000);
    // 異常系のログも出させる
    client.send({ type: 'card.pin', adviceId: 'nope' });
    client.ws.send('{"type":"bogus"}');
    client.send({ type: 'feedback', adviceId: client.of('advice.card')[0]!.card.adviceId, rating: 'helpful' });
    client.send({ type: 'session.end', exportRequested: false });
    await waitFor(() => client.of('status').at(-1)?.lifecycle === 'ended');
    await sleep(50);

    const log = capture.text;
    if (process.env.DUMP_LOG) console.log(log);
    expect(capture.lines.length).toBeGreaterThan(3);
    const secrets = [FAKE_ANTHROPIC_KEY, FAKE_DEEPGRAM_KEY, token, '架空商事', 'テスト太郎', '架空の業務診断'];
    for (const s of secrets) expect(log).not.toContain(s);
    expect(log).not.toMatch(new RegExp(`\\b${code}\\b`));
    const script = loadReplayScript('price-and-cancellation');
    const texts = new Set(script.lines.filter((l) => l.isFinal).map((l) => l.text));
    for (const t of texts) {
      // 発話本文の一部（8文字以上の断片）もログに現れない
      for (let i = 0; i + 8 <= t.length; i += 4) expect(log).not.toContain(t.slice(i, i + 8));
    }
    for (const c of client.of('advice.card')) {
      if (c.card.say) expect(log).not.toContain(c.card.say);
      if (c.card.headline.length >= 6) expect(log).not.toContain(c.card.headline);
    }
  });
});
