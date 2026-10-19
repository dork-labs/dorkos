/**
 * Session gate — the single request gate for `/api/*` and `/mcp`.
 *
 * A request that needs a credential ({@link gateAccessFor}: another device
 * always, this computer when "Ask for a password on this computer too" is on)
 * must present either (a) a valid Better Auth session cookie or (b) a valid
 * per-user API key as `Authorization: Bearer <key>`. A person at this computer
 * with that setting off passes with nothing. Read per request, so changing the
 * setting needs no restart.
 *
 * ## Exemptions (always reach their handler)
 *
 * - **Non-API paths** — static SPA assets and `index.html`, so the login screen
 *   can render (only `/api/*` and `/mcp` paths are gated).
 * - **`/api/auth/*`** — the Better Auth endpoints themselves (sign-in must be
 *   reachable to obtain a cookie).
 * - **`/api/health`** — health/status probe.
 * - **`/api/workbench/serve/*`** — the embedded browser's local-file route. It is
 *   authorized by a short-lived signed token in the URL (minted by the gated
 *   `/api/workbench/sign`), NOT the API's cookie/header auth, because the browser
 *   frame is opaque-origin and carries no credentials by design (DOR-216,
 *   ADR 260708-185519). The token is the capability; the gate would otherwise
 *   block the credential-less frame. Dev-server previews need no exemption at
 *   all: they no longer ride this server's routes, they answer on a listener of
 *   their own (DOR-1260).
 * - **On an agent computer, none of these.** Its gate decides every path,
 *   not only `/api` and `/mcp`: the liveness probe passes, `/mcp` and A2A go
 *   to their own authorizer, and everything else needs a live agent identity
 *   (`services/core/agent-computer/agent-gate.ts`).
 * - **`/api/hub/link`, on a hub only, and only that exact path** — a computer
 *   redeeming the one-time link code its owner minted (`routes/hub-link.ts`,
 *   step B3). The computer never signs in to the hub; the code is its
 *   credential. A trailing slash or any sibling under `/api/hub/` stays gated.
 *
 * The credential check is factored into {@link verifyRequestAuth}, a single
 * verification path (session cookie, then Bearer API key) that the rewritten MCP
 * auth middleware also reuses — no duplication.
 *
 * @module services/core/auth/session-gate
 */
import { fromNodeHeaders } from 'better-auth/node';
import { logger } from '../../../lib/logger.js';
// `getAuth` is a hoisted accessor called at request time, so this back-import to
// the auth barrel (which re-exports this module) is a safe function-level cycle.
import { getAuth } from './index.js';
import type { RequestFacts } from '../../../http/request-facts.js';
import { isSessionGatedPath } from './gated-paths.js';
import { gateAccessFor, type GateAccess } from './gate-policy.js';
import { currentServerRole } from '../../../lib/server-role.js';
import { publicComputerSessionExpired } from '../hub/public-computer.js';
import { decideAgentComputerGate } from '../agent-computer/agent-gate.js';
import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import type { AgentComputerWriteRefusal } from '../agent-computer/agent-writes.js';
import { RELAY_LINK_PATH } from '@dorkos/shared/session-relay-link';
import {
  requestSessionRoute,
  sessionWorksOn,
  type SessionRoute,
} from './sessions/session-route.js';
import { inRestartWindow, sessionRecentlyEnded } from './sessions/live-connections.js';

/** The identity resolved from a request's credentials, set on the request as `c.var.user`. */
export interface RequestUser {
  /** The Better Auth user id that owns the session cookie or API key. */
  userId: string;
  /**
   * WHICH credential proved this identity.
   *
   * Required, not optional, and that is the point. A few writes are reserved for
   * a person using the app rather than for anything holding a valid
   * credential — answering an approval, and changing an `operator-only` setting
   * or a permission. A per-user API key
   * satisfies this gate exactly as a browser session does (DOR-474), so those
   * writes have to be able to tell the two apart, and `undefined` reading as
   * "not a cookie" would be correct by accident rather than by type. Every site
   * that resolves an identity states which credential it verified.
   */
  credential: 'cookie' | 'api-key';
  /** Stable Better Auth API-key record id, present only for an API-key credential. */
  credentialId?: string;
  /** The Better Auth session id, present only for a cookie credential. */
  readonly sessionId?: string;
  /**
   * The route the session was made on, which is the route this request came
   * in on (`./sessions/session-route.ts`). Present only for a cookie credential.
   */
  readonly route?: SessionRoute;
}

