/**
 * The `/api` middleware chain on Hono: the same steps, in the same order, as
 * the Express chain in `app.ts`, asking the same policy functions.
 *
 * During the move from Express to Hono (ADR `261009-192542`,
 * `plans/2026-10-express-to-hono.md`) a request runs exactly ONE chain: a
 * moved route group is served by the app {@link createApiApp} builds, and
 * everything else still falls through the front door to Express. Running both
 * would count every request twice in the audit log and the rate limiters, so
 * this chain has to stand on its own, step for step:
 *
 * | # | Express (`app.ts`)                      | Here                                          |
 * | - | --------------------------------------- | --------------------------------------------- |
 * | 1 | `terminalAdmission`                     | `503` once the server is stopping             |
 * | 2 | first-API-request log line              | the same, through `http/first-contact.ts`     |
 * | 3 | `cors` (delegate form)                  | `hono/cors` over `http/cors-policy.ts`        |
 * | 4 | `X-Content-Type-Options: nosniff`       | the same header, on every response after this |
 * | 5 | `hostGuard` on `/api`                   | `refuseUntrustedHost`                         |
 * | 6 | Better Auth, signed webhook ingress     | {@link ApiChainOptions.beforeBodyParsing}     |
 * | 7 | per-path parsers, then `express.json`   | `parseRequestBody` (`http/request-body.ts`)   |
 * | 8 | `requestLogger`                         | `logRequest`                                  |
 * | 9 | `sessionGate`                           | `decideSessionGate`, onto `c.var.user`        |
 * | 10| `resolveAgentIdentity`                  | the same resolver, onto `c.var.agentIdentity` |
 * | 11| `auditActor`                            | `auditActorForRequest`, scope entered         |
 * | 12| `auditRequestFallback`                  | `auditFallbackFor`                            |
 * | - | `/api` 404 and `errorHandler`           | `notFound` and `onError`                      |
 *
 * `__tests__/api-chain-parity.test.ts` drives both chains through the same
 * matrix of login, origin, host, credential and body, and requires the same
 * answer from each in every cell.
 *
 * Two things Express adds that this chain does not, on purpose: the
 * `X-Powered-By: Express` header, and an `ETag` (with `304` answers) on every
 * body `res.send` writes. Nothing reads either; `hono/etag` would also buffer
 * a whole event stream to hash it.
 *
 * And one Express habit that cannot carry over: Express routes match paths
 * case-insensitively, Hono's do not. `/API/health` reaches nothing here.
 * Trailing slashes still match, through `strict: false`.
 *
 * @module http/api-chain
 */
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { MainRequestAdmission } from '../services/core/lifecycle/main-request-admission.js';
import type { AuditActorContext } from '../services/audit/audit-context.js';
import { runWithAuditActor } from '../services/audit/audit-context.js';
import { decideSessionGate, AUTH_REQUIRED_BODY } from '../services/core/auth/session-gate.js';
import { resolveAgentIdentityFromHeaders } from '../middleware/agent-identity.js';
import { auditActorForRequest } from '../middleware/audit-actor.js';
import { auditFallbackFor } from '../middleware/audit-request-fallback.js';
import { errorReply, logRequestError } from '../middleware/error-handler.js';
import { refuseUntrustedHost } from '../middleware/host-guard.js';
import { logRequest } from '../middleware/request-logger.js';
import { SERVER_STOPPING_BODY, SERVER_STOPPING_HEADERS } from '../middleware/terminal-admission.js';
import { corsAllowsOrigin, corsRefusal, warnOnWildcardCorsOrigin } from './cors-policy.js';
import { createFirstContactMarker } from './first-contact.js';
import { honoRequestFacts, type RequestFactsVariables } from './request-facts.js';
import { parseRequestBody, type BodyRule } from './request-body.js';

/** What the chain puts on `c.var`, under the names `res.locals` uses on Express. */
export interface ApiVariables extends RequestFactsVariables {
  /** The parsed request body: `req.body` on Express. */
  body?: unknown;
  /** The request's audit scope, entered by the audit-actor step. */
  auditScope?: AuditActorContext;
  /**
   * Set by the `/mcp` authorizer when the caller presented the per-install
   * local token. The audit actor reads it lazily, after that authorizer ran.
   */
  mcpLocalToken?: boolean;
}

/** The Hono environment of every route behind this chain. */
export type ApiEnv = { Bindings: HttpBindings; Variables: ApiVariables };

/** Options for {@link createApiApp}. */
export interface ApiChainOptions {
  /** The main listener's shared terminal state. */
  admission: MainRequestAdmission;
  /**
   * Routes that must answer BEFORE the body is parsed and before the session
   * gate, registered at that point in the chain. Better Auth reads its own
   * body, and a signed webhook needs the raw bytes; on Express both are
   * mounted between `hostGuard` and `express.json`, and a route there that
   * answers ends the chain, exactly as here.
   */
  beforeBodyParsing?: (app: Hono<ApiEnv>) => void;
  /** Path-scoped body parsers that replace the app-wide JSON one. */
  bodyRules?: readonly BodyRule[];
}

