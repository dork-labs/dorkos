/**
 * The external MCP endpoint, `/mcp`: Streamable HTTP, stateless, on the Hono
 * chain (DOR-2808, `plans/2026-10-express-to-hono.md` item 17).
 *
 * `/mcp` is not under `/api`, but it runs the same chain every moved route
 * does (`http/api-chain.ts`): the body is parsed there once, the session gate
 * covers `/mcp` when login is on, and the audit actor names the surface. Then
 * its own gates, in this order, as Express ran them:
 *
 * 1. the browser `Origin` check (`middleware/mcp-origin.ts`), a JSON-RPC 403;
 * 2. the on/off switch (`middleware/mcp-enabled.ts`), a JSON-RPC 503;
 * 3. the fail-closed credential check (`middleware/mcp-auth.ts`), a JSON-RPC
 *    401, which reads the parsed body for the tokenless read-only carve-out;
 * 4. the rate limiter (`middleware/mcp-rate-limit.ts`), a JSON-RPC 429.
 *
 * The transport is the MCP SDK's web-standard one, handed the same parsed body
 * the credential check read, so the request stream is read once.
 * `http/__tests__/contract/mcp-groups.contract.test.ts` pins the answers.
 *
 * @module routes/mcp
 */
import { Hono } from 'hono';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { honoMcpAuth } from '../middleware/mcp-auth.js';
import { requireMcpEnabled } from '../middleware/mcp-enabled.js';
import { validateMcpOrigin } from '../middleware/mcp-origin.js';
import { buildMcpRateLimiter } from '../middleware/mcp-rate-limit.js';
import type { AgentIdentity } from '../services/core/agent-identity/agent-identity-service.js';
import { logger } from '../lib/logger.js';

/**
 * Who made one MCP request, as the per-request server factory is told it.
 *
 * Two independent facts, and neither implies the other: a machine principal
 * presented an agent token, and/or a person presented a credential the auth
 * middleware verified. Both absent is the ordinary login-off case.
 */
export interface McpCaller {
  /** The agent behind the call, from `X-DorkOS-Agent`. */
  identity?: AgentIdentity;
  /**
   * Whether an `X-DorkOS-Agent` header was there at all, resolved or not.
   *
   * A THIRD fact, and the one the pair above cannot express: a token that
   * resolves to NOTHING — one from no agent at all — still says a machine is
   * calling. Without it a capability that resolves the caller to a domain
   * principal reads "no agent token" and, on a login-off install, answers with
   * the operator — which is how `post_to_room` came to write under the person's
   * name (DOR-1361). Never an authorization: the tier gate is unchanged by it.
   *
   * **A revoked or expired token is no longer one of those cases** (DOR-486): it
   * fills {@link identity} with an `inactive` mark instead of leaving it empty,
   * so the capability gate can tell a shut-off agent from a stranger. The
   * consumers that key on presence therefore test the mark AS WELL as this flag
   * — see `rooms/room-capabilities.ts` and `mesh/mcp-capability-deps.ts`.
   */
  agentIdentityPresented?: boolean;
  /** The signed-in person behind the call, when login is on and one was verified. */
  userId?: string;
  /**
   * Set only by the tool bridge (`services/core/tool-bridge/`), never from a
   * request: the call came from an agent computer, so it is never a person's.
   * {@link mcpCallerIdentity} carries it onto the identity, where every gate
   * reads it. The `/mcp` route never sets it.
   */
  callerKind?: 'agent-computer';
}

/**
 * The identity a per-request server acts as: the caller's agent, marked when
 * the call came over the tool bridge. Every factory builds its server with
 * this, so the mark cannot be dropped on the way to the gate.
 *
 * @param caller - Who made the call.
 */
export function mcpCallerIdentity(caller: McpCaller): AgentIdentity | undefined {
  if (!caller.identity) return undefined;
  return caller.callerKind ? { ...caller.identity, via: caller.callerKind } : caller.identity;
}

/** Builds a fresh MCP server per request, specialized to whoever is calling. */
export type McpServerFactory = (caller: McpCaller) => McpServer | Promise<McpServer>;