/**
 * The one path under `/api/health` that the gate still protects.
 *
 * The liveness probe is exempt because a load balancer, the desktop shell, and
 * the tunnel all have to reach it before anyone signs in, and it says only that
 * the server is up. `/api/health/deep` is a different thing wearing the same
 * prefix: it reports how many rooms, integrations, and agents this machine has
 * and which of them are broken. That is for the operator, so it needs the
 * operator's credential.
 */
const GATED_HEALTH_PATHS = ['/api/health/deep'];

/**
 * Whether a path reaches a gated health route, however it is spelled.
 *
 * The router matches non-strictly, so `/api/health/deep/` reaches the same
 * handler as `/api/health/deep`, and a path with doubled slashes must not be
 * trusted to miss it either. An
 * exact-string carve-out out of a prefix exemption therefore leaks: the
 * trailing-slash spelling misses the carve-out, matches the `/api/health/`
 * exemption, and returns the whole report with no credential. Match the way
 * the router does — normalize, then compare as a prefix.
 *
 * Case is already handled: the caller lowercases before any gate check.
 *
 * @param path - The lowercased request path.
 * @returns `true` when the request would reach a gated health route.
 */
function isGatedHealthPath(path: string): boolean {
  const collapsed = path.replace(/\/{2,}/g, '/');
  // `\/$`, not `\/+$`: the collapse on the line above leaves no run of two
  // slashes for the `+` to consume, so it could only ever retry at every offset
  // of a run that cannot exist — quadratic in shape (CodeQL js/polynomial-redos)
  // on the pre-auth path every request takes, which is the last place to leave
  // one standing.
  const normalized = collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
  return GATED_HEALTH_PATHS.some(
    (gated) => normalized === gated || normalized.startsWith(`${gated}/`)
  );
}

/**
 * Paths that always pass while login is enabled: the Better Auth endpoints (so
 * sign-in is reachable), the health probe, and on a hub the link path.
 */
function isExemptPath(path: string): boolean {
  if (isGatedHealthPath(path)) return false;
  return (
    path.startsWith('/api/auth/') ||
    path === '/api/health' ||
    path.startsWith('/api/health/') ||
    // Signed-token-authorized embedded-browser content (see the module doc).
    path.startsWith('/api/workbench/serve/') ||
    // A computer redeeming a link code, on a hub only (see the module doc).
    (path === RELAY_LINK_PATH && currentServerRole() === 'hub')
  );
}

/** Extract the token from an `Authorization: Bearer <token>` header, or `null`. */
function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}

/** Options for {@link verifyRequestAuth}. */
export interface VerifyRequestAuthOptions {
  /**
   * Set when the caller already knows the request's `Authorization: Bearer`
   * value is one of this instance's own secrets rather than a per-user Better
   * Auth API key — today only the per-instance local MCP token, which is minted
   * into a `0600` file and never inserted into the `apikey` table.
   *
   * Skips the API-key leg. It could not have matched, and asking anyway is not
   * free: better-auth's apiKey plugin logs its own untagged, `error`-level
   * `"Failed to validate API key: … Invalid API key."` from plugin internals
   * before returning `{ valid: false }` — it does not throw, so the debug-level
   * catch below never gets the chance to quiet it. Every JSON-RPC round trip to
   * `/mcp` is a separate POST (`initialize`, `tools/list`, each `tools/call`),
   * so on a default install that was roughly four bogus error lines per agent
   * turn drowning real failures in the log.
   *
   * The session-cookie leg still runs, so identity attribution is unchanged.
   */
  bearerIsNotAnApiKey?: boolean;
  /** Bypass this deployment's cookie cache for a fresh database observation. */
  sessionFreshness?: 'server-store';
}

