/**
 * ローカルサーバーの HTTP クライアント（薄く、ここだけに隔離）。
 * contracts にある形（PairingRequest/Response, ApprovedFact）は Zod で検証し、
 * 無い形（/config/status, /facts の作成・更新ボディ）は最小限の想定で送り、受信は緩く検証する。
 * トークンは AUTH_HEADER（Authorization: Bearer）でのみ送り、URL クエリには載せない。
 */
import {
  ApprovedFact,
  AUTH_HEADER,
  AUTH_SCHEME,
  PairingRequest,
  PairingResponse,
  type FactCategory,
  type SessionToken,
} from '@sales-copilot/contracts';
import { z } from 'zod';
import { ConfigStatusResponse, SessionReviewResponse } from './noncontract';

export type ApiError =
  | { kind: 'network' } // 通信断・サーバー未起動
  | { kind: 'unauthorized' }
  | { kind: 'not_found' }
  | { kind: 'http'; status: number }
  | { kind: 'invalid_response' };

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

  private async request<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.opts.token) headers[AUTH_HEADER] = `${AUTH_SCHEME} ${this.opts.token}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 5000);
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
    if (res.status === 401 || res.status === 403) return { ok: false, error: { kind: 'unauthorized' } };
    if (res.status === 404) return { ok: false, error: { kind: 'not_found' } };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { ok: false, error: res.ok ? { kind: 'invalid_response' } : { kind: 'http', status: res.status } };
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return { ok: true, data: parsed.data };
    return { ok: false, error: res.ok ? { kind: 'invalid_response' } : { kind: 'http', status: res.status } };
  }

  health(): Promise<ApiResult<unknown>> {
    return this.request('GET', '/health', z.unknown());
  }

  configStatus(): Promise<ApiResult<ConfigStatusResponse>> {
    return this.request('GET', '/config/status', ConfigStatusResponse);
  }

  /** PairingResponse は ok:false も 4xx で返る可能性があるため、本文を優先して読む。 */
  async pair(req: PairingRequest): Promise<ApiResult<PairingResponse>> {
    const body = PairingRequest.parse(req);
    return this.request('POST', '/pair', PairingResponse, body);
  }

  listFacts(): Promise<ApiResult<ApprovedFact[]>> {
    return this.request('GET', '/facts', FactsList);
  }

  createFact(input: FactInput): Promise<ApiResult<ApprovedFact>> {
    return this.request('POST', '/facts', FactOne, input);
  }

  /** 承認済みを編集すると旧承認は失効し、サーバー側で未確認・新バージョンになる（SPEC §13）。 */
  updateFact(factId: string, input: FactInput): Promise<ApiResult<ApprovedFact>> {
    return this.request('PATCH', `/facts/${encodeURIComponent(factId)}`, FactOne, input);
  }

  /** 終了後の振り返り（出力先パスの確認に使う）。保持期限を過ぎると not_found。 */
  sessionReview(sessionId: string): Promise<ApiResult<SessionReviewResponse>> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/review`, SessionReviewResponse);
  }

  approveFact(factId: string, version: number): Promise<ApiResult<ApprovedFact>> {
    return this.request('POST', `/facts/${encodeURIComponent(factId)}/approve`, FactOne, { version });
  }
}

export interface FactInput {
  category: FactCategory;
  value: string;
  scope: string;
  sourceNote: string;
}

/** 配列そのもの / { facts: [...] } のどちらでも受ける。 */
const FactsList = z.union([z.array(ApprovedFact), z.object({ facts: z.array(ApprovedFact) }).transform((v) => v.facts)]);
const FactOne = z.union([ApprovedFact, z.object({ fact: ApprovedFact }).transform((v) => v.fact)]);

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
  }
}

export function clientFromSettings(s: { serverUrl: string; session: SessionToken | null }): ApiClient {
  return new ApiClient({ baseUrl: s.serverUrl, token: s.session?.token ?? null });
}
