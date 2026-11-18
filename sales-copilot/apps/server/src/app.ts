import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type WebSocket from 'ws';
import {
  ConfigStatusResponse,
  FactApproveRequest,
  FactCreateRequest,
  FactPatchRequest,
  FactResponse,
  FactsListResponse,
  FactUpdateResponse,
  HelloMessage,
  OfflineScriptsResponse,
  SessionReviewResponse,
  type OfflineScriptInfo,
  PairingRequest,
  PROTOCOL_VERSION,
  parseClientMessage,
  type AuthScope,
  type CaptureSource,
  type ServerMessage,
} from '@sales-copilot/contracts';
import type { AdviceLlm, SpeechRecognizer } from '@sales-copilot/providers';
import { AuthManager, bearerToken, isAllowedHostHeader, parseExtensionOrigin, urlCarriesCredential } from './auth';
import type { CoachingPort } from './coaching-port';
import { registerLearningRoutes } from './learning-routes';
import { providerStatus, type ServerConfig } from './config';
import type { ReplayScript } from './replay';
import { SERVER_VERSION, SessionRuntime, type SessionReview } from './session-runtime';
import type { Store } from './store';

export interface AppDeps {
  config: ServerConfig;
  logger: Logger;
  store: Store;
  coaching: CoachingPort;
  createLiveRecognizer: (source: CaptureSource) => SpeechRecognizer | null;
  liveLlm: AdviceLlm | null;
  /** 学習（承認制）の改善案づくり用 LLM。未指定なら liveLlm を使う。 */
  proposalLlm?: AdviceLlm | null;
  loadReplay: (name: string | null) => ReplayScript;
  /** GET /offline/scripts の一覧（タイトル等のみ）。 */
  listOfflineScripts?: () => OfflineScriptInfo[];
  now?: () => number;
  /** hello を待つ時間（ms）。 */
  helloTimeoutMs?: number;
}

export interface AppHandle {
  app: FastifyInstance;
  auth: AuthManager;
  /** Host 検査に使う実際の待受ポート（listen 後に更新する）。 */
  setPort(port: number): void;
  runtimes: Set<SessionRuntime>;
  reviews: Map<string, SessionReview>;
}

/** WS クローズコード（アプリ定義）。 */
export const WS_CLOSE = { unauthorized: 4401, protocol: 4400, timeout: 4408 } as const;

