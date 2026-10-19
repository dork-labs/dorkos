import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { MiddlewareHandler } from 'hono';
import { env } from '../env.js';
import { configManager } from '../services/core/config-manager.js';
import { gateAccessFor } from '../services/core/auth/gate-policy.js';
import { ingressOf, type RequestIngress } from '../services/core/remote/ingress-mark.js';
import { verifyRequestAuth } from '../services/core/auth/index.js';
import { requestSessionRoute } from '../services/core/auth/sessions/session-route.js';
import { getMcpLocalToken, getMcpLocalTokenPath } from '../services/core/auth/mcp-local-token.js';
import type { RequestUser } from '../services/core/auth/session-gate.js';
import { READ_ONLY_MCP_TOOL_NAMES } from '../services/core/external-mcp/tool-security.js';
import { readJsonBody, type RequestBodyEnv } from '../http/request-body.js';

/**
 * The surface a {@link honoMcpAuth} middleware guards. Both surfaces share the
 * same credential acceptors; they differ only in the fallback for a person at
 * this computer that does not ask for a password:
 *   - `'mcp'` applies the read-only capability carve-out (discovery + read-only
 *     tools stay tokenless; mutating calls require the token).
 *   - `'a2a'` gates all JSON-RPC execution (POST) and leaves agent-card discovery
 *     (GET) open — A2A has no read/write annotation to carve on.
 */
export type McpAuthSurface = 'mcp' | 'a2a';

/** A JSON-RPC 2.0 error envelope, the shape of every refusal on both surfaces. */
export interface McpAuthRefusalBody {
  readonly jsonrpc: '2.0';
  readonly error: { readonly code: number; readonly message: string };
  readonly id: null;
}

/** What {@link decideMcpAuth} decided about one request. */
export type McpAuthDecision =
  | {
      readonly allowed: true;
      /** The person a credential proved, when one did (acceptor 2). */
      readonly user?: RequestUser;
      /** The caller proved the per-install local token (acceptor 4). */
      readonly mcpLocalToken?: true;
    }
  /** Answer `401` with `body`. */
  | { readonly allowed: false; readonly body: McpAuthRefusalBody };

/** The request facts {@link decideMcpAuth} reads. */
export interface McpAuthRequest {
  /** The request method. */
  readonly method: string;
  /** The raw request headers. */
  readonly headers: IncomingHttpHeaders;
  /** The parsed JSON body, or `undefined` when none was parsed. */
  readonly body: unknown;
  /** The TCP peer address, for where the request came from. */
  readonly peerAddress: string | undefined;
  /** Which listener admitted the request. */
  readonly ingress: RequestIngress;
}

/**
 * Decide whether a request to the external `/mcp` endpoint or the `/a2a`
 * gateway (DOR-278) may go on. {@link honoMcpAuth} asks it for both, and the
 * policy stays framework-free so it lives in one place.
 *
 * Credential acceptors run first on **both** surfaces and allow on first match:
 *   1. `env.MCP_API_KEY` — a static override for headless deployments (exact,
 *      constant-time). Highest priority, un-revocable from the UI.
 *   2. A per-user Better Auth API key (or session cookie) via the shared
 *      {@link verifyRequestAuth} — the identity path. When the bearer
 *      is this instance's own local MCP token the API-key half of that check is
 *      skipped (it could not match, and the apiKey plugin logs an untagged
 *      error on the way to saying so); the cookie half still runs, so which
 *      acceptor allows a request — and the identity recorded for it — is
 *      exactly what it was.
 *   3. Legacy compat window: the not-yet-seeded `config.mcp.apiKey`, accepted
 *      exactly until {@link seedLegacyMcpApiKey} folds it into a Better Auth key.
 *   4. The per-instance local MCP token from {@link getMcpLocalToken}, **only
 *      for a caller at this computer that does not ask for a password** — the
 *      replacement for the deleted zero-config
 *      passthrough (the security hole this change closes).
 *
 * When no acceptor matches:
 *   - **Asked for a key** (another device always; this computer when it asks
 *     for a password; a hub): 401 on both surfaces — no tokenless path, the local token is
 *     never consulted (per-user keys / env key are the only credentials).
 *   - **At this computer, `'mcp'`:** the capability carve-out on the parsed JSON-RPC
 *     body — discovery/handshake methods and read-only `tools/call`s
 *     ({@link READ_ONLY_MCP_TOOL_NAMES}) pass tokenless; everything else
 *     (mutating tools, `resources/read`, unknown methods, a batch with any
 *     guarded element, an unparseable body) is 401. **Fail-closed.**
 *   - **At this computer, `'a2a'`:** `GET` (agent-card discovery) passes; `POST`
 *     (JSON-RPC execution) is 401 unless a token was presented.
 *
 * The 401 body is a JSON-RPC 2.0 error envelope (both surfaces speak JSON-RPC)
 * whose message names the `Authorization: Bearer` header, and the token file
 * path only when the local token would work for this caller. It never echoes
 * the token value.
 *
 * @param surface - The surface the request reached.
 * @param request - Its method, headers and parsed body.
 * @returns The decision.
 */
