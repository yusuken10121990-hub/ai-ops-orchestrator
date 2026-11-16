import { describe, expect, it } from 'vitest';
import {
  AUDIO_BYTES_PER_MS,
  AdviceCard,
  AdviceLlmOutput,
  ApprovedFact,
  AudioFrameError,
  ClientMessage,
  PairingRequest,
  ServerMessage,
  SessionToken,
  decodeAudioFrame,
  encodeAudioFrame,
  parseClientMessage,
  pcmBytesToInt16,
  type AudioFrameHeader,
} from './index';

const header = (over: Partial<AudioFrameHeader> = {}): AudioFrameHeader => ({
  sessionId: 's1',
  source: 'REMOTE',
  streamGeneration: 0,
  sequence: 3,
  audioStartMs: 300,
  durationMs: 100,
  sampleRate: 16000,
  encoding: 'pcm16le',
  channels: 1,
  ...over,
});

describe('audio frame codec', () => {
  it('round-trips header and PCM (Int16Array input, little-endian)', () => {
    const samples = new Int16Array(1600);
    for (let i = 0; i < samples.length; i++) samples[i] = (i * 37) % 30000 - 15000;
    const buf = encodeAudioFrame(header(), samples);
    const { header: h, pcm } = decodeAudioFrame(buf);
    expect(h).toEqual(header());
    expect(pcm.byteLength).toBe(100 * AUDIO_BYTES_PER_MS);
    expect(Array.from(pcmBytesToInt16(pcm))).toEqual(Array.from(samples));
  });

  it('accepts ArrayBuffer and offset views', () => {
    const buf = encodeAudioFrame(header(), new Uint8Array(3200));
    const padded = new Uint8Array(buf.byteLength + 3);
    padded.set(buf, 3);
    expect(decodeAudioFrame(padded.subarray(3)).header.sequence).toBe(3);
    expect(decodeAudioFrame(buf.slice().buffer).header.sequence).toBe(3);
  });

  it('rejects mislabeled sample rate (48kHz labeled 16kHz) via duration mismatch', () => {
    // 100ms of 48kHz audio = 4800 samples; claiming 16kHz/100ms must fail.
    expect(() => encodeAudioFrame(header(), new Int16Array(4800))).toThrow(AudioFrameError);
    expect(() => encodeAudioFrame({ ...header(), sampleRate: 48000 as 16000 }, new Int16Array(1600))).toThrow(
      AudioFrameError,
    );
  });

  it('rejects corrupt frames', () => {
    expect(() => decodeAudioFrame(new Uint8Array(2))).toThrow(/too short/);
    const bad = new Uint8Array(10);
    new DataView(bad.buffer).setUint32(0, 6, true);
    bad.set(new TextEncoder().encode('{nope}'), 4);
    try {
      decodeAudioFrame(bad);
      expect.unreachable();
    } catch (e) {
      expect((e as AudioFrameError).code).toBe('header_not_json');
    }
    const odd = encodeAudioFrame(header(), new Uint8Array(3200));
    expect(() => decodeAudioFrame(odd.subarray(0, odd.byteLength - 1))).toThrow(AudioFrameError);
  });
});

const llm = {
  action: 'show',
  kind: 'clarify',
  headline: '費用の前提を確認',
  say: '月額の想定範囲を先に確認させてください。',
  avoid: '金額を言い切らない',
  briefReason: '価格条件が未承認',
  evidenceUtteranceIds: ['u1'],
  approvedFactIds: [],
  missingItems: ['月額費用'],
  evidenceLevel: 'tentative',
  nextStepType: 'clarify',
} as const;

describe('advice schemas', () => {
  it('accepts valid LLM output and enforces limits', () => {
    expect(AdviceLlmOutput.safeParse(llm).success).toBe(true);
    expect(AdviceLlmOutput.safeParse({ ...llm, say: 'あ'.repeat(181) }).success).toBe(false);
    expect(AdviceLlmOutput.safeParse({ ...llm, headline: 'あ'.repeat(31) }).success).toBe(false);
    expect(AdviceLlmOutput.safeParse({ ...llm, avoid: 'あ'.repeat(41) }).success).toBe(false);
    expect(AdviceLlmOutput.safeParse({ ...llm, action: 'speak' }).success).toBe(false);
    expect(AdviceLlmOutput.safeParse({ ...llm, extra: 1 }).success).toBe(false);
    expect(AdviceLlmOutput.safeParse({ ...llm, headline: '' }).success).toBe(false);
    expect(AdviceLlmOutput.safeParse({ ...llm, action: 'none', headline: '', say: null, avoid: null }).success).toBe(
      true,
    );
  });

  it('AdviceCard requires app-assigned fields', () => {
    const card = {
      ...llm,
      adviceId: 'a1',
      sessionId: 's1',
      contextRevision: 2,
      promptVersion: 'p1',
      createdAt: 1000,
      expiresAt: 9000,
      trigger: 'auto',
      status: 'current',
      warnings: [],
    };
    expect(AdviceCard.safeParse(card).success).toBe(true);
    expect(AdviceCard.safeParse({ ...card, adviceId: undefined }).success).toBe(false);
  });
});

