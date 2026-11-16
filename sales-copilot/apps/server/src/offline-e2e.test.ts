import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AdviceCard, parseServerMessage, type ServerMessage } from '@sales-copilot/contracts';
import { loadReplayScript } from '@sales-copilot/test-fixtures';
import { buildApp, type AppHandle } from './app';
import { coachingBinding } from './coaching-binding';
import type { ServerConfig } from './config';
import { loadReplay } from './main';
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

async function setup(cfg: Partial<ServerConfig>, liveLlm: CountingLlm | null) {
  const { logger, capture } = testLogger('debug');
  const store = new Store(':memory:');
  const config = testConfig(cfg);
  const h = await buildApp({ config, logger, store, coaching: coachingBinding, createLiveRecognizer: () => null, liveLlm, loadReplay });
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
    startOffline(client);
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

  it('closing the socket ends the session (no invisible capture)', async () => {
    const llm = new CountingLlm();
    const { client, h } = await setup(
      { offline: { script: 'decline-respect', speed: 20, useAnthropic: true }, anthropic: { ...testConfig().anthropic, apiKey: FAKE_ANTHROPIC_KEY } },
      llm,
    );
    startOffline(client);
    await waitFor(() => client.of('transcript.segment').length > 0, 5000);
    client.ws.close();
    await waitFor(() => h.reviews.size === 1, 3000);
    const calls = llm.calls;
    await sleep(800);
    expect(llm.calls).toBe(calls);
  });

  it('export only when requested: JSON + MD written to exports/, path available in review', async () => {
    const { client, config, port, token } = await setup({ offline: { script: 'decline-respect', speed: 40, useAnthropic: false } }, null);
    startOffline(client);
    await waitFor(() => client.of('transcript.segment').filter((s) => s.isFinal).length >= 3, 6000);
    const sid = client.of('status').at(-1)!.sessionId!;
    client.send({ type: 'session.end', exportRequested: true });
    await waitFor(() => client.of('status').at(-1)?.lifecycle === 'ended');
    const files = readdirSync(config.exportDir);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('.md'))).toHaveLength(1);
    const md = readFileSync(`${config.exportDir}/${files.find((f) => f.endsWith('.md'))}`, 'utf8');
    expect(md).toContain('機密情報を含む可能性');
    const review = await fetch(`http://127.0.0.1:${port}/sessions/${sid}/review`, { headers: { origin: ORIGIN, authorization: `Bearer ${token}` } });
    expect(review.status).toBe(200);
    expect(((await review.json()) as { exportPath: string }).exportPath).toMatch(/\.json$/);
  });

  it('no export → nothing written', async () => {
    const { client, config } = await setup({ offline: { script: 'decline-respect', speed: 40, useAnthropic: false } }, null);
    startOffline(client);
    await waitFor(() => client.of('transcript.segment').length > 0, 5000);
    client.send({ type: 'session.end', exportRequested: false });
    await waitFor(() => client.of('status').at(-1)?.lifecycle === 'ended');
    expect(existsSync(config.exportDir)).toBe(false);
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
    startOffline(client);
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
