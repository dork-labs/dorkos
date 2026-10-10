/**
 * Session gate — the single request gate that runs when local login is enabled
 * (accounts-and-auth P1, task 1.2).
 *
 * When `config.auth.enabled` is `true`, every request to `/api/*` or `/mcp` must
 * present either (a) a valid Better Auth session cookie or (b) a valid per-user
 * API key as `Authorization: Bearer <key>`. When `auth.enabled` is `false` the
 * gate is a zero-overhead pass-through (the flag is read per request, so toggling
 * it needs no restart).
 *
 * ## Exemptions (always reach their handler, even when enabled)
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
 *
 * The credential check is factored into {@link verifyRequestAuth}, a single
 * verification path (session cookie, then Bearer API key) that the rewritten MCP
 * auth middleware also reuses — no duplication.
 *
 * @module services/core/auth/session-gate
 */
import type { Request, Response, NextFunction } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { configManager } from '../config-manager.js';
import { logger } from '../../../lib/logger.js';
// `getAuth` is a hoisted accessor called at request time, so this back-import to
// the auth barrel (which re-exports this module) is a safe function-level cycle.
import { getAuth, captureOriginalRequestAuthReader, type Auth } from './index.js';
import type { RequestFacts } from '../../../http/request-facts.js';

/** The identity resolved from a request's credentials, attached to `res.locals.user`. */
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
}

interface OriginalRequestAdmission {
  req: Pick<Request, 'headers'>;
  auth: Auth;
  reader: NonNullable<ReturnType<typeof captureOriginalRequestAuthReader>>;
  headers: Readonly<Request['headers']>;
  userId: string;
  credential: RequestUser['credential'];
  credentialId?: string;
  getSession: Auth['api']['getSession'];
  sessionId?: string;
}
const originalRequestAdmissions = new WeakMap<object, OriginalRequestAdmission>();
const originalAdmissionApply = Reflect.apply;
const originalAdmissionGet = WeakMap.prototype.get;
const originalAdmissionSet = WeakMap.prototype.set;
const originalAdmissionFreeze = Object.freeze;
const originalAdmissionCreate = Object.create;
const originalAdmissionDefine = Object.defineProperty;
const originalAdmissionKeys = Object.keys;
const originalAdmissionArray = Array.isArray;
function admittedHeaders(req: Pick<Request, 'headers'>): Readonly<Request['headers']> {
  const result: Request['headers'] = originalAdmissionCreate(null);
  const keys = originalAdmissionKeys(req.headers);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index],
      value = req.headers[key];
    let saved = value;
    if (originalAdmissionArray(value)) {
      const copy: string[] = [];
      for (let part = 0; part < value.length; part++) copy[part] = value[part];
      originalAdmissionFreeze(copy);
      saved = copy;
    }
    originalAdmissionDefine(result, key, { value: saved, enumerable: true });
  }
  return originalAdmissionFreeze(result);
}
function sameAdmittedHeaders(
  req: Pick<Request, 'headers'>,
  headers: Readonly<Request['headers']>
): boolean {
  const keys = originalAdmissionKeys(headers);
  if (originalAdmissionKeys(req.headers).length !== keys.length) return false;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index],
      left = req.headers[key],
      right = headers[key];
    if (originalAdmissionArray(right)) {
      if (!originalAdmissionArray(left) || left.length !== right.length) return false;
      for (let part = 0; part < right.length; part++) if (left[part] !== right[part]) return false;
    } else if (left !== right) return false;
  }
  return true;
}
/**
 * Recheck only the exact original admitted request without another quota charge.
 * @param req - The original request object which paid admission.
 * @param principal - The exact original verifier result, never a copied DTO.
 * @returns Whether the same credential and initialized authority remain current.
 */
export async function recheckAdmittedRequestAuth(
  req: Pick<Request, 'headers'>,
  principal: RequestUser | undefined
): Promise<boolean> {
  try {
    const own: OriginalRequestAdmission | undefined =
      principal &&
      originalAdmissionApply(originalAdmissionGet, originalRequestAdmissions, [principal]);
    if (!own) return false;
    const current = (): boolean =>
      own.req === req &&
      own.auth === getAuth() &&
      own.reader.current() &&
      principal!.userId === own.userId &&
      principal!.credential === own.credential &&
      principal!.credentialId === own.credentialId &&
      sameAdmittedHeaders(req, own.headers);
    if (!current()) return false;
    if (own.credential === 'cookie') {
      const session = await originalAdmissionApply(own.getSession, own.auth.api, [
        {
          headers: fromNodeHeaders(own.headers),
          query: { disableCookieCache: true, disableRefresh: true },
        },
      ]);
      return (
        current() &&
        session?.user?.id === own.userId &&
        Boolean(own.sessionId) &&
        session?.session?.id === own.sessionId
      );
    }
    const token = extractBearerToken(own.headers.authorization);
    if (!token || !own.credentialId) return false;
    const valid = await own.reader.apiKeyCurrent(token, own.credentialId, own.userId);
    return valid && current();
  } catch {
    return false;
  }
}

/** Paths the gate protects: the API surface and the external MCP endpoint. */
function isGatedPath(path: string): boolean {
  return path.startsWith('/api/') || path === '/mcp' || path.startsWith('/mcp/');
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
 * Express matches non-strictly and collapses nothing, so `/api/health/deep/`
 * and `/api/health/deep//` reach the same handler as `/api/health/deep`. An
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
 * sign-in is reachable) and the health probe.
 */
