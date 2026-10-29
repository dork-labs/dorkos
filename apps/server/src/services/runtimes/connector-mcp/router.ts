/** Stateless Streamable HTTP routes for authenticated connector runtime calls. */
import { MCP_MAX_REQUEST_BODY_BYTES } from '../../core/capabilities/mcp-input/limits.js';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono } from 'hono';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ServerPrincipalProof } from '../../connectors/principal/server-principal.js';
import { CONNECTOR_RUNTIME_REFUSAL, type ConnectorRuntimeEnv } from './auth.js';

/** Builds the exact connector-only capability projection for one principal. */
export type ConnectorRuntimeMcpServerFactory = (
  principal: ServerPrincipalProof
) => McpServer | null | Promise<McpServer | null>;

/**
 * Create the authenticated connector runtime MCP routes.
 *
 * Authentication middleware must run before these routes. A missing principal
 * is treated as a composition failure and still fails closed.
 *
 * The MCP transport writes the Node response itself, so the headers the
 * listener decided before the route (its rate-limit headers) are copied onto
 * that response first, as Express set them there.
 *
 * @param serverFactory - Broker-owned exact connector capability projection.
 * @returns Stateless MCP routes, mounted at one path.
 */
export function createConnectorRuntimeMcpRoutes(
  serverFactory: ConnectorRuntimeMcpServerFactory
): Hono<ConnectorRuntimeEnv> {
  const router = new Hono<ConnectorRuntimeEnv>();
  router.post('/', async (c) => {
    const principal = c.get('connectorPrincipal');
    if (!principal) return c.json(CONNECTOR_RUNTIME_REFUSAL, 401);

    const server = await serverFactory(principal);
    if (!server) {
      return c.json(
        { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
        401
      );
    }
    const { incoming, outgoing } = c.env;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES,
    });
    outgoing.once('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    c.res.headers.forEach((value, name) => outgoing.setHeader(name, value));
    try {
      await server.connect(transport);
      await transport.handleRequest(incoming, outgoing, c.get('body'));
    } catch {
      if (!outgoing.headersSent) {
        return c.json(
          { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null },
          500
        );
      }
    }
    // A fresh marker each time: the shared one has mutable headers.
    return new Response(null, { headers: RESPONSE_ALREADY_SENT.headers });
  });
  router.all('/', (c) =>
    c.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null },
      405
    )
  );
  return router;
}
