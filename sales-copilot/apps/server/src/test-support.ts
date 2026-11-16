/**
 * テスト用の組み立て（実 API は呼ばない）。通常起動からは import しない。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { RuleBasedOfflineLlm } from '@sales-copilot/coaching';
import { encodeAudioFrame, type CaptureSource, type ServerMessage } from '@sales-copilot/contracts';
import { AdviceLlmError, FakeSpeechRecognizer, type AdviceLlm, type AdviceLlmRequest, type AdviceLlmResponse } from '@sales-copilot/providers';
import { coachingBinding } from './coaching-binding';
import { loadConfig, type ServerConfig } from './config';
import { createLogger } from './logger';
import { loadReplay } from './main';
import { SessionRuntime } from './session-runtime';
import { Store } from './store';

export const FAKE_ANTHROPIC_KEY = 'sk-ant-test-LEAKCHECK-6f1d2a9c0b7e4f13';
export const FAKE_DEEPGRAM_KEY = 'dg-test-LEAKCHECK-91c0aa3e5d7b';
export const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const OTHER_EXT_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
export const ORIGIN = `chrome-extension://${EXT_ID}`;

export function testConfig(over: Partial<ServerConfig> = {}, env: Record<string, string> = {}): ServerConfig {
  const dir = mkdtempSync(path.join(tmpdir(), 'sc-server-'));
  const base = loadConfig({ PORT: '8787', ...env });
  return {
    ...base,
    dataDir: path.join(dir, 'data'),
    exportDir: path.join(dir, 'exports'),
    advice: { ...base.advice, cooldownMs: 0, manualMinIntervalMs: 0 },
    usageIntervalMs: 500,
    ...over,
  };
}

export class LogCapture extends Writable {
  readonly lines: string[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
    cb();
  }
  get text(): string {
    return this.lines.join('\n');
  }
}

export function testLogger(level = 'debug') {
  const capture = new LogCapture();
  return { logger: createLogger({ level, destination: capture }), capture };
}

/** 呼び出し回数を数える LLM（外部 LLM の代役）。 */
export class CountingLlm implements AdviceLlm {
  calls = 0;
  inflight = 0;
  constructor(
    private readonly impl: (req: AdviceLlmRequest, n: number) => Promise<AdviceLlmResponse> = (req) => new RuleBasedOfflineLlm().complete(req),
  ) {}
  async complete(req: AdviceLlmRequest): Promise<AdviceLlmResponse> {
    this.calls++;
    this.inflight++;
    try {
      const r = await this.impl(req, this.calls);
      return { ...r, usage: { inputTokens: 100, outputTokens: 20 } };
    } finally {
      this.inflight--;
    }
  }
}

export function failingLlm(kind: ConstructorParameters<typeof AdviceLlmError>[0]): CountingLlm {
  return new CountingLlm(async () => {
    throw new AdviceLlmError(kind, `fake ${kind}`);
  });
}

export function hangingLlm(): CountingLlm {
  return new CountingLlm(
    (req) =>
      new Promise((_res, rej) => {
        req.signal.addEventListener('abort', () => rej(new AdviceLlmError('aborted', 'aborted')), { once: true });
      }),
  );
}

export interface RuntimeHarness {
  runtime: SessionRuntime;
  messages: ServerMessage[];
  recognizers: Map<CaptureSource, FakeSpeechRecognizer[]>;
  store: Store;
  config: ServerConfig;
  rec(source: CaptureSource): FakeSpeechRecognizer;
  ofType<T extends ServerMessage['type']>(t: T): Extract<ServerMessage, { type: T }>[];
}

export function runtimeHarness(opts: { llm?: AdviceLlm | null; config?: Partial<ServerConfig>; withStt?: boolean } = {}): RuntimeHarness {
  const config = testConfig({
    ...opts.config,
    deepgram: { ...testConfig().deepgram, apiKey: opts.withStt === false ? null : FAKE_DEEPGRAM_KEY },
  });
  const messages: ServerMessage[] = [];
  const recognizers = new Map<CaptureSource, FakeSpeechRecognizer[]>();
  const store = new Store(':memory:');
  const { logger } = testLogger('silent');
  const runtime = new SessionRuntime({
    config,
    logger,
    store,
    coaching: coachingBinding,
    createLiveRecognizer: (source) => {
      if (!config.deepgram.apiKey) return null;
      const r = new FakeSpeechRecognizer({ source });
      const list = recognizers.get(source) ?? [];
      list.push(r);
      recognizers.set(source, list);
      return r;
    },
    liveLlm: opts.llm === undefined ? new CountingLlm() : opts.llm,
    loadReplay,
    send: (m) => messages.push(m),
  });
  return {
    runtime,
    messages,
    recognizers,
    store,
    config,
    rec: (s) => {
      const l = recognizers.get(s);
      if (!l || l.length === 0) throw new Error(`no recognizer for ${s}`);
      return l[l.length - 1]!;
    },
    ofType: (t) => messages.filter((m) => m.type === t) as never,
  };
}

let seq = 0;
/** 100ms の無音 PCM フレーム。 */
export function audioFrame(sessionId: string, source: CaptureSource, opts: { gen?: number; seq?: number; startMs?: number } = {}): Uint8Array {
  const s = opts.seq ?? ++seq;
  return encodeAudioFrame(
    {
      sessionId,
      source,
      streamGeneration: opts.gen ?? 0,
      sequence: s,
      audioStartMs: opts.startMs ?? s * 100,
      durationMs: 100,
      sampleRate: 16000,
      encoding: 'pcm16le',
      channels: 1,
    },
    new Int16Array(1600),
  );
}

export async function waitFor(cond: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