function isExemptPath(path: string): boolean {
  if (isGatedHealthPath(path)) return false;
  return (
    path.startsWith('/api/auth/') ||
    path === '/api/health' ||
    path.startsWith('/api/health/') ||
    // Signed-token-authorized embedded-browser content (see the module doc).
    path.startsWith('/api/workbench/serve/')
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
 * Shared by {@link sessionGate}, the MCP auth middleware, and the WebSocket
 * upgrade gate so there is exactly one credential-verification path.
 *
 * It takes only the HEADERS rather than an Express `Request`, because the third
 * caller has no request: a WebSocket upgrade arrives on the HTTP server's
 * `upgrade` event as a bare `IncomingMessage`, having bypassed every piece of
 * middleware including {@link sessionGate}. Headers are all this ever read, so
 * narrowing the parameter is what lets the upgrade path reuse this instead of
 * growing a second, drifting copy of the credential check.
 *
 * Each returning path names the credential it verified, because a caller holding
 * a per-user API key is not the same principal as a person in a browser session
 * and a few writes turn on telling them apart (see {@link RequestUser}).
 *
 * @param req - Anything carrying the request's headers — a request's facts
 *   (`expressRequestFacts` or `honoRequestFacts`), or the raw `IncomingMessage`
 *   of a WebSocket upgrade.
 * @param options - See {@link VerifyRequestAuthOptions}. Omit unless the caller
 *   already knows what the request's bearer is.
 * @returns The resolved identity and how it was proved, or `null` when
 *   unauthenticated.
 */
export async function verifyRequestAuth(
  req: Pick<RequestFacts, 'headers'>,
  options: VerifyRequestAuthOptions = {}
): Promise<RequestUser | null> {
  const auth = getAuth();
  // Auth was never initialized (e.g. a unit test app built without initAuth):
  // nothing can be verified, so treat every request as unauthenticated.
  if (!auth) return null;
  const reader = captureOriginalRequestAuthReader(auth);
  let originalHeaders: Readonly<Request['headers']>;
  try {
    originalHeaders = admittedHeaders(req);
  } catch {
    return null;
  }
  const originalGetSession = auth.api.getSession;
  const originalVerifyApiKey = auth.api.verifyApiKey;
  const retainAdmission = (principal: RequestUser, sessionId?: string): RequestUser => {
    if (reader?.current() && sameAdmittedHeaders(req, originalHeaders))
      originalAdmissionApply(originalAdmissionSet, originalRequestAdmissions, [
        principal,
        {
          req,
          auth,
          reader,
          headers: originalHeaders,
          userId: principal.userId,
          credential: principal.credential,
          credentialId: principal.credentialId,
          getSession: originalGetSession,
          sessionId,
        },
      ]);
    return principal;
  };

  // 1. Session cookie — verified against the cookie cache / DB.
  try {
    const result = await originalAdmissionApply(originalGetSession, auth.api, [
      {
        headers: fromNodeHeaders(req.headers),
        ...(options.sessionFreshness === 'server-store'
          ? { query: { disableCookieCache: true, disableRefresh: true } }
          : {}),
      },
    ]);
    if (result?.user?.id) {
      return retainAdmission({ userId: result.user.id, credential: 'cookie' }, result.session.id);
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
      const result = await originalAdmissionApply(originalVerifyApiKey, auth.api, [
        { body: { key: token } },
      ]);
      // The apiKey plugin stores the owning user id in `referenceId`. Require it
      // to be non-empty: a valid key must resolve to an owner, never `''`.
      if (result.valid && result.key?.referenceId) {
        const principal: RequestUser = {
          userId: result.key.referenceId,
          credential: 'api-key',
          credentialId: result.key.id,
        };
        return result.key.configId === 'default' ? retainAdmission(principal) : principal;
      }
    } catch (error) {
      logger.debug('[Auth] API key verification failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}

/**
 * Express middleware that gates `/api/*` and `/mcp` behind a Better Auth session
 * cookie or a per-user API key when `config.auth.enabled` is `true`.
 * Writes bypass the signed cookie cache and check the current server session
 * without renewing it; GET/HEAD/OPTIONS retain cached session reads.
 *
 * Registered app-wide (before the API routes) so it also covers the `/mcp` mount
 * added later on the same app. When login is disabled it is a pass-through with
 * no credential work. On success the resolved identity is attached to
 * `res.locals.user`; on failure it responds `401` with the repo's error shape.
 *
 * @param req - The incoming request.
 * @param res - The response (identity is attached to `res.locals.user` on success).
 * @param next - Passes control to the next handler when the request is allowed.
 */
export async function sessionGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Zero-overhead pass-through when login is disabled. Read per request so the
  // flag can flip at runtime (enable-login flow) without a server restart.
  if (!configManager.get('auth')?.enabled) {
    next();
    return;
  }

  // Express matches routes case-insensitively by default ('case sensitive
  // routing' is off), so `/API/sessions` resolves to the same handler as
  // `/api/sessions`. Normalize case before the gate checks — otherwise an
  // uppercased prefix would slip past `isGatedPath` yet still reach the gated
  // route, bypassing auth entirely.
  const path = req.path.toLowerCase();

  // Only the API surface and the MCP endpoint are gated; SPA assets pass so the
  // login screen can load.
  if (!isGatedPath(path)) {
    next();
    return;
  }

  // The Better Auth endpoints and the health probe are always reachable.
  if (isExemptPath(path)) {
    next();
    return;
  }

  // A signed cache may outlive a revoked session. Writes must observe the current
  // server row; GET/HEAD/OPTIONS keep the existing cache behavior for stream reads.
  const readOnly = ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase());
  const user = await verifyRequestAuth(req, readOnly ? {} : { sessionFreshness: 'server-store' });
  if (user) {
    res.locals.user = user;
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
}