export async function decideMcpAuth(
  surface: McpAuthSurface,
  request: McpAuthRequest
): Promise<McpAuthDecision> {
  const token = extractBearerToken(request.headers.authorization);
  // Trim-for-presence: a whitespace-only MCP_API_KEY counts as unset, matching
  // the boot wiring, the token module, and the config DTO.
  const envKey = env.MCP_API_KEY?.trim() || null;
  const legacyKey = configManager.get('mcp')?.apiKey ?? null;
  // Per caller kind, not one global flag (ADR 261015-125850 rule 3): only a
  // person at this computer that does not ask for a password gets the local
  // token and the tokenless read-only paths; every other caller needs a key.
  const access = gateAccessFor(request);
  if (access === 'refused') return { allowed: false, body: unauthorizedBody(surface, false) };
  const asksForKey = access !== 'open';

  // 1. Static env override — exact match, highest priority, un-revocable.
  if (envKey && token && constantTimeEquals(token, envKey)) return { allowed: true };

  // Acceptor 4's own test, hoisted so acceptor 2 can be told what this bearer
  // is — same `!asksForKey` gate and same read (`getMcpLocalToken()` reads
  // the file once, on first use, then answers from its cache, and never
  // throws), so it can only be true where acceptor 4 would itself have matched.
  const localToken = asksForKey ? null : getMcpLocalToken();
  const bearerIsLocalToken = !!localToken && !!token && constantTimeEquals(token, localToken);

  // 2. Per-user Better Auth API key or session cookie (shared verifier).
  //
  // The local token is minted into a `0600` file and never written to the
  // `apikey` table, so it provably cannot verify as a per-user Better Auth
  // key. Saying so skips a lookup that could only fail — and whose failure the
  // apiKey plugin logs as its own untagged `error` line, roughly four per
  // agent turn on a runtime that reaches `/mcp` over a wire. The
  // cookie half of the verifier still runs, so the identity recorded below is
  // unchanged. The legacy `config.mcp.apiKey` gets no such hint on purpose:
  // `seedLegacyMcpApiKey` stores that exact value AS a Better Auth key, so
  // there it is a real per-user credential acceptor 2 must still resolve.
  //
  // On the Wi-Fi route only a bearer key counts (DOR-2969): a Wi-Fi sign-in's
  // cookie never stands for an agent tool here, whatever bearer rides with it.
  const identity = await verifyRequestAuth(request, {
    ...(bearerIsLocalToken ? { bearerIsNotAnApiKey: true } : {}),
    ...(requestSessionRoute(request) === 'wifi' ? { ignoreSessionCookie: true } : {}),
  });
  // Recorded, not just accepted. A capability that acts on somebody's own
  // data has to know WHICH person is asking, and this is the only place on
  // this surface that ever knows — the same slot the session gate fills, so
  // downstream readers have one shape to read. Discarding it is how
  // "authenticated" collapsed into "the owner".
  if (identity) return { allowed: true, user: identity };

  // 3. Legacy compat window — the not-yet-seeded global config key.
  if (legacyKey && token && constantTimeEquals(token, legacyKey)) return { allowed: true };

  // 4. Per-instance local token. Its `!asksForKey` gate (ADR-0320: the token
  //    is inactive wherever the caller is asked for a key, yielding to per-user keys) lives in
  //    `localToken` above, which is where acceptor 2 needed the same answer.
  //    Named for the audit log: this caller proved the per-install local
  //    token, which is neither a person's key nor an agent's token.
  if (bearerIsLocalToken) return { allowed: true, mcpLocalToken: true };

  // ── No acceptor matched ──────────────────────────────────────────────────
  const refused = { allowed: false, body: unauthorizedBody(surface, !asksForKey) } as const;

  // Asked for a key: no tokenless path on either surface.
  if (asksForKey) return refused;

  // At this computer, A2A: card discovery (GET) is open; execution (POST) is gated.
  if (surface === 'a2a') return request.method === 'GET' ? { allowed: true } : refused;

  // At this computer, MCP: the read-only capability carve-out on the parsed body.
  return isAllowedMcpMessage(request.body) ? { allowed: true } : refused;
}

