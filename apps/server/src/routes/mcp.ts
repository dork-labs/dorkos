import { Router } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../lib/logger.js';

/**
 * Create an Express router for the MCP Streamable HTTP endpoint.
 *
 * Handles POST requests with JSON-RPC bodies. GET and DELETE return 405
 * because this server operates in stateless mode (no session tracking).
 *
 * @param server - The shared McpServer instance with all tools registered
 */
export function createMcpRouter(server: McpServer): Router {
  const router = Router();

  // POST: JSON-RPC tool calls (primary endpoint)
  router.post('/', async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
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
      error: { code: -32000, message: 'Method not allowed. This server operates in stateless mode.' },
      id: null,
    });
  });

  // DELETE: Session termination — not applicable in stateless mode
  router.delete('/', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This server operates in stateless mode.' },
      id: null,
    });
  });

  return router;
}
