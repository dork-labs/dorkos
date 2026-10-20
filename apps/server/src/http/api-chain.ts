/**
 * The middleware chain every HTTP request runs, and the Hono app the server's
 * routes are mounted on (`http/hono-api.ts`).
 *
 * The chain was ported step for step from the Express chain the server ran
 * until the move to Hono finished (ADR `261009-192542`,
 * `plans/2026-10-express-to-hono.md`), asking the same policy functions, so
 * every route kept its answers:
 *
 * | # | Step                                                                     |
 * | - | ------------------------------------------------------------------------ |
 * | 1 | `503` once the server is stopping (`terminal-admission.ts`)              |
 * | 2 | a managed remote-access host that skipped the managed ingress, a `403`   |
 * | 3 | the first-API-request log line (`http/first-contact.ts`)                 |
 * | 4 | CORS, `hono/cors` over `http/cors-policy.ts`                             |
 * | 5 | `X-Content-Type-Options: nosniff`, also carried onto the raw response    |
 * | 6 | the `Host` allowlist on `/api` (`host-guard.ts`), then the Wi-Fi level   |
 * | 7 | Better Auth, signed webhook ingress ({@link ApiChainOptions.beforeBodyParsing}) |
 * | 8 | body parsing (`http/request-body.ts`)                                    |
 * | 9 | the request log line                                                     |
 * | 10| the session gate, onto `c.var.user`                                      |
 * | 11| agent identity, onto `c.var.agentIdentity`                               |
 * | 12| the audit actor, its scope entered                                       |
 * | 13| the audit fallback for a mutating request no choke point recorded        |
 * | - | `notFound` (`http/unclaimed.ts`) and `onError`                           |
 *
 * Every step runs for every path, not only `/api`: `/mcp`, `/a2a`, the
 * `/.well-known` documents and the app's own files go through the same chain.
 * Only the host guard and the first-API-request line look at `/api` alone.
 *
 * Two things Express added that this chain does not, on purpose: the
 * `X-Powered-By: Express` header, and an `ETag` (with `304` answers) on every
 * body `res.send` wrote. Nothing reads either; `hono/etag` would also buffer
 * a whole event stream to hash it.
 *
 * Paths match case-sensitively, unlike Express's: `/API/health` reaches no
 * route, though it still gets the API 404. Trailing slashes still match,
 * through `strict: false`.
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
import { decideSessionGate, authRequiredBody } from '../services/core/auth/session-gate.js';
import { noteGateAdmitted } from '../services/core/remote/ingress-mark.js';
import { resolveAgentIdentityFromHeaders } from '../middleware/agent-identity.js';
import { auditActorForRequest } from '../middleware/audit-actor.js';
import { auditFallbackFor } from '../middleware/audit-request-fallback.js';
import { errorReply, logRequestError } from '../middleware/error-handler.js';
import { refuseUntrustedHost } from '../middleware/host-guard.js';
import {
  bypassesManagedIngress,
  MANAGED_HOST_REFUSAL_BODY,
} from '../middleware/managed-host-guard.js';
import { logRequest } from '../middleware/request-logger.js';
import { SERVER_STOPPING_BODY, SERVER_STOPPING_HEADERS } from '../middleware/terminal-admission.js';
import { corsAllowsOrigin, corsRefusal, warnOnWildcardCorsOrigin } from './cors-policy.js';
import { createFirstContactMarker } from './first-contact.js';
import { honoRequestFacts, type RequestFactsVariables } from './request-facts.js';
import { classifyRequest, noteForeignOrigin } from '../lib/request-classifier.js';
import { decideGateAccess, readGatePosture } from '../services/core/auth/gate-policy.js';
import {
  gateFactsFor,
  isOAuthCallbackArrival,
} from '../services/core/auth/oauth-callback-arrival.js';
import { currentServerRole } from '../lib/server-role.js';
import type { ClientFilesHandler } from './client-files.js';
import { parseRequestBody, underMount, type BodyRule } from './request-body.js';
import { answerUnclaimed } from './unclaimed.js';
import { wifiLevelMiddleware } from '../services/core/auth/sessions/wifi-level.js';

/** What the chain puts on `c.var` for the routes behind it. */
export interface ApiVariables extends RequestFactsVariables {
  /** The parsed request body (`http/request-body.ts`). */
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
   * body, and a signed webhook needs the raw bytes; a route there that answers
   * ends the chain.
   */
  beforeBodyParsing?: (app: Hono<ApiEnv>) => void;
  /** Path-scoped body parsers that replace the app-wide JSON one. */
  bodyRules?: readonly BodyRule[];
  /**
   * The client build, answering what no route claims outside `/api`
   * (`http/unclaimed.ts`). Only a production server serves one.
   */
  clientFiles?: ClientFilesHandler;
}

