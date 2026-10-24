/** Independently authenticated loopback listener for runtime connector tools. */
import { MCP_MAX_REQUEST_BODY_BYTES } from '../../core/capabilities/mcp-input/limits.js';
import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import bodyParser from 'body-parser';
import { Hono } from 'hono';
import type { ConnectorRuntimePrincipalPort } from '../../connectors/runtime-principal-port.js';
import { createConnectorRuntimeAuth, type ConnectorRuntimeEnv } from './auth.js';
import { buildConnectorRuntimeRateLimiter } from './rate-limit.js';
import {
  createConnectorRuntimeMcpRoutes,
  type ConnectorRuntimeMcpServerFactory,
} from './router.js';
import { clearsConnectorRuntimeLoopback, LOOPBACK_REFUSAL } from './socket-origin.js';

/** Construction options for the internal connector runtime listener. */
export interface ConnectorRuntimeMcpListenerOptions {
  /** Server-owned bearer resolver. Boot initialization must already be complete. */
  readonly principals: ConnectorRuntimePrincipalPort;
  /** Broker-owned factory exposing only connector execution capabilities. */
  readonly serverFactory: ConnectorRuntimeMcpServerFactory;
  /** Agent-safe DorkOS capability projection served on the agent route. */
  readonly agentServerFactory: ConnectorRuntimeMcpServerFactory;
  /** Loopback port; zero asks the OS for an unused port. */
  readonly port?: number;
  /** Test-only rate ceiling override. */
  readonly maxRequestsPerMinute?: number;
}

/** Running listener handle consumed by the server composition root. */
export interface ConnectorRuntimeMcpListener {
  /** Absolute loopback MCP URL injected into runtimes. */
  readonly url: string;
  /** Loopback MCP URL exposing only capabilities declared for agent sessions. */
  readonly agentUrl: string;
  /** Stop accepting requests and close the listener. */
  close(): Promise<void>;
}

/** Close a Node listener once, including idle keep-alive connections. */
async function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** The JSON-RPC answer to a body that could not be read, and to any other error. */
const PARSE_ERROR = { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null };

const parseJson = bodyParser.json({ limit: MCP_MAX_REQUEST_BODY_BYTES });

/**
 * The listener's routes and middleware, in Express's order: the rate limit,
 * the bearer, the JSON body, then the two MCP paths.
 */
function createListenerApp(options: ConnectorRuntimeMcpListenerOptions): Hono<ConnectorRuntimeEnv> {
  const app = new Hono<ConnectorRuntimeEnv>({ strict: false });
  // Every error, a body that could not be parsed among them, is a parse error
  // to an MCP client, as the Express listener answered it. A response the MCP
  // transport already started is left to finish.
  app.onError((_error, c) =>
    c.env.outgoing.headersSent
      ? new Response(null, { headers: RESPONSE_ALREADY_SENT.headers })
      : c.json(PARSE_ERROR, 400)
  );
  app.use(
    buildConnectorRuntimeRateLimiter({
      ...(options.maxRequestsPerMinute !== undefined
        ? { maxPerWindow: options.maxRequestsPerMinute }
        : {}),
    })
  );
  app.use(createConnectorRuntimeAuth(options.principals));
  app.use(async (c, next) => {
    const incoming = c.env.incoming as IncomingMessage & { body?: unknown };
    await new Promise<void>((resolve, reject) => {
      parseJson(incoming, c.env.outgoing, (error) => (error ? reject(error) : resolve()));
    });
    if (incoming.body !== undefined) c.set('body', incoming.body);
    await next();
  });
  app.route('/mcp', createConnectorRuntimeMcpRoutes(options.serverFactory));
  app.route('/agent-mcp', createConnectorRuntimeMcpRoutes(options.agentServerFactory));
  return app;
}

/**
 * The listener's Node request handler: the loopback boundary first, on the raw
 * request, before Hono reads anything, then the app.
 */
function connectorRuntimeRequestListener(app: Hono<ConnectorRuntimeEnv>): RequestListener {
  const viaHono = getRequestListener(app.fetch, {
    overrideGlobalObjects: false,
    autoCleanupIncoming: false,
  });
  return (req, res) => {
    if (!clearsConnectorRuntimeLoopback(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(LOOPBACK_REFUSAL));
      return;
    }
    // Host names ignore case, but the adapter refuses a `Host` in capitals.
    if (req.headers.host) req.headers.host = req.headers.host.toLowerCase();
    return viaHono(req, res);
  };
}

/**
 * Start the connector-only MCP listener on IPv4 loopback.
 *
 * The caller must initialize the runtime binding boot epoch before invoking
 * this function. This module intentionally reads no external MCP enablement,
 * credential, origin, or rate-limit configuration.
 *
 * @param options - Principal resolver, exact projection factory, and overrides.
 * @returns Running listener handle.
 */
export async function startConnectorRuntimeMcpListener(
  options: ConnectorRuntimeMcpListenerOptions
): Promise<ConnectorRuntimeMcpListener> {
  const server = createServer(connectorRuntimeRequestListener(createListenerApp(options)));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port ?? 0, '127.0.0.1');
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Connector runtime MCP listener did not receive a TCP address.');
  }

  let closed = false;
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`,
    agentUrl: `${origin}/agent-mcp`,
    close: async () => {
      if (closed) return;
      closed = true;
      await closeServer(server);
    },
  };
}
