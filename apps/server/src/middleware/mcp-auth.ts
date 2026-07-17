import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../env.js';
import { configManager } from '../services/core/config-manager.js';
import { verifyRequestAuth } from '../services/core/auth/index.js';
import { getMcpLocalToken, getMcpLocalTokenPath } from '../services/core/auth/mcp-local-token.js';
import { READ_ONLY_MCP_TOOL_NAMES } from '../services/core/external-mcp/tool-security.js';

/**
 * The surface a {@link createMcpAuth} middleware guards. Both surfaces share the
 * same credential acceptors; they differ only in the login-off fallback:
 *   - `'mcp'` applies the read-only capability carve-out (discovery + read-only
 *     tools stay tokenless; mutating calls require the token).
 *   - `'a2a'` gates all JSON-RPC execution (POST) and leaves agent-card discovery
 *     (GET) open — A2A has no read/write annotation to carve on.
 */
export type McpAuthSurface = 'mcp' | 'a2a';

/**
 * Build the auth middleware for the external `/mcp` endpoint or the `/a2a`
 * gateway (DOR-278).
 *
 * Credential acceptors run first on **both** surfaces and allow on first match:
 *   1. `env.MCP_API_KEY` — a static override for headless deployments (exact,
 *      constant-time). Highest priority, un-revocable from the UI.
 *   2. A per-user Better Auth API key (or session cookie) via the shared
 *      {@link verifyRequestAuth} — the login-on identity path.
 *   3. Legacy compat window: the not-yet-seeded `config.mcp.apiKey`, accepted
 *      exactly until {@link seedLegacyMcpApiKey} folds it into a Better Auth key.
 *   4. The per-instance local MCP token from {@link getMcpLocalToken}, **only
 *      when login is off** — the replacement for the deleted zero-config
 *      passthrough (the security hole this change closes).
 *
 * When no acceptor matches:
 *   - **Login on:** 401 on both surfaces — no tokenless path, the local token is
 *     never consulted (per-user keys / env key are the only credentials).
 *   - **Login off, `'mcp'`:** the capability carve-out on the parsed JSON-RPC
 *     body — discovery/handshake methods and read-only `tools/call`s
 *     ({@link READ_ONLY_MCP_TOOL_NAMES}) pass tokenless; everything else
 *     (mutating tools, `resources/read`, unknown methods, a batch with any
 *     guarded element, an unparseable body) is 401. **Fail-closed.**
 *   - **Login off, `'a2a'`:** `GET` (agent-card discovery) passes; `POST`
 *     (JSON-RPC execution) is 401 unless a token was presented.
 *
 * The 401 body is a JSON-RPC 2.0 error envelope (both surfaces speak JSON-RPC)
 * whose message names the token file path and the `Authorization: Bearer`
 * header, and never echoes the token value.
 *
 * @param options - The surface this middleware guards.
 * @returns An Express middleware enforcing the surface's auth posture.
 */
export function createMcpAuth({
  surface,
}: {
  surface: McpAuthSurface;
}): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async function mcpAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
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

    // 4. Per-instance local token — only when login is off (ADR-0320: the token
    //    is inactive once login is on, yielding to per-user keys).
    if (!authEnabled) {
      const localToken = getMcpLocalToken();
      if (localToken && token && constantTimeEquals(token, localToken)) {
        next();
        return;
      }
    }

    // ── No acceptor matched ──────────────────────────────────────────────────

    // Login on: no tokenless path on either surface.
    if (authEnabled) {
      respondUnauthorized(res, surface);
      return;
    }

    // Login off, A2A: card discovery (GET) is open; execution (POST) is gated.
    if (surface === 'a2a') {
      if (req.method === 'GET') {
        next();
        return;
      }
      respondUnauthorized(res, surface);
      return;
    }

    // Login off, MCP: the read-only capability carve-out on the parsed body.
    if (isAllowedMcpMessage(req.body)) {
      next();
      return;
    }
    respondUnauthorized(res, surface);
  };
}

/**
 * MCP methods that are always tokenless in login-off mode: the handshake plus
 * pure discovery/listing. Any `notifications/*` method is discovery too (handled
 * by prefix in {@link isDiscoveryMethod}).
 */
const MCP_DISCOVERY_METHODS: ReadonlySet<string> = new Set([
  'initialize',
  'ping',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
]);

/** Whether a JSON-RPC method is a tokenless MCP discovery/handshake method. */
function isDiscoveryMethod(method: string): boolean {
  return MCP_DISCOVERY_METHODS.has(method) || method.startsWith('notifications/');
}

/**
 * Classify a single JSON-RPC message: is it allowed tokenless on the login-off
 * `/mcp` surface? Discovery/handshake methods and read-only `tools/call`s pass;
 * everything else (mutating tools, unknown tools, `resources/read`, unknown or
 * missing methods, a non-object) fails closed.
 */
function classifyMcpMessage(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  const method = (msg as { method?: unknown }).method;
  if (typeof method !== 'string') return false;
  if (isDiscoveryMethod(method)) return true;
  if (method === 'tools/call') {
    const params = (msg as { params?: unknown }).params;
    const name =
      typeof params === 'object' && params !== null
        ? (params as { name?: unknown }).name
        : undefined;
    return typeof name === 'string' && READ_ONLY_MCP_TOOL_NAMES.has(name);
  }
  return false;
}

/**
 * Whether the parsed request body is allowed tokenless on the login-off `/mcp`
 * surface. A JSON-RPC batch (array) passes only when every element independently
 * passes; a single message defers to {@link classifyMcpMessage}; an unparseable
 * or missing body fails closed.
 */
function isAllowedMcpMessage(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.length > 0 && body.every(classifyMcpMessage);
  }
  return classifyMcpMessage(body);
}

/**
 * Send a helpful JSON-RPC 401 that names where to find the token and how to send
 * it, without ever echoing the token value.
 */
function respondUnauthorized(res: Response, surface: McpAuthSurface): void {
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: buildUnauthorizedMessage(surface) },
    id: null,
  });
}

/** Build the surface-shaped, token-path-naming 401 message (never the value). */
function buildUnauthorizedMessage(surface: McpAuthSurface): string {
  const subject = surface === 'a2a' ? 'This agent-to-agent call' : 'This DorkOS tool';
  const tokenPath = getMcpLocalTokenPath();
  if (tokenPath) {
    return (
      `Unauthorized. ${subject} needs your local MCP token. Find it in ` +
      `Settings → Server → External MCP, or in ${tokenPath}, and send it as ` +
      '"Authorization: Bearer <token>".'
    );
  }
  // Login on, or an MCP_API_KEY override is the bearer: point at the credential
  // that applies here rather than a local-token file that does not.
  return (
    'Unauthorized. Provide a valid credential as "Authorization: Bearer <token>". ' +
    'When login is on, use your personal API key from Settings → Server → External MCP.'
  );
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