describe('facts & auth', () => {
  it('approved fact requires approvedAt', () => {
    const f = {
      factId: 'f1',
      category: 'price_monthly',
      value: '要確認',
      scope: 'all',
      sourceNote: '',
      approvedAt: null,
      version: 1,
      status: 'unverified',
    };
    expect(ApprovedFact.safeParse(f).success).toBe(true);
    expect(ApprovedFact.safeParse({ ...f, status: 'approved' }).success).toBe(false);
  });

  it('pairing and token shapes', () => {
    expect(PairingRequest.safeParse({ pairingCode: '123456', extensionId: 'a'.repeat(32), clientName: 'x' }).success).toBe(
      true,
    );
    expect(PairingRequest.safeParse({ pairingCode: '12345', extensionId: 'a'.repeat(32), clientName: 'x' }).success).toBe(
      false,
    );
    const t = { token: 'x'.repeat(43), tokenType: 'Bearer', issuedAt: 1, expiresAt: 2, scopes: ['session'] };
    expect(SessionToken.safeParse(t).success).toBe(true);
    expect(SessionToken.safeParse({ ...t, expiresAt: 0 }).success).toBe(false);
  });
});

describe('ws messages', () => {
  it('session.start requires literal consentConfirmed=true', () => {
    const base = {
      type: 'session.start',
      purpose: '業務診断',
      appliedFacts: [{ factId: 'f1', version: 2 }],
      mode: 'OFFLINE',
      selfCaptureEnabled: true,
      consentConfirmed: true,
    };
    const ok = ClientMessage.safeParse(base);
    expect(ok.success).toBe(true);
    if (ok.success && ok.data.type === 'session.start') expect(ok.data.storage).toBe('memory_only');
    expect(ClientMessage.safeParse({ ...base, consentConfirmed: false }).success).toBe(false);
    expect(ClientMessage.safeParse({ ...base, consentConfirmed: 'true' }).success).toBe(false);
  });

  it('source.state distinguishes SELF on/off from REMOTE ok/lost', () => {
    expect(ClientMessage.safeParse({ type: 'source.state', source: 'SELF', state: 'off' }).success).toBe(true);
    expect(ClientMessage.safeParse({ type: 'source.state', source: 'REMOTE', state: 'lost' }).success).toBe(true);
    expect(ClientMessage.safeParse({ type: 'source.state', source: 'SELF', state: 'lost' }).success).toBe(false);
  });

  it('parseClientMessage never throws', () => {
    expect(parseClientMessage('{').ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: 'advice.request', kind: 'next_step', requestId: 'r1' })).ok).toBe(
      true,
    );
    expect(parseClientMessage(JSON.stringify({ type: 'advice.request', kind: 'close_now', requestId: 'r1' })).ok).toBe(
      false,
    );
  });

  it('status distinguishes silence / no_permission / not_configured / disconnected', () => {
    const st = (state: string, reason: string | null) => ({ state, reason, since: 0 });
    const msg = {
      type: 'status',
      sessionId: 's1',
      lifecycle: 'capturing',
      mode: 'LIVE',
      externalSending: true,
      storage: 'memory_only',
      pipelines: {
        capture: { SELF: st('waiting', 'silence'), REMOTE: st('error', 'no_permission') },
        stt: st('not_configured', 'not_configured'),
        advice: st('offline', 'disconnected'),
      },
      at: 0,
    };
    expect(ServerMessage.safeParse(msg).success).toBe(true);
    const usage = {
      type: 'usage',
      sttSecondsBySource: { SELF: 1, REMOTE: 2, UNKNOWN: 0 },
      llmInputTokens: 10,
      llmOutputTokens: 5,
      calls: 1,
      estimatedCost: null,
      budget: { level: 'ok', metrics: [] },
    };
    expect(ServerMessage.safeParse(usage).success).toBe(true);
  });
});
