/**
 * A stateless Streamable HTTP MCP answer for test fixtures: a fresh server and
 * transport per POST, the SDK's stateless pattern and the shape `routes/mcp.ts`
 * serves in production (the web-standard transport behind a Hono route).
 *
 * ```ts
 * const app = new Hono<NodeEnv>();
 * app.post('/mcp', (c) => answerStatelessMcp(c, buildServer()));
 * target.mount(honoListener(app));
 * ```
 *
 * @module services/__tests__/stateless-mcp
 */
import type { HttpBindings } from '@hono/node-server';
import type { Context } from 'hono';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

/** A Hono app served by `@hono/node-server`, so a route can see the Node response. */
export type NodeEnv = { Bindings: HttpBindings };

/**
 * Answer one MCP request with `server`, then close the server and its
 * transport once the Node response closes (after a streamed answer's last
 * event).
 *
 * @param c - The Hono context of the POST.
 * @param server - A fresh, unconnected MCP server for this request.
 * @param parsedBody - The JSON body, when the route already read it (the
 *   request body can be read only once); omit to let the transport read it.
 * @returns The transport's answer.
 */
export async function answerStatelessMcp(
  c: Context<NodeEnv>,
  server: McpServer,
  parsedBody?: unknown
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  c.env.outgoing.once('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw, parsedBody === undefined ? undefined : { parsedBody });
}