/**
 * Resolve the authenticated identity of a request from its credentials.
 *
 * Tries the Better Auth session cookie first (the cookie cache keeps hot paths
 * like SSE reconnect off the DB), then a per-user API key presented as
 * `Authorization: Bearer <key>`. Returns `null` when neither credential is
 * present or valid. Verification failures never throw: a malformed cookie or an
 * invalid/revoked key resolves to `null` (fail closed) so callers can respond
 * with a uniform 401.
 *
 * Shared by the session gate ({@link decideSessionGate}), the MCP auth
 * middleware, and the WebSocket upgrade gate so there is exactly one
 * credential-verification path.
 *
 * A session cookie counts only on the route its sign-in was made on
 * (`./sessions/session-route.ts`, DOR-2969): a cookie replayed on another route, or one
 * from before routes were recorded anywhere but this computer, verifies as
 * nobody, so the caller gets the ordinary `401` and signs in again there. That
 * is why it reads the peer and the listener as well as the headers.
 *
 * It takes a request's facts rather than a framework's request, because the
 * third caller has no request: a WebSocket upgrade arrives on the HTTP server's
 * `upgrade` event as a bare `IncomingMessage`, having bypassed every piece of
 * middleware including the session gate. Narrowing the parameter is what lets
 * the upgrade path reuse this instead of growing a second, drifting copy of the
 * credential check.
 *
 * Each returning path names the credential it verified, because a caller holding
 * a per-user API key is not the same principal as a person in a browser session
 * and a few writes turn on telling them apart (see {@link RequestUser}).
 *
 * @param req - The request's headers, TCP peer and listener: a request's facts
 *   (`honoRequestFacts`), or `upgradeFacts` of a WebSocket upgrade.
 * @param options - See {@link VerifyRequestAuthOptions}. Omit unless the caller
 *   already knows what the request's bearer is.
 * @returns The resolved identity and how it was proved, or `null` when
 *   unauthenticated.
 */
