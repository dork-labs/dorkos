import { Router } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getRequestAgentIdentity } from '../middleware/agent-identity.js';
import type { AgentIdentity } from '../services/core/agent-identity/agent-identity-service.js';
import { logger } from '../lib/logger.js';

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
 * context: the factory receives the agent identity `resolveAgentIdentity`
 * resolved from the call's `X-DorkOS-Agent` header (`undefined` when the caller
 * presented none), so capability invocations made through this transport are
 * attributed to the agent that made them.
 *
 * @param serverFactory - Creates a fresh McpServer instance per request,
 *   optionally specialized to the calling agent's identity.
 */
export function createMcpRouter(serverFactory: (identity?: AgentIdentity) => McpServer): Router {
  const router = Router();

  // POST: JSON-RPC tool calls (primary endpoint)
  router.post('/', async (req, res) => {
    try {
      const server = serverFactory(getRequestAgentIdentity(res));
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
