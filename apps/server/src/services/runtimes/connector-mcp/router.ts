/** Stateless Streamable HTTP router for authenticated connector runtime calls. */
import { Router } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ServerPrincipalProof } from '../../connectors/principal/server-principal.js';
import type { ConnectorRuntimeAuthLocals } from './auth.js';

/** Builds the exact connector-only capability projection for one principal. */
export type ConnectorRuntimeMcpServerFactory = (principal: ServerPrincipalProof) => McpServer;

/**
 * Create the authenticated connector runtime MCP router.
 *
 * Authentication middleware must run before this router. A missing principal is
 * treated as a composition failure and still fails closed.
 *
 * @param serverFactory - Broker-owned exact connector capability projection.
 * @returns Stateless MCP router.
 */
export function createConnectorRuntimeMcpRouter(
  serverFactory: ConnectorRuntimeMcpServerFactory
): Router {
  const router = Router();
  router.post('/', async (req, res) => {
    const principal = (res.locals as ConnectorRuntimeAuthLocals).connectorPrincipal;
    if (!principal) {
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      });
      return;
    }

    const server = serverFactory(principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.once('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
          id: null,
        });
      }
    }
  });
  router.all('/', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null,
    });
  });
  return router;
}
