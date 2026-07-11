import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../env.js';
import { configManager } from '../services/core/config-manager.js';
import { verifyRequestAuth } from '../services/core/auth/index.js';

/**
 * API key authentication middleware for the external `/mcp` endpoint (and the
 * `/a2a` + fleet-card mounts that share it).
 *
 * Resolution order (first acceptor wins):
 *   1. `env.MCP_API_KEY` — a static override for headless deployments. Exact-match
 *      Bearer token, highest priority, cannot be revoked from the UI.
 *   2. A per-user Better Auth API key (or session cookie) via the shared
 *      {@link verifyRequestAuth} — the same identity model as the session gate.
 *   3. Legacy compat window: while a not-yet-seeded `config.mcp.apiKey` value is
 *      present, accept it exactly so existing MCP clients never break mid-upgrade.
 *      The value retires itself once {@link seedLegacyMcpApiKey} runs.
 *   4. Nothing configured and login disabled → pass through (localhost-only access,
 *      the historical zero-config behavior).
 *
 * On `/mcp` this runs *after* the app-wide session gate (task 1.2): when
 * `config.auth.enabled` is `true` the gate 401s an unauthenticated `/mcp` request
 * before this middleware runs (`verifyRequestAuth` does not recognize the env key),
 * so on `/mcp` this middleware only decides while the gate is transparent (login
 * disabled) — via the env override, the legacy compat key, or the per-user path —
 * plus the JSON-RPC 401 shape below. A headless `MCP_API_KEY` deployment that then
 * enables login must switch its `/mcp` clients to a per-user API key. On `/a2a` and
 * the agent-card well-known paths (which the gate does not cover) this middleware — env
 * override included — is the sole auth.
 *
 * Failures respond with the JSON-RPC error shape MCP clients expect.
 */
export async function mcpApiKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractBearerToken(req.headers.authorization);
  const envKey = env.MCP_API_KEY ?? null;
  const legacyKey = configManager.get('mcp')?.apiKey ?? null;
  const authEnabled = configManager.get('auth')?.enabled === true;

  // 1. Static env override — exact match, highest priority, un-revocable.
  if (envKey && token && constantTimeEquals(token, envKey)) {
    next();
    return;
  }

  // 2. Per-user Better Auth API key or session cookie (shared verifier).
  const identity = await verifyRequestAuth(req);
  if (identity) {
    next();
    return;
  }

  // 3. Legacy compat window — the not-yet-seeded global config key.
  if (legacyKey && token && constantTimeEquals(token, legacyKey)) {
    next();
    return;
  }

  // 4. Nothing requires auth (no env key, no legacy key, login disabled): pass
  //    through as localhost-only access, preserving the zero-config experience.
  if (!envKey && !legacyKey && !authEnabled) {
    next();
    return;
  }

  res.status(401).json({
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message: 'Unauthorized. Provide a valid API key via Authorization: Bearer <key>.',
    },
    id: null,
  });
}

/**
 * Compare two secrets in constant time so a wrong key cannot be recovered by
 * timing the response. Length differences are handled without an early return
 * by comparing same-length byte buffers.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** Extract the token from an `Authorization: Bearer <token>` header, or `null`. */
function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}
