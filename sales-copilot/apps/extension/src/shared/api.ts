/**
 * ローカルサーバーの HTTP クライアント（薄く、ここだけに隔離）。
 * 要求・応答は全て @sales-copilot/contracts のスキーマで検証する（サーバーも同じスキーマで返す）。
 * 形が違えば invalid_response（「確認できません」）として扱い、推測で埋めない。
 * トークンは AUTH_HEADER（Authorization: Bearer）でのみ送り、URL クエリには載せない。
 */
import {
  AUTH_HEADER,
  AUTH_SCHEME,
  ConfigStatusResponse,
  FactCreateRequest,
  FactResponse,
  FactsListResponse,
  FactUpdateResponse,
  LearningOkResponse,
  LearningOverviewResponse,
  LearningSettings,
  OfflineScriptsResponse,
  ProposalEstimateResponse,
  ProposalGenerateResponse,
  RuleResponse,
  type LearningSettingsPatch,
  type RuleScope,
  PairingRequest,
  PairingResponse,
  SessionReviewResponse,
  type ApprovedFact,
  type FactCategory,
  type SessionToken,
} from '@sales-copilot/contracts';
import { z } from 'zod';

export type ApiError =
  | { kind: 'network' } // 通信断・サーバー未起動
  | { kind: 'unauthorized' }
  | { kind: 'not_found' }
  | { kind: 'http'; status: number }
  | { kind: 'invalid_response' }
  /** サーバーが理由つきで断った（学習の承認でルール文が通らない等）。message はそのまま表示してよい日本語。 */
  | { kind: 'rejected'; code: string; message: string | null };

const ServerErrorBody = z.object({ error: z.string().max(64), message: z.string().max(300).optional() });

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface ApiClientOptions {
  baseUrl: string;
  token: string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ApiClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: ApiClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    opts: { bodyOnError?: boolean; timeoutMs?: number } = {},
  ): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.opts.token) headers[AUTH_HEADER] = `${AUTH_SCHEME} ${this.opts.token}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? this.opts.timeoutMs ?? 5000);
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.opts.baseUrl).toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      return { ok: false, error: { kind: 'network' } };
    } finally {
      clearTimeout(timer);
    }
    if (!opts.bodyOnError) {
      if (res.status === 401 || res.status === 403) return { ok: false, error: { kind: 'unauthorized' } };
      if (res.status === 404) return { ok: false, error: { kind: 'not_found' } };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: res.ok ? { kind: 'invalid_response' } : { kind: 'http', status: res.status } };
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return { ok: true, data: parsed.data };
    if (!res.ok) {
      const err = ServerErrorBody.safeParse(json);
      if (err.success) return { ok: false, error: { kind: 'rejected', code: err.data.error, message: err.data.message ?? null } };
    }
    return { ok: false, error: res.ok ? { kind: 'invalid_response' } : { kind: 'http', status: res.status } };
  }

  health(): Promise<ApiResult<unknown>> {
    return this.request('GET', '/health', z.unknown());
  }

  configStatus(): Promise<ApiResult<ConfigStatusResponse>> {
    return this.request('GET', '/config/status', ConfigStatusResponse);
  }

  /**
   * PairingResponse の ok:false（コード違い・期限切れ・使用済み・試行超過）は 401/403/409/429 で返るため、
   * ステータスより本文を優先して読む（「認証できません」と一括りにしない）。
   */
  async pair(req: PairingRequest): Promise<ApiResult<PairingResponse>> {
    const body = PairingRequest.parse(req);
    return this.request('POST', '/pair', PairingResponse, body, { bodyOnError: true });
  }

  async listFacts(): Promise<ApiResult<ApprovedFact[]>> {
    const r = await this.request('GET', '/facts', FactsListResponse);
    return r.ok ? { ok: true, data: r.data.facts } : r;
  }

  async createFact(input: FactInput): Promise<ApiResult<ApprovedFact>> {
    const r = await this.request('POST', '/facts', FactResponse, FactCreateRequest.parse(input));
    return r.ok ? { ok: true, data: r.data.fact } : r;
  }

  /** 承認済みを編集すると旧承認は失効し、サーバー側で未確認・新バージョンになる（SPEC §13）。 */
  async updateFact(factId: string, input: FactInput): Promise<ApiResult<ApprovedFact>> {
    const r = await this.request('PATCH', `/facts/${encodeURIComponent(factId)}`, FactUpdateResponse, input);
    return r.ok ? { ok: true, data: r.data.fact } : r;
  }

  /** 終了後の振り返り（session.ended を受け取れなかった場合の確認用）。保持期限を過ぎると not_found。 */
  sessionReview(sessionId: string): Promise<ApiResult<SessionReviewResponse>> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/review`, SessionReviewResponse);
  }

  /** OFFLINE テストで選べる架空会話スクリプト。 */
  offlineScripts(): Promise<ApiResult<OfflineScriptsResponse>> {
    return this.request('GET', '/offline/scripts', OfflineScriptsResponse);
  }

  /** 学習 API 用の汎用呼び出し（スキーマ検証・理由つきエラーを含む）。 */
  call<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown, timeoutMs?: number): Promise<ApiResult<T>> {
    return this.request(method, path, schema, body, timeoutMs ? { timeoutMs } : {});
  }

  async approveFact(factId: string, version: number): Promise<ApiResult<ApprovedFact>> {
    const r = await this.request('POST', `/facts/${encodeURIComponent(factId)}/approve`, FactResponse, { version });
    return r.ok ? { ok: true, data: r.data.fact } : r;
  }
}