export async function buildApp(deps: AppDeps): Promise<AppHandle> {
  const { config, logger, store } = deps;
  const now = deps.now ?? (() => Date.now());
  let port = config.port;
  const auth = new AuthManager({
    now,
    tokenTtlMs: config.tokenTtlMs,
    pairingCodeTtlMs: config.pairingCodeTtlMs,
    pairingMaxAttempts: config.pairingMaxAttempts,
    allowedExtensionId: config.allowedExtensionId,
  });
  const runtimes = new Set<SessionRuntime>();
  const reviews = new Map<string, SessionReview>();

  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // リクエスト単位のログ（URL・ヘッダー）は出さない
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    trustProxy: false,
  });
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  // --- 共通の境界検査（CORS だけに頼らない: Host / Origin / クエリ資格情報）-----
  app.addHook('onRequest', async (req, reply) => {
    if (urlCarriesCredential(req.url)) {
      logger.warn({ route: routeOf(req) }, 'rejected: credential in URL query');
      return reply.code(400).send({ error: 'credential_in_query' });
    }
    if (!isAllowedHostHeader(req.headers.host, port)) {
      logger.warn({ route: routeOf(req) }, 'rejected: host header');
      return reply.code(421).send({ error: 'bad_host' });
    }
    const path = routeOf(req);
    if (path === '/health') return;
    const origin = req.headers.origin;
    if (path === '/pair') {
      if (!parseExtensionOrigin(origin)) return reply.code(403).send({ error: 'origin_mismatch' });
    } else if (origin === undefined && path !== '/ws') {
      // Chrome は host_permissions を持つ拡張ページからの GET に Origin を付けない（実ブラウザの結合テストで確認）。
      // Origin なしの HTTP は、ルートの Bearer トークン検査（requireAuth）だけで判定する。
      // ブラウザ上の Web ページは Authorization ヘッダーを付けると必ず CORS（Origin 付き）になるので、ここは通らない。
    } else if (!auth.isAllowedOrigin(origin)) {
      logger.warn({ route: path }, 'rejected: origin');
      return reply.code(403).send({ error: 'origin_not_allowed' });
    }
    if (origin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', 'GET,POST,PATCH');
      reply.header('access-control-allow-headers', 'authorization,content-type');
      reply.header('access-control-max-age', '600');
      return reply.code(204).send();
    }
  });

  const requireAuth =
    (scope: AuthScope) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const token = bearerToken(req.headers.authorization);
      const ok =
        req.headers.origin === undefined
          ? auth.verifyTokenWithoutOrigin(token, scope)
          : auth.verifyToken(token, { extensionId: parseExtensionOrigin(req.headers.origin), scope });
      if (!ok) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
    };

  // --- ルート ----------------------------------------------------------------

  app.get('/health', async () => ({ ok: true, version: SERVER_VERSION }));

  app.post('/pair', async (req, reply) => {
    const parsed = PairingRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, error: 'invalid_code' });
    const r = auth.pair({ ...parsed.data, origin: req.headers.origin });
    logger.info({ ok: r.ok, error: r.ok ? undefined : r.error }, 'pairing attempt');
    if (!r.ok) {
      const code = r.error === 'rate_limited' ? 429 : r.error === 'origin_mismatch' ? 403 : r.error === 'already_paired' ? 409 : 401;
      return reply.code(code).send(r);
    }
    reply.header('access-control-allow-origin', req.headers.origin!);
    return r;
  });

  app.options('/*', async (_req, reply) => reply.code(204).send());

  // 応答は返す前に contracts のスキーマで検証する（拡張側も同じスキーマで受ける）
  app.get('/config/status', { preHandler: requireAuth('settings') }, async () =>
    ConfigStatusResponse.parse({
      version: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      ...providerStatus(config),
      retentionMs: config.retentionMs,
      budget: config.budget,
    }),
  );

  app.get('/facts', { preHandler: requireAuth('settings') }, async () => FactsListResponse.parse({ facts: store.listFacts() }));

  app.post('/facts', { preHandler: requireAuth('settings') }, async (req, reply) => {
    const p = FactCreateRequest.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid_body' });
    return reply.code(201).send(FactResponse.parse({ fact: store.createFact(p.data) }));
  });

  app.patch<{ Params: { id: string } }>('/facts/:id', { preHandler: requireAuth('settings') }, async (req, reply) => {
    const p = FactPatchRequest.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid_body' });
    const r = store.updateFact(req.params.id, p.data);
    if (!r.ok) return reply.code(404).send({ error: r.error });
    if (r.changed) for (const rt of runtimes) rt.onFactChanged(req.params.id);
    return FactUpdateResponse.parse({ fact: r.fact, approvalRevoked: r.changed });
  });

  app.post<{ Params: { id: string } }>('/facts/:id/approve', { preHandler: requireAuth('settings') }, async (req, reply) => {
    const p = FactApproveRequest.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'invalid_body' });
    const r = store.approveFact(req.params.id, p.data.version);
    if (!r.ok) return reply.code(r.error === 'not_found' ? 404 : 409).send({ error: r.error });
    return FactResponse.parse({ fact: r.fact });
  });

  app.post<{ Params: { id: string } }>('/facts/:id/revoke', { preHandler: requireAuth('settings') }, async (req, reply) => {
    const r = store.revokeFact(req.params.id);
    if (!r.ok) return reply.code(r.error === 'not_found' ? 404 : 409).send({ error: r.error });
    for (const rt of runtimes) rt.onFactChanged(req.params.id);
    return FactResponse.parse({ fact: r.fact });
  });

  app.get<{ Params: { id: string } }>('/facts/:id/history', { preHandler: requireAuth('settings') }, async (req, reply) => {
    if (!store.getFact(req.params.id)) return reply.code(404).send({ error: 'not_found' });
    return { history: store.factHistory(req.params.id) };
  });

  app.get<{ Params: { id: string } }>('/sessions/:id/review', { preHandler: requireAuth('session') }, async (req, reply) => {
    const r = reviews.get(req.params.id);
    if (!r || now() >= r.retainedUntil) return reply.code(404).send({ error: 'not_found_or_expired' });
    return SessionReviewResponse.parse({
      sessionId: r.sessionId,
      mode: r.mode,
      endedAt: r.endedAt,
      retainedUntil: r.retainedUntil,
      exportPath: r.exportPath,
      appliedFacts: store.sessionFactUsage(r.sessionId),
      latency: r.latency,
      usage: r.usage,
      transcript: r.data?.transcript ?? [],
      advice: r.data?.advice ?? [],
      audioGaps: r.data?.audioGaps ?? [],
    });
  });

  registerLearningRoutes(app, {
    config,
    logger,
    store,
    proposalLlm: deps.proposalLlm === undefined ? deps.liveLlm : deps.proposalLlm,
    preHandler: requireAuth('settings'),
  });

  app.get('/offline/scripts', { preHandler: requireAuth('session') }, async () => {
    const scripts = deps.listOfflineScripts?.() ?? [];
    const preferred = config.offline.script;
    const defaultId = preferred && scripts.some((s) => s.id === preferred) ? preferred : (scripts[0]?.id ?? null);
    return OfflineScriptsResponse.parse({ scripts, defaultId });
  });

  app.get('/sessions/active/latency', { preHandler: requireAuth('session') }, async () => ({
    sessions: [...runtimes].filter((r) => r.hasSession).map((r) => ({ sessionId: r.currentSessionId, latency: r.latencyStats() })),
  }));

  // --- WebSocket -------------------------------------------------------------

  app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    const extId = parseExtensionOrigin(req.headers.origin);
    let authed = false;
    const send = (m: ServerMessage) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(m));
    };
    const runtime = new SessionRuntime({
      config,
      logger,
      store,
      coaching: deps.coaching,
      createLiveRecognizer: deps.createLiveRecognizer,
      liveLlm: deps.liveLlm,
      loadReplay: deps.loadReplay,
      send,
      now,
      onEnded: (review) => {
        reviews.set(review.sessionId, review);
        const t = setTimeout(
          () => {
            review.clear();
            reviews.delete(review.sessionId);
          },
          Math.max(0, review.retainedUntil - now()),
        );
        t.unref?.();
      },
    });
    const helloTimer = setTimeout(() => {
      if (!authed) socket.close(WS_CLOSE.timeout, 'hello timeout');
    }, deps.helloTimeoutMs ?? 5000);

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (!authed) {
        // 最初のメッセージは hello（トークンは URL ではなくここで受け取る）
        if (isBinary) return socket.close(WS_CLOSE.unauthorized, 'unauthorized');
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString('utf8'));
        } catch {
          return socket.close(WS_CLOSE.unauthorized, 'unauthorized');
        }
        const hello = HelloMessage.safeParse(raw);
        if (!hello.success || !auth.verifyToken(hello.data.token, { extensionId: extId, scope: 'session' })) {
          logger.warn({ route: '/ws' }, 'ws hello rejected');
          send({ type: 'error', code: 'unauthorized', message: 'unauthorized', recoverable: false });
          return socket.close(WS_CLOSE.unauthorized, 'unauthorized');
        }
        authed = true;
        clearTimeout(helloTimer);
        runtimes.add(runtime);
        send({ type: 'hello.ack', protocolVersion: PROTOCOL_VERSION, serverVersion: SERVER_VERSION });
        return;
      }
      if (isBinary) {
        runtime.handleAudio(data);
        return;
      }
      const parsed = parseClientMessage(data.toString('utf8'));
      if (!parsed.ok) {
        send({ type: 'error', code: 'invalid_message', message: 'invalid message', recoverable: true });
        return;
      }
      try {
        runtime.handleMessage(parsed.message);
      } catch (e) {
        logger.error({ err: e }, 'runtime error');
        send({ type: 'error', code: 'internal_error', message: 'internal error', recoverable: true });
      }
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      void runtime.onDisconnect().finally(() => runtimes.delete(runtime));
    });
  });

  return {
    app,
    auth,
    setPort: (p) => {
      port = p;
    },
    runtimes,
    reviews,
  };
}

function routeOf(req: FastifyRequest): string {
  const q = req.url.indexOf('?');
  return q < 0 ? req.url : req.url.slice(0, q);
}
