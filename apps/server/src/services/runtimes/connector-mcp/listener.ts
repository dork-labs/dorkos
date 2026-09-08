/** Independently authenticated loopback listener for runtime connector tools. */
import { createServer, type Server } from 'node:http';
import express from 'express';
import type { ConnectorRuntimePrincipalPort } from '../../connectors/runtime-principal-port.js';
import { createConnectorRuntimeAuth } from './auth.js';
import { buildConnectorRuntimeRateLimiter } from './rate-limit.js';
import {
  createConnectorRuntimeMcpRouter,
  type ConnectorRuntimeMcpServerFactory,
} from './router.js';
import { requireConnectorRuntimeLoopback } from './socket-origin.js';

/** Construction options for the internal connector runtime listener. */
export interface ConnectorRuntimeMcpListenerOptions {
  /** Server-owned bearer resolver. Boot initialization must already be complete. */
  readonly principals: ConnectorRuntimePrincipalPort;
  /** Broker-owned factory exposing only connector execution capabilities. */
  readonly serverFactory: ConnectorRuntimeMcpServerFactory;
  /** Agent-safe DorkOS capability projection, when runtime tools are enabled. */
  readonly agentServerFactory: ConnectorRuntimeMcpServerFactory;
  /** Live experiment gate checked on every direct request to the agent route. */
  readonly agentToolsEnabled: () => boolean;
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
  const app = express();
  app.disable('x-powered-by');
  app.use(requireConnectorRuntimeLoopback);
  app.use(
    buildConnectorRuntimeRateLimiter({
      ...(options.maxRequestsPerMinute !== undefined
        ? { maxPerWindow: options.maxRequestsPerMinute }
        : {}),
    })
  );
  app.use(createConnectorRuntimeAuth(options.principals));
  app.use(express.json({ limit: '1mb' }));
  app.use('/mcp', createConnectorRuntimeMcpRouter(options.serverFactory));
  app.use('/agent-mcp', (req, res, next) => {
    if (options.agentToolsEnabled()) {
      next();
      return;
    }
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32004, message: 'Not found' },
      id: null,
    });
  });
  app.use('/agent-mcp', createConnectorRuntimeMcpRouter(options.agentServerFactory));
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (res.headersSent) return;
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null,
      });
    }
  );

  const server = createServer(app);
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