/**
 * The method list a CORS preflight is answered with: the `cors` package's
 * default, which the server answered with while it ran on Express.
 */
const PREFLIGHT_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'];

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
  app.notFound(answerUnclaimed(options.clientFiles));

  // Hono hands only thrown `Error`s to `onError`; anything else escapes as a
  // bare text 500. Answer a thrown non-Error with the generic JSON 500 instead,
  // which an empty message produces (`errorReply`).
  app.use(async (_c, next) => {
    try {
      await next();
    } catch (thrown) {
      throw thrown instanceof Error ? thrown : new Error('', { cause: thrown });
    }
  });
  app.use(admit(options.admission));
  // A managed remote-access hostname is served only through the managed
  // ingress, which checks the edge proof; on this listener it is refused before
  // any logger or route sees it (`middleware/managed-host-guard.ts`).
  app.use(async (c, next) => {
    if (bypassesManagedIngress(c.env.incoming)) return c.json(MANAGED_HOST_REFUSAL_BODY, 403);
    await next();
  });
  const noteFirstApiRequest = createFirstContactMarker('[Client] first API request');
  app.use(async (c, next) => {
    if (underMount(c.req.path, '/api')) noteFirstApiRequest();
    await next();
  });
  warnOnWildcardCorsOrigin();
  app.use(keepEachVaryFieldOnce);
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
    c.header('X-Content-Type-Options', 'nosniff');
    carryHeadersToNodeResponse(c);
    await next();
  });
  app.use(async (c, next) => {
    if (!underMount(c.req.path, '/api')) return next();
    const refusal = refuseUntrustedHost(c.env.incoming.headers.host, c.req.method, rawUrl(c));
    if (refusal) return c.json(refusal, 403);
    await next();
  });

  // The Wi-Fi level (`services/core/auth/sessions/wifi-level.ts`), ahead of Better Auth
  // so its API key and sign-out endpoints are covered too.
  app.use(wifiLevelMiddleware());

  options.beforeBodyParsing?.(app);

  app.use(parseRequestBody<ApiEnv>(options.bodyRules));
  app.use(async (c, next) => {
    const start = Date.now();
    const { method } = c.req;
    // As sent, not as Hono decoded it.
    const path = rawUrl(c).split('?')[0] ?? c.req.path;
    const { outgoing } = c.env;
    outgoing.once('finish', () =>
      logRequest(method, path, outgoing.statusCode, Date.now() - start)
    );
    await next();
  });
  app.use(async (c, next) => {
    // An OAuth callback is judged without the provider page it came from.
    const facts = gateFactsFor(c.req.method, c.req.path, honoRequestFacts(c));
    const requestClass = classifyRequest(facts, currentServerRole());
    noteForeignOrigin(facts, requestClass);
    // The sign-in cookie is `SameSite=Strict` (DOR-3172), so a provider's
    // cross-site redirect back never carries it. A callback arrival at this
    // computer is therefore not asked for one even when this computer asks for
    // a password; its handler finishes only a flow it started (state, PKCE).
    const access =
      isOAuthCallbackArrival(c.req.method, c.req.path) && requestClass.kind === 'this-computer'
        ? 'open'
        : decideGateAccess(requestClass, readGatePosture());
    const decision = await decideSessionGate(c.req.method, c.req.path, facts, access);
    if (!decision.allowed) return c.json(authRequiredBody(), 401);
    if (decision.user) c.set('user', decision.user);
    noteGateAdmitted(c.env.incoming, c.env.outgoing);
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

/** The request URL exactly as sent, path and query. */
function rawUrl(c: Context<ApiEnv>): string {
  return c.env.incoming.url ?? c.req.path;
}

/**
 * Put the headers the chain has decided so far (CORS, nosniff) on the raw Node
 * response too, before any route runs.
 *
 * A route that answers through Hono gets them on its `Response` anyway, and
 * those win where both name a header. A route that writes the Node response
 * itself (an event stream, an extension router) never builds a `Response`, and
 * without this would go out with no CORS headers, so a credentialed
 * cross-origin `EventSource` would be refused. `Vary: Origin` is what
 * `hono/cors` adds after the route returns, which such a route never does.
 */
function carryHeadersToNodeResponse(c: Context<ApiEnv>): void {
  const { outgoing } = c.env;
  c.res.headers.forEach((value, name) => outgoing.setHeader(name, value));
  outgoing.setHeader('Vary', 'Origin');
}

/**
 * Keep each `Vary` field once, in the order it was first written.
 *
 * CORS varies every answer on `Origin` before the route runs (on the raw
 * response, above), and a route that varies on more adds after it. `hono/cors`
 * also appends `Origin` after the route, so a route that wrote `Origin, X`
 * would otherwise answer `Origin, X, Origin`.
 */
const keepEachVaryFieldOnce: MiddlewareHandler<ApiEnv> = async (c, next) => {
  await next();
  const vary = c.res.headers.get('Vary');
  if (!vary) return;
  const seen = new Set<string>();
  const fields = vary
    .split(',')
    .map((field) => field.trim())
    .filter((field) => {
      const key = field.toLowerCase();
      if (field === '' || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  c.res.headers.set('Vary', fields.join(', '));
};

/** Answer `503` once the server has started stopping; admit everything else. */
function admit(admission: MainRequestAdmission): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (!admission.isClosed) return next();
    return c.json(SERVER_STOPPING_BODY, 503, SERVER_STOPPING_HEADERS);
  };
}

/**
 * Run the rest of the request inside its audit scope (`middleware/audit-actor.ts`).
 *
 * The scope reads the caller lazily, through getters: a gate that runs after
 * this step (the `/mcp` authorizer) still decides who the actor is.
 */
const enterAuditScope: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const scope = auditActorForRequest({
    headers: c.env.incoming.headers,
    path: c.req.path,
    get user() {
      return c.get('user');
    },
    get agentIdentity() {
      return c.get('agentIdentity');
    },
    get mcpLocalToken() {
      return c.get('mcpLocalToken');
    },
  });
  if (!scope) return next();
  c.set('auditScope', scope);
  await runWithAuditActor(scope, () => next());
};

/**
 * The chain's `onError`: one log line, and the answer `errorReply` picks.
 *
 * A route that already wrote to the raw Node response cannot be given a JSON
 * body any more; close the connection instead, after the log line.
 */
function answerError(err: Error, c: Context<ApiEnv>): Response {
  logRequestError(err, c.req.method, c.req.path);
  const { outgoing } = c.env;
  if (outgoing.headersSent) {
    // Not now: Node holds a response's first bytes until the next tick, and
    // closing before then would throw away what the route already wrote.
    // A response the route already ended is left alone: its socket may be
    // carrying the next request by then.
    if (!outgoing.writableEnded) setImmediate(() => outgoing.destroy());
    return new Response(null, { headers: RESPONSE_ALREADY_SENT.headers });
  }
  const reply = errorReply(err);
  return c.json(reply.body, reply.status as ContentfulStatusCode);
}
