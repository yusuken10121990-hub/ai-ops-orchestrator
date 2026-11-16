import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BudgetLimits, PriceTable } from '@sales-copilot/contracts';
import { PriceTable as PriceTableSchema } from '@sales-copilot/contracts';

const here = path.dirname(fileURLToPath(import.meta.url));
/** sales-copilot ワークスペースのルート（apps/server/src → ../../..）。 */
export const WORKSPACE_ROOT = path.resolve(here, '../../..');

export interface ServerConfig {
  host: string;
  port: number;
  allowNonLoopback: boolean;
  /** 事前に許可する拡張機能ID（任意）。設定時はペアリングもこのIDに限定。 */
  allowedExtensionId: string | null;
  dataDir: string;
  exportDir: string;
  tokenTtlMs: number;
  pairingCodeTtlMs: number;
  pairingMaxAttempts: number;

  deepgram: {
    apiKey: string | null;
    model: string;
    language: string;
    endpointingMs: number | false;
    utteranceEndMs: number | null;
    smartFormat: boolean;
    punctuate: boolean;
  };
  anthropic: {
    apiKey: string | null;
    model: string;
    effort: 'low' | 'medium' | 'high' | null;
  };
  advice: {
    timeoutMs: number;
    maxRetries: number;
    cooldownMs: number;
    staleMs: number;
    manualMinIntervalMs: number;
  };
  conversationWindowMs: number;
  budget: BudgetLimits;
  priceTable: PriceTable | null;
  /** 解析停止/終了後に会話データ（振り返り用）をメモリに残す上限。 */
  retentionMs: number;
  /** 1系統あたりの未送信音声キュー上限（ms）。 */
  maxAudioQueueMs: number;
  offline: {
    /** 再生するスクリプト名（未指定なら先頭）。 */
    script: string | null;
    /** 再生速度倍率（1 = 実時間）。 */
    speed: number;
    /**
     * OFFLINE で Claude を使うことを許可する（OFFLINE_USE_ANTHROPIC=1）。実際に使うのは、キーがあり、
     * かつ本人がセッション開始時に offlineUseAnthropic=true を選んだときだけ。
     */
    useAnthropic: boolean;
  };
  usageIntervalMs: number;
  logLevel: string;
  /**
   * 自動テスト専用の固定ペアリングコード。NODE_ENV=test のときだけ有効（それ以外で設定されていたら起動を拒否）。
   */
  pairingCodeForTest: string | null;
}

type Env = Record<string, string | undefined>;

function str(env: Env, k: string): string | null {
  const v = env[k];
  return v === undefined || v.trim() === '' ? null : v.trim();
}

function int(env: Env, k: string, def: number): number {
  const v = str(env, k);
  if (v === null) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`invalid number for ${k}`);
  return n;
}