/** The `/api` 404 body, on both chains. */
const API_NOT_FOUND_BODY = { error: 'Not found', code: 'API_NOT_FOUND' } as const;

/**
 * The method list a CORS preflight is answered with: the `cors` package's
 * default, which the Express chain sends.
 */
const PREFLIGHT_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'];

/**
 * Whether a path falls under an Express-style `app.use(prefix)` mount: the
 * prefix itself or anything below it, ignoring case.
 *
 * @param path - The request path.
 * @param prefix - The mount path, lower-case, with no trailing slash.
 */
function underMount(path: string, prefix: string): boolean {
  const lowered = path.toLowerCase();
  return lowered === prefix || lowered.startsWith(`${prefix}/`);
}

/**
 * Build a Hono app with the `/api` chain in place. Mount routes on it, then
 * serve it behind the front door.
 *
 * @param options - See {@link ApiChainOptions}.
 * @returns The app.
 */
export function createApiApp(options: ApiChainOptions): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>({ strict: false });
  app.onError(answerError);
  app.notFound((c) =>
    underMount(c.req.path, '/api') ? c.json(API_NOT_FOUND_BODY, 404) : c.text('404 Not Found', 404)
  );

  app.use(admit(options.admission));
  const noteFirstApiRequest = createFirstContactMarker('[Client] first API request');
  app.use(async (c, next) => {
    if (underMount(c.req.path, '/api')) noteFirstApiRequest();
    await next();
  });
  warnOnWildcardCorsOrigin();
  app.use(
    cors({
      credentials: true,
      allowMethods: PREFLIGHT_METHODS,
      origin: (origin, c) => {
        if (corsAllowsOrigin(honoRequestFacts(c as Context<ApiEnv>))) return origin || null;
        throw corsRefusal(c.req.header('origin'));
      },
    })
  );
  app.use(async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
  });
  app.use(async (c, next) => {
    if (!underMount(c.req.path, '/api')) return next();
    const refusal = refuseUntrustedHost(c.env.incoming.headers.host, c.req.method, rawUrl(c));
    if (refusal) return c.json(refusal, 403);
    await next();
  });

  options.beforeBodyParsing?.(app);

  app.use(parseRequestBody<ApiEnv>(options.bodyRules));
  app.use(async (c, next) => {
    const start = Date.now();
    const { method, path } = c.req;
    const { outgoing } = c.env;
    outgoing.once('finish', () =>
      logRequest(method, path, outgoing.statusCode, Date.now() - start)
    );
    await next();
  });
  app.use(async (c, next) => {
    const decision = await decideSessionGate(c.req.method, c.req.path, honoRequestFacts(c));
    if (!decision.allowed) return c.json(AUTH_REQUIRED_BODY, 401);
    if (decision.user) c.set('user', decision.user);
    await next();
  });
  app.use(async (c, next) => {
    const identity = await resolveAgentIdentityFromHeaders(c.env.incoming.headers, c.req.path);
    if (identity) c.set('agentIdentity', identity);
    await next();
  });
  app.use(enterAuditScope);
  app.use(async (c, next) => {
    const record = auditFallbackFor(c.req.method, rawUrl(c), c.get('auditScope'));
    if (record) {
      const { outgoing } = c.env;
      outgoing.once('finish', () => record(outgoing.statusCode));
    }
    await next();
  });
  return app;
}

/** The request URL exactly as sent: Express's `req.originalUrl`. */
function rawUrl(c: Context<ApiEnv>): string {
  return c.env.incoming.url ?? c.req.path;
}

/** Answer `503` once the server has started stopping; admit everything else. */
function admit(admission: MainRequestAdmission): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (!admission.isClosed) return next();
    return c.json(SERVER_STOPPING_BODY, 503, SERVER_STOPPING_HEADERS);
  };
}

/**
 * Run the rest of the request inside its audit scope, as `auditActor` does.
 *
 * The scope reads the caller lazily, through `locals`: a gate that runs after
 * this step (the `/mcp` authorizer) still decides who the actor is.
 */
const enterAuditScope: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const locals = {
    get user() {
      return c.get('user');
    },
    get agentIdentity() {
      return c.get('agentIdentity');
    },
    get mcpLocalToken() {
      return c.get('mcpLocalToken');
    },
  };
  const scope = auditActorForRequest(
    { headers: c.env.incoming.headers, path: c.req.path },
    { locals }
  );
  if (!scope) return next();
  c.set('auditScope', scope);
  await runWithAuditActor(scope, () => next());
};

/**
 * The chain's `onError`: the Express error handler's log line and answer.
 *
 * A route that already wrote to the raw Node response cannot be given a JSON
 * body any more; like Express's default handler, close the connection.
 */
function answerError(err: Error, c: Context<ApiEnv>): Response {
  const { outgoing } = c.env;
  if (outgoing.headersSent) {
    outgoing.destroy(err);
    return new Response(null, { headers: RESPONSE_ALREADY_SENT.headers });
  }
  logRequestError(err, c.req.method, c.req.path);
  const reply = errorReply(err);
  return c.json(reply.body, reply.status as ContentfulStatusCode);
}