/** The Hono environment {@link honoMcpAuth} reads and writes. */
export type McpAuthEnv = RequestBodyEnv & {
  Variables: {
    /** Who a credential proved: the session gate's slot, filled here too. */
    user?: RequestUser;
    /** Set when the caller proved the local token; the audit actor reads it. */
    mcpLocalToken?: boolean;
  };
};

/**
 * The credential check as Hono middleware, for `/mcp` and the A2A gateway. It
 * reads the body the chain already parsed (`readJsonBody`), the one the route
 * then hands on. See {@link decideMcpAuth}.
 *
 * @param surface - The surface this middleware guards.
 * @returns A Hono middleware enforcing the surface's auth posture.
 */
export function honoMcpAuth(surface: McpAuthSurface): MiddlewareHandler<McpAuthEnv> {
  return async (c, next) => {
    const decision = await decideMcpAuth(surface, {
      method: c.req.method,
      headers: c.env.incoming.headers,
      body: readJsonBody(c),
      peerAddress: c.env.incoming.socket.remoteAddress,
      ingress: ingressOf(c.env.incoming),
    });
    if (!decision.allowed) return c.json(decision.body, 401);
    if (decision.user) c.set('user', decision.user);
    if (decision.mcpLocalToken) c.set('mcpLocalToken', true);
    await next();
  };
}

/**
 * MCP methods that are always tokenless for a person at this computer that does not ask: the handshake plus
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
 * Classify a single JSON-RPC message: is it allowed tokenless at this computer, on the open
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
 * Whether the parsed request body is allowed tokenless at this computer, on the open `/mcp`
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
 * The helpful JSON-RPC 401 body: it names where to find the token and how to
 * send it, without ever echoing the token value.
 */
function unauthorizedBody(surface: McpAuthSurface, localTokenWorks: boolean): McpAuthRefusalBody {
  return {
    jsonrpc: '2.0',
    error: { code: -32001, message: buildUnauthorizedMessage(surface, localTokenWorks) },
    id: null,
  };
}

/** Build the surface-shaped, token-path-naming 401 message (never the value). */
function buildUnauthorizedMessage(surface: McpAuthSurface, localTokenWorks: boolean): string {
  const subject = surface === 'a2a' ? 'This agent-to-agent call' : 'This DorkOS tool';
  const tokenPath = getMcpLocalTokenPath();
  if (tokenPath && localTokenWorks) {
    return (
      `Unauthorized. ${subject} needs your local MCP token. Find it in ` +
      `Settings → Advanced → Tools → Connect other apps to DorkOS, or in ${tokenPath}, and send it as ` +
      '"Authorization: Bearer <token>".'
    );
  }
  // A caller asked for a key (another device, or this computer when it asks
  // for a password), or an MCP_API_KEY override is the bearer: point at the
  // credential that applies here rather than a local-token file that does not.
  return (
    'Unauthorized. Provide a valid credential as "Authorization: Bearer <token>". ' +
    'Use your personal API key from Settings → Advanced → Tools → Connect other apps to DorkOS.'
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