export async function verifyRequestAuth(
  req: Pick<RequestFacts, 'headers' | 'peerAddress' | 'ingress'>,
  options: VerifyRequestAuthOptions = {}
): Promise<RequestUser | null> {
  const auth = getAuth();
  // Auth was never initialized (e.g. a unit test app built without initAuth):
  // nothing can be verified, so treat every request as unauthenticated.
  if (!auth) return null;

  // 1. Session cookie — verified against the cookie cache / DB.
  try {
    const result = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
      // Just after a restart, nothing remembers which sign-ins ended before it,
      // so the cached copy is not trusted (`./sessions/live-connections.ts`).
      ...(options.sessionFreshness === 'server-store'
        ? { query: { disableCookieCache: true, disableRefresh: true } }
        : inRestartWindow()
          ? { query: { disableCookieCache: true } }
          : {}),
    });
    // A public-computer sign-in never outlives its day, whatever its expiry
    // says (`public-computer.ts`).
    if (result?.user?.id && !(result.session && publicComputerSessionExpired(result.session))) {
      // Only on the route it was made on; anywhere else it is no session. A
      // session that just ended is no session either, though its cached
      // snapshot still vouches for it (`./sessions/live-connections.ts`).
      const route = requestSessionRoute(req);
      if (
        route !== null &&
        result.session &&
        sessionWorksOn(result.session, route) &&
        !sessionRecentlyEnded(result.session.id)
      ) {
        return {
          userId: result.user.id,
          credential: 'cookie',
          sessionId: result.session.id,
          route,
        };
      }
    }
  } catch (error) {
    logger.debug('[Auth] Session cookie verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 2. Bearer API key — verified via the apiKey plugin, unless the caller has
  //    already established that this bearer is one of its own non-Better-Auth
  //    secrets (see `bearerIsNotAnApiKey`).
  const token = options.bearerIsNotAnApiKey ? null : extractBearerToken(req.headers.authorization);
  if (token) {
    try {
      const result = await auth.api.verifyApiKey({ body: { key: token } });
      // The apiKey plugin stores the owning user id in `referenceId`. Require it
      // to be non-empty: a valid key must resolve to an owner, never `''`.
      if (result.valid && result.key?.referenceId) {
        return {
          userId: result.key.referenceId,
          credential: 'api-key',
          credentialId: result.key.id,
        };
      }
    } catch (error) {
      logger.debug('[Auth] API key verification failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}

/** The body of the session gate's `401`. */
export const AUTH_REQUIRED_BODY = { error: 'Unauthorized', code: 'AUTH_REQUIRED' } as const;

/**
 * The session gate's `401`, saying how to sign in: on a hub, with a DorkOS
 * account (`services/core/hub/hub-sign-in.ts`), since a hub has no passwords.
 * Elsewhere the app's own sign-in form.
 */
export function authRequiredBody(): typeof AUTH_REQUIRED_BODY & { signInWith?: 'dorkos' } {
  return currentServerRole() === 'hub'
    ? { ...AUTH_REQUIRED_BODY, signInWith: 'dorkos' }
    : AUTH_REQUIRED_BODY;
}

/** What the session gate decided about one request. */
export type SessionGateDecision =
  /**
   * Let it through. `user` is set when the gate proved a person; on an agent
   * computer, `agentIdentity` when it proved an agent.
   */
  | { allowed: true; user?: RequestUser; agentIdentity?: AgentIdentity }
  /**
   * Answer `401` with {@link authRequiredBody}, or `403` with `refusal` when an
   * agent computer refuses a write it does not allow an agent.
   */
  | { allowed: false; refusal?: AgentComputerWriteRefusal };

/**
 * Decide whether a request may pass the session gate, and who it is.
 *
 * The chain (`http/api-chain.ts`) asks it for every request, `/mcp` among
 * them. What a request needs comes from where it came from
 * ({@link gateAccessFor}, ADR 261015-125850): a person at this computer passes
 * with nothing unless "Ask for a password on this computer too" is on; another
 * device always needs a session cookie or a per-user key; a relayed caller is
 * never admitted here. Writes bypass the signed cookie cache and check the
 * current server session without renewing it; GET/HEAD/OPTIONS keep cached
 * session reads.
 *
 * @param method - The request method.
 * @param path - The path the chain's router matches, without the query string.
 * @param request - The request's facts: headers, TCP peer and ingress.
 * @param access - What the request needs; computed from `request` when omitted.
 * @returns The decision.
 */
export async function decideSessionGate(
  method: string,
  path: string,
  request: Pick<RequestFacts, 'headers' | 'peerAddress' | 'ingress'>,
  access: GateAccess = gateAccessFor(request)
): Promise<SessionGateDecision> {
  // Normalize case before the gate checks. The router matches case-sensitively
  // today, but the server ran on Express for years, where `/API/sessions`
  // reached the same handler as `/api/sessions`; a gate that trusts the router's
  // case rule is one router change away from letting an uppercased prefix slip
  // past `isSessionGatedPath` to a gated route.
  const lowered = path.toLowerCase();

  // A sealed agent computer gates every path and admits no person: before the
  // exemptions below, which exist so a person can load the app and sign in.
  // It is handed the path as the router matches it, not `lowered`: it reads
  // what it refuses loosely and what it lets through exactly, case and all.
  if (access === 'agent') return decideAgentComputerGate(method, path, request.headers);

  // Only the API surface and the MCP endpoint are gated; SPA assets pass so the
  // login screen can load. The Better Auth endpoints and the health probe are
  // always reachable.
  if (!isSessionGatedPath(lowered) || isExemptPath(lowered)) return { allowed: true };

  if (access === 'open') return { allowed: true };
  if (access === 'refused') return { allowed: false };

  // A signed cache may outlive a revoked session. Writes must observe the current
  // server row; GET/HEAD/OPTIONS keep the existing cache behavior for stream reads.
  const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  const user = await verifyRequestAuth(
    request,
    readOnly ? {} : { sessionFreshness: 'server-store' }
  );
  return user ? { allowed: true, user } : { allowed: false };
}