// --- 学習（承認制） -------------------------------------------------------------
export class LearningApi {
  constructor(private readonly api: ApiClient) {}

  overview(): Promise<ApiResult<LearningOverviewResponse>> {
    return this.api.call('GET', '/learning', LearningOverviewResponse);
  }

  updateSettings(patch: LearningSettingsPatch): Promise<ApiResult<LearningSettings>> {
    return this.api.call('PATCH', '/learning/settings', LearningSettings, patch);
  }

  estimate(): Promise<ApiResult<ProposalEstimateResponse>> {
    return this.api.call('POST', '/learning/proposals/estimate', ProposalEstimateResponse, {});
  }

  /** モデル呼び出しを待つので長めに待つ。 */
  generate(): Promise<ApiResult<ProposalGenerateResponse>> {
    return this.api.call('POST', '/learning/proposals/generate', ProposalGenerateResponse, {}, 60_000);
  }

  approve(proposalId: string, edit: { text?: string; scope?: RuleScope } = {}): Promise<ApiResult<RuleResponse>> {
    return this.api.call('POST', `/learning/proposals/${encodeURIComponent(proposalId)}/approve`, RuleResponse, edit);
  }

  reject(proposalId: string): Promise<ApiResult<LearningOkResponse>> {
    return this.api.call('POST', `/learning/proposals/${encodeURIComponent(proposalId)}/reject`, LearningOkResponse, {});
  }

  setRuleEnabled(ruleId: string, enabled: boolean): Promise<ApiResult<LearningOkResponse>> {
    return this.api.call('POST', `/learning/rules/${encodeURIComponent(ruleId)}/${enabled ? 'enable' : 'disable'}`, LearningOkResponse, {});
  }

  deleteRule(ruleId: string): Promise<ApiResult<LearningOkResponse>> {
    return this.api.call('POST', `/learning/rules/${encodeURIComponent(ruleId)}/delete`, LearningOkResponse, {});
  }

  wipe(): Promise<ApiResult<LearningOkResponse>> {
    return this.api.call('POST', '/learning/wipe', LearningOkResponse, {});
  }
}

export interface FactInput {
  category: FactCategory;
  value: string;
  scope: string;
  sourceNote: string;
}

export function describeApiError(e: ApiError): string {
  switch (e.kind) {
    case 'network':
      return 'ローカルサーバーに接続できません（起動していない・URL違い・通信断）';
    case 'unauthorized':
      return '認証できません（ペアリングが切れています）';
    case 'not_found':
      return 'サーバーがこの機能に対応していません';
    case 'http':
      return `サーバーエラー（${e.status}）`;
    case 'invalid_response':
      return 'サーバーの応答形式が想定と違います';
    case 'rejected':
      return e.message ?? `サーバーが受け付けませんでした（${e.code}）`;
  }
}

export function clientFromSettings(s: { serverUrl: string; session: SessionToken | null }): ApiClient {
  return new ApiClient({ baseUrl: s.serverUrl, token: s.session?.token ?? null });
}
