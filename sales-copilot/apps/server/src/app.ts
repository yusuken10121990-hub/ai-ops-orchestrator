import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type WebSocket from 'ws';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  AuthCheckResponse,
  ConfigStatusResponse,
  LOCAL_ADMIN_HEADER,
  LocalPairingCodeResponse,
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
import type { TokenPersistence } from './token-store';

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
  /** ペアリング記録（ハッシュのみ）の永続化先。無ければメモリだけ。 */
  tokenStore?: TokenPersistence | null;
  /**
   * POST /local/pairing-code（pnpm pair）に必要な秘密。サーバー起動ごとに作り直し、本人だけが読めるファイルに置く。
   * 無ければこの経路は無効（404）。
   */
  localAdminSecret?: string | null;
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
    store: deps.tokenStore ?? null,
    // 保存に失敗してもメモリ上は動く（再起動で再ペアリングが要る）。中身・トークンはログに出さない
    onPersistError: (op, e) => logger.error({ op, err: e }, 'pairing store error'),
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

  // ペアリングがまだ有効か（期限は使うたびに延長される。最新の期限を返す）
  app.get('/auth/check', { preHandler: requireAuth('session') }, async (req, reply) => {
    const info = auth.tokenInfo(bearerToken(req.headers.authorization));
    if (!info) return reply.code(401).send({ error: 'unauthorized' });
    return AuthCheckResponse.parse({ ok: true, ...info });
  });

  // 設定画面の「解除」: このトークンをサーバー側でも失効させる（保存済みの記録からも消す）
  app.post('/auth/revoke', { preHandler: requireAuth('settings') }, async (req) => {
    const revoked = auth.revokeToken(bearerToken(req.headers.authorization));
    logger.info({ revoked }, 'pairing revoked');
    return { ok: true };
  });

  // pnpm pair: 同じ PC の本人だけが読めるファイルの秘密を持つ要求にだけ、新しいペアリングコードを返す。
  // ブラウザ（Origin 付き）からは使えない。秘密は起動ごとに作り直す。
  const adminSecretHash = deps.localAdminSecret ? createHash('sha256').update(deps.localAdminSecret).digest() : null;
  app.post('/local/pairing-code', async (req, reply) => {
    if (!adminSecretHash) return reply.code(404).send({ error: 'not_found' });
    if (req.headers.origin !== undefined) return reply.code(403).send({ error: 'origin_not_allowed' });
    const got = req.headers[LOCAL_ADMIN_HEADER];
    const given = typeof got === 'string' ? createHash('sha256').update(got).digest() : null;
    if (!given || !timingSafeEqual(given, adminSecretHash)) {
      logger.warn({ route: '/local/pairing-code' }, 'rejected: local admin secret');
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const pairingCode = auth.issuePairingCode();
    logger.info('pairing code issued (pnpm pair)');
    return LocalPairingCodeResponse.parse({ pairingCode, expiresAt: now() + config.pairingCodeTtlMs });
  });

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

  /**
   * 再接続待ちの商談（WS が切れた後、SESSION_RESUME_GRACE_MS の間だけ保持）。
   * 画面共有・ウィンドウ切替・一時的な通信断で商談が終わらないようにする（オーナーの実商談で発生）。
   */
  interface Conn {
    socket: WebSocket;
  }
  const connOf = new WeakMap<SessionRuntime, Conn>();
  const detached = new Map<string, { runtime: SessionRuntime; timer: ReturnType<typeof setTimeout> }>();

  const endDetached = (sessionId: string) => {
    const e = detached.get(sessionId);
    if (!e) return;
    detached.delete(sessionId);
    clearTimeout(e.timer);
    void e.runtime.end(false, 'connection_lost').finally(() => runtimes.delete(e.runtime));
  };

  app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
    const extId = parseExtensionOrigin(req.headers.origin);
    let authed = false;
    /** この接続が今送っている先（再接続で別の接続へ引き継がれたら、こちらの close では何もしない）。 */
    const conn: Conn = { socket };
    const send = (m: ServerMessage) => {
      const s = conn.socket;
      if (s.readyState === 1) s.send(JSON.stringify(m));
    };
    let runtime = new SessionRuntime({
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
    connOf.set(runtime, conn);
    let first = true;
    const helloTimer = setTimeout(() => {
      if (!authed) socket.close(WS_CLOSE.timeout, 'hello timeout');
    }, deps.helloTimeoutMs ?? 5000);

    /** 同じ商談を引き継ぐ。保持中（切断済み）か、古い接続がまだ開いている（半開き）場合のどちらでも。 */
    const resume = (sessionId: string): boolean => {
      let target: SessionRuntime | null = null;
      const d = detached.get(sessionId);
      if (d) {
        clearTimeout(d.timer);
        detached.delete(sessionId);
        target = d.runtime;
      } else {
        for (const r of runtimes) if (r !== runtime && r.hasSession && r.currentSessionId === sessionId) target = r;
      }
      if (!target || !target.hasSession) return false;
      const old = connOf.get(target);
      const oldSocket = old?.socket;
      // 新しい接続へ付け替える（古い接続の close は「引き継ぎ済み」として無視される）
      runtimes.delete(runtime);
      runtime = target;
      if (old) old.socket = socket;
      connOf.set(target, conn);
      conn.socket = socket;
      if (oldSocket && oldSocket !== socket && oldSocket.readyState <= 1) {
        try {
          oldSocket.close(1000, 'resumed elsewhere');
        } catch {
          /* noop */
        }
      }
      runtimes.add(target);
      return true;
    };

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
        first = false;
        runtime.handleAudio(data);
        return;
      }
      const parsed = parseClientMessage(data.toString('utf8'));
      if (!parsed.ok) {
        send({ type: 'error', code: 'invalid_message', message: 'invalid message', recoverable: true });
        return;
      }
      if (parsed.message.type === 'session.resume' && first && !runtime.hasSession) {
        first = false;
        const sid = parsed.message.sessionId;
        const ok = resume(sid);
        send({ type: 'session.resumed', sessionId: sid, ok });
        if (ok) runtime.reattach();
        else logger.info({ route: '/ws' }, 'session resume rejected (not found or expired)');
        return;
      }
      first = false;
      try {
        runtime.handleMessage(parsed.message);
      } catch (e) {
        logger.error({ err: e }, 'runtime error');
        send({ type: 'error', code: 'internal_error', message: 'internal error', recoverable: true });
      }
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      // 別の接続へ引き継ぎ済みなら何もしない
      if (conn.socket !== socket) return;
      const r = runtime;
      const sid = r.currentSessionId;
      const grace = config.resumeGraceMs;
      if (sid && grace > 0 && r.detach()) {
        const timer = setTimeout(() => endDetached(sid), grace);
        timer.unref?.();
        detached.set(sid, { runtime: r, timer });
        return;
      }
      void r.onDisconnect().finally(() => runtimes.delete(r));
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
