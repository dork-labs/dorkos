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
 * `config.auth.enabled` is `true` the gate already 401s unauthenticated `/mcp`
 * requests, so this middleware's distinct value is the env override, the legacy
 * compat key, the per-user path while the gate is transparent (login disabled),
 * and the JSON-RPC 401 shape below. On `/a2a` and `/.well-known/agent.json` (which
 * the gate does not cover) it is the sole auth.
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
  if (envKey && token === envKey) {
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
  if (legacyKey && token === legacyKey) {
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

/** Extract the token from an `Authorization: Bearer <token>` header, or `null`. */
function extractBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(' ');
  return scheme === 'Bearer' && token ? token : null;
}