function optNum(env: Env, k: string): number | null {
  const v = str(env, k);
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid positive number for ${k}`);
  return n;
}

function bool(env: Env, k: string, def: boolean): boolean {
  const v = str(env, k);
  if (v === null) return def;
  return v === '1' || v.toLowerCase() === 'true';
}

/** PAIRING_CODE_FOR_TEST は NODE_ENV=test のときだけ受け付ける。本番起動で使われないよう、それ以外は起動エラー。 */
export function pairingCodeForTest(env: Env): string | null {
  const v = str(env, 'PAIRING_CODE_FOR_TEST');
  if (v === null) return null;
  if (env.NODE_ENV !== 'test') {
    throw new Error('PAIRING_CODE_FOR_TEST is only allowed when NODE_ENV=test (remove it from the environment / .env)');
  }
  if (!/^\d{6}$/.test(v)) throw new Error('PAIRING_CODE_FOR_TEST must be 6 digits');
  return v;
}

export function loadConfig(env: Env = process.env): ServerConfig {
  const endpointingRaw = str(env, 'DEEPGRAM_ENDPOINTING_MS');
  const utteranceEndRaw = str(env, 'DEEPGRAM_UTTERANCE_END_MS');
  const effortRaw = str(env, 'ANTHROPIC_EFFORT');
  const effort = effortRaw === null ? 'low' : effortRaw === 'none' ? null : effortRaw;
  if (effort !== null && !['low', 'medium', 'high'].includes(effort)) throw new Error('ANTHROPIC_EFFORT must be low|medium|high|none');

  let priceTable: PriceTable | null = null;
  const currency = str(env, 'PRICE_CURRENCY');
  if (currency) {
    const parsed = PriceTableSchema.safeParse({
      currency,
      source: str(env, 'PRICE_SOURCE') ?? '',
      checkedDate: str(env, 'PRICE_CHECKED_DATE') ?? '',
      sttPerMinute: optNum(env, 'PRICE_STT_PER_MINUTE'),
      llmInputPerMTok: optNum(env, 'PRICE_LLM_INPUT_PER_MTOK'),
      llmOutputPerMTok: optNum(env, 'PRICE_LLM_OUTPUT_PER_MTOK'),
    });
    // 出典・確認日が欠けた価格表は使わない（推測しない）
    priceTable = parsed.success ? parsed.data : null;
  }

  return {
    host: str(env, 'HOST') ?? '127.0.0.1',
    port: int(env, 'PORT', 8787),
    allowNonLoopback: str(env, 'ALLOW_NON_LOOPBACK') === '1',
    allowedExtensionId: str(env, 'ALLOWED_EXTENSION_ID'),
    dataDir: path.resolve(WORKSPACE_ROOT, str(env, 'DATA_DIR') ?? 'data'),
    exportDir: path.resolve(WORKSPACE_ROOT, str(env, 'EXPORT_DIR') ?? 'exports'),
    tokenTtlMs: int(env, 'SESSION_TOKEN_TTL_MS', 12 * 60 * 60 * 1000),
    pairingCodeTtlMs: int(env, 'PAIRING_CODE_TTL_MS', 10 * 60 * 1000),
    pairingMaxAttempts: int(env, 'PAIRING_MAX_ATTEMPTS', 5),
    deepgram: {
      apiKey: str(env, 'DEEPGRAM_API_KEY'),
      model: str(env, 'DEEPGRAM_MODEL') ?? 'nova-3',
      language: str(env, 'DEEPGRAM_LANGUAGE') ?? 'ja',
      endpointingMs: endpointingRaw === 'false' ? false : int(env, 'DEEPGRAM_ENDPOINTING_MS', 300),
      utteranceEndMs: utteranceEndRaw === 'off' ? null : int(env, 'DEEPGRAM_UTTERANCE_END_MS', 1000),
      smartFormat: bool(env, 'DEEPGRAM_SMART_FORMAT', true),
      punctuate: bool(env, 'DEEPGRAM_PUNCTUATE', false),
    },
    anthropic: {
      apiKey: str(env, 'ANTHROPIC_API_KEY'),
      model: str(env, 'ANTHROPIC_MODEL') ?? 'claude-haiku-5-5',
      effort: effort as 'low' | 'medium' | 'high' | null,
    },
    advice: {
      timeoutMs: int(env, 'ADVICE_TIMEOUT_MS', 6000),
      maxRetries: int(env, 'ADVICE_MAX_RETRIES', 1),
      cooldownMs: int(env, 'ADVICE_COOLDOWN_MS', 6000),
      staleMs: int(env, 'ADVICE_STALE_MS', 8000),
      manualMinIntervalMs: int(env, 'ADVICE_MANUAL_MIN_INTERVAL_MS', 1500),
    },
    conversationWindowMs: int(env, 'CONVERSATION_WINDOW_MS', 90_000),
    budget: {
      maxSttSeconds: optNum(env, 'SESSION_MAX_STT_SECONDS'),
      maxLlmCalls: optNum(env, 'SESSION_MAX_LLM_CALLS'),
      maxLlmInputTokens: optNum(env, 'SESSION_MAX_LLM_INPUT_TOKENS'),
      maxLlmOutputTokens: optNum(env, 'SESSION_MAX_LLM_OUTPUT_TOKENS'),
      maxCost: priceTable ? optNum(env, 'SESSION_MAX_COST') : null,
    },
    priceTable,
    retentionMs: int(env, 'SESSION_RETENTION_MS', 10 * 60 * 1000),
    maxAudioQueueMs: int(env, 'AUDIO_MAX_QUEUE_MS', 2000),
    offline: {
      script: str(env, 'OFFLINE_SCRIPT'),
      speed: int(env, 'OFFLINE_REPLAY_SPEED', 1),
      useAnthropic: str(env, 'OFFLINE_USE_ANTHROPIC') === '1',
    },
    usageIntervalMs: int(env, 'USAGE_INTERVAL_MS', 5000),
    logLevel: str(env, 'LOG_LEVEL') ?? 'info',
    pairingCodeForTest: pairingCodeForTest(env),
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(h: string): boolean {
  return LOOPBACK.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** 0.0.0.0 等の非ループバック bind は ALLOW_NON_LOOPBACK=1 の明示なしに拒否（SPEC §14）。 */
export function assertBindAllowed(cfg: Pick<ServerConfig, 'host' | 'allowNonLoopback'>): void {
  if (isLoopbackHost(cfg.host)) return;
  if (!cfg.allowNonLoopback) {
    throw new Error(`refusing to bind to non-loopback host "${cfg.host}". Set ALLOW_NON_LOOPBACK=1 to override explicitly.`);
  }
}

/** .env を読む（存在すれば）。既存の環境変数は上書きしない。 */
export function loadDotEnv(file = path.join(WORKSPACE_ROOT, '.env')): void {
  if (!existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch {
    // 読めない .env は無視（内容をログに出さない）
  }
}

/** 状態表示用: 設定の有無だけ（値は出さない）。 */
export function providerStatus(cfg: ServerConfig): {
  stt: { configured: boolean; provider: 'deepgram'; model: string; language: string };
  llm: { configured: boolean; provider: 'anthropic'; model: string };
  modes: { LIVE: boolean; OFFLINE: boolean };
  offlineAnthropicAvailable: boolean;
  priceTable: { configured: boolean; currency: string | null; checkedDate: string | null };
} {
  const stt = cfg.deepgram.apiKey !== null;
  const llm = cfg.anthropic.apiKey !== null;
  return {
    stt: { configured: stt, provider: 'deepgram', model: cfg.deepgram.model, language: cfg.deepgram.language },
    llm: { configured: llm, provider: 'anthropic', model: cfg.anthropic.model },
    modes: { LIVE: stt && llm, OFFLINE: true },
    offlineAnthropicAvailable: cfg.offline.useAnthropic && llm,
    priceTable: {
      configured: cfg.priceTable !== null,
      currency: cfg.priceTable?.currency ?? null,
      checkedDate: cfg.priceTable?.checkedDate ?? null,
    },
  };
}
