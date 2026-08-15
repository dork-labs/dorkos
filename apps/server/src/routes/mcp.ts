import { Router } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getRequestAgentIdentity } from '../middleware/agent-identity.js';
import type { AgentIdentity } from '../services/core/agent-identity/agent-identity-service.js';
import type { RequestUser } from '../services/core/auth/index.js';
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
  /** The signed-in person behind the call, when login is on and one was verified. */
  userId?: string;
}

/**
 * Create an Express router for the MCP Streamable HTTP endpoint.
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
 */
export function createMcpRouter(serverFactory: (caller: McpCaller) => McpServer): Router {
  const router = Router();

  // POST: JSON-RPC tool calls (primary endpoint)
  router.post('/', async (req, res) => {
    try {
      const identity = getRequestAgentIdentity(res);
      // Filled by `createMcpAuth` on the login-on identity branch; absent on
      // every tokenless path, which is exactly the fact downstream must keep.
      const user = res.locals.user as RequestUser | undefined;
      const server = serverFactory({
        ...(identity ? { identity } : {}),
        ...(user ? { userId: user.userId } : {}),
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      // Clean up per-request server+transport when the response closes.
      // Removes internal Protocol event listeners (per SDK stateless example).
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    } catch (err) {
      logger.error('[MCP] Request handling error', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
          id: null,
        });
      }
    }
  });

  // GET: Server-initiated SSE stream — not needed in stateless mode
  router.get('/', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed. This server operates in stateless mode.',
      },
      id: null,
    });
  });

  // DELETE: Session termination — not applicable in stateless mode
  router.delete('/', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed. This server operates in stateless mode.',
      },
      id: null,
    });
  });

  return router;
}