/** The answer to a GET or DELETE: there is no stream or session to reach. */
const STATELESS_REFUSAL = {
  jsonrpc: '2.0',
  error: {
    code: -32000,
    message: 'Method not allowed. This server operates in stateless mode.',
  },
  id: null,
} as const;

/** The answer when the server or transport could not be built or failed. */
const INTERNAL_ERROR = {
  jsonrpc: '2.0',
  error: { code: -32603, message: 'Internal error' },
  id: null,
} as const;

/**
 * Create the `/mcp` routes: the endpoint's own gates, in order, in front of
 * {@link createMcpEndpoint}. Mount at `/mcp` on the app `createApiApp` builds.
 *
 * The rate limiter is built here, once, from the config at that moment: a
 * change to `mcp.rateLimit` takes effect after a restart.
 *
 * @param serverFactory - Creates a fresh McpServer instance per request,
 *   specialized to whoever is calling.
 * @returns The routes.
 */
export function createMcpRoutes(serverFactory: McpServerFactory): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  // On `/` only, so the front door claims `/mcp` and nothing below it.
  router.use('/', validateMcpOrigin, requireMcpEnabled, honoMcpAuth('mcp'), buildMcpRateLimiter());
  router.route('/', createMcpEndpoint(serverFactory));
  return router;
}

/**
 * Create the MCP Streamable HTTP endpoint itself, with no gates in front of it.
 * It reads what the chain decided: the parsed body, the agent identity, and
 * the person a credential proved.
 *
 * Handles POST requests with JSON-RPC bodies. GET and DELETE return 405
 * because this server operates in stateless mode (no session tracking).
 *
 * In stateless mode, both a fresh McpServer and transport are created per
 * request (per MCP SDK docs). The `McpServer.connect()` method binds a
 * server to a transport and cannot be called twice on the same instance.
 *
 * Because the server is built per request, it can capture request-scoped
 * context: the factory receives who the caller is — the agent identity resolved
 * from the call's `X-DorkOS-Agent` header, and the signed-in person the auth
 * middleware verified, either of which may be absent — so capability
 * invocations made through this transport are attributed to whoever made them.
 *
 * **Both, not one.** An agent token and a person's credential answer different
 * questions and a surface can hold neither, one, or both. Collapsing "no agent
 * token" into "the install owner" downstream is the bug this second field
 * exists to make impossible (see `CapabilityInvocationContext.userId`).
 *
 * @param serverFactory - Creates a fresh McpServer instance per request,
 *   specialized to whoever is calling.
 * @returns The endpoint's routes.
 */
export function createMcpEndpoint(serverFactory: McpServerFactory): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  // POST: JSON-RPC tool calls (primary endpoint)
  router.post('/', async (c) => {
    try {
      const identity = c.get('agentIdentity');
      // The wider question, asked from the raw header so a token that did not
      // resolve is still reported as a machine calling.
      const agentIdentityPresented = presentsAgentIdentity(honoRequestFacts(c));
      // Filled by the credential check on the identity branch, or by the
      // session gate once login is on; absent on every tokenless path, which
      // is exactly the fact downstream must keep.
      const user = c.get('user');
      const server = await serverFactory({
        ...(identity ? { identity } : {}),
        ...(agentIdentityPresented ? { agentIdentityPresented } : {}),
        ...(user ? { userId: user.userId } : {}),
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      // Clean up the per-request server and transport when the response
      // closes, which for a streamed answer is after its last event. Removes
      // internal Protocol event listeners (per SDK stateless example).
      c.env.outgoing.once('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      // The body the chain parsed, which the credential check classified. A
      // body it did not parse (no JSON content type) is left on the request
      // for the transport to read and refuse itself.
      return await transport.handleRequest(c.req.raw, { parsedBody: readJsonBody(c) });
    } catch (err) {
      logger.error('[MCP] Request handling error', err);
      return c.json(INTERNAL_ERROR, 500);
    }
  });

  // GET: Server-initiated SSE stream — not needed in stateless mode
  router.get('/', (c) => c.json(STATELESS_REFUSAL, 405));

  // DELETE: Session termination — not applicable in stateless mode
  router.delete('/', (c) => c.json(STATELESS_REFUSAL, 405));

  return router;
}
