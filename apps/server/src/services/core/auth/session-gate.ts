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
 *   can render. Mirrors the `tunnel-auth.ts` pattern (gate only `/api/` paths).
 * - **`/api/auth/*`** — the Better Auth endpoints themselves (sign-in must be
 *   reachable to obtain a cookie).
 * - **`/api/health`** — health/status probe.
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
import { getAuth } from './index.js';

/** The identity resolved from a request's credentials, attached to `res.locals.user`. */
export interface RequestUser {
  /** The Better Auth user id that owns the session cookie or API key. */
  userId: string;
}

/** Paths the gate protects: the API surface and the external MCP endpoint. */
function isGatedPath(path: string): boolean {
  return path.startsWith('/api/') || path === '/mcp' || path.startsWith('/mcp/');
}

/**
 * Paths that always pass while login is enabled: the Better Auth endpoints (so
 * sign-in is reachable) and the health probe.
 */
function isExemptPath(path: string): boolean {
  return path.startsWith('/api/auth/') || path === '/api/health' || path.startsWith('/api/health/');
}

/** Extract the token from an `Authorization: Bearer <token>` header, or `null`. */
function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(' ');
  return scheme === 'Bearer' && token ? token : null;
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
 * Shared by {@link sessionGate} and the MCP auth middleware so there is exactly
 * one credential-verification path.
 *
 * @param req - The incoming Express request (its headers carry the credentials).
 * @returns The resolved `{ userId }`, or `null` when unauthenticated.
 */
export async function verifyRequestAuth(req: Request): Promise<RequestUser | null> {
  const auth = getAuth();
  // Auth was never initialized (e.g. a unit test app built without initAuth):
  // nothing can be verified, so treat every request as unauthenticated.
  if (!auth) return null;

  // 1. Session cookie — verified against the cookie cache / DB.
  try {
    const result = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (result?.user?.id) {
      return { userId: result.user.id };
    }
  } catch (error) {
    logger.debug('[Auth] Session cookie verification failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 2. Bearer API key — verified via the apiKey plugin.
  const token = extractBearerToken(req.headers.authorization);
  if (token) {
    try {
      const result = await auth.api.verifyApiKey({ body: { key: token } });
      // The apiKey plugin stores the owning user id in `referenceId`.
      if (result.valid && result.key) {
        return { userId: result.key.referenceId };
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

  // Only the API surface and the MCP endpoint are gated; SPA assets pass so the
  // login screen can load.
  if (!isGatedPath(req.path)) {
    next();
    return;
  }

  // The Better Auth endpoints and the health probe are always reachable.
  if (isExemptPath(req.path)) {
    next();
    return;
  }

  const user = await verifyRequestAuth(req);
  if (user) {
    res.locals.user = user;
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
}
