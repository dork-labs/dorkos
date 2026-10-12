/** Authentication middleware for the connector-only runtime MCP listener. */
import type { HttpBindings } from '@hono/node-server';
import type { MiddlewareHandler } from 'hono';
import type {
  ConnectorRuntime,
  ConnectorRuntimePrincipalPort,
} from '../../connectors/runtime-principal-port.js';
import type { ServerPrincipalProof } from '../../connectors/principal/server-principal.js';
import type { RequestFactsVariables } from '../../../http/request-facts.js';
import { CONNECTOR_RUNTIME_CWD_HEADER, CONNECTOR_RUNTIME_KIND_HEADER } from '../connector-tools.js';

/** What the listener's middleware puts on `c.var`. */
export interface ConnectorRuntimeVariables extends RequestFactsVariables {
  /** Process-authenticated principal, set only after a runtime bearer resolves. */
  connectorPrincipal?: ServerPrincipalProof;
  /** The parsed JSON-RPC body, when the request carried JSON. */
  body?: unknown;
}

/** The Hono environment of the connector runtime listener. */
export type ConnectorRuntimeEnv = { Bindings: HttpBindings; Variables: ConnectorRuntimeVariables };

const RUNTIMES = new Set<ConnectorRuntime>(['claude-code', 'codex', 'opencode', 'doe']);

/** The uniform unauthorized body, which discloses no refusal state. */
export const CONNECTOR_RUNTIME_REFUSAL = {
  jsonrpc: '2.0',
  error: {
    code: -32001,
    message: 'Connections access ended. Start a new turn to continue.',
  },
  id: null,
} as const;

/**
 * Authenticate a connector runtime bearer and attach its server proof.
 *
 * @param principals - Server-owned runtime principal resolver.
 * @returns Hono middleware for the internal listener.
 */
export function createConnectorRuntimeAuth(
  principals: ConnectorRuntimePrincipalPort
): MiddlewareHandler<ConnectorRuntimeEnv> {
  return async (c, next) => {
    const authorization = c.req.header('authorization');
    const runtimeHeader = c.req.header(CONNECTOR_RUNTIME_KIND_HEADER);
    if (
      !authorization?.startsWith('Bearer ') ||
      authorization.length === 'Bearer '.length ||
      !runtimeHeader ||
      !RUNTIMES.has(runtimeHeader as ConnectorRuntime)
    ) {
      return c.json(CONNECTOR_RUNTIME_REFUSAL, 401);
    }

    const encodedCwd = c.req.header(CONNECTOR_RUNTIME_CWD_HEADER);
    if (!encodedCwd) return c.json(CONNECTOR_RUNTIME_REFUSAL, 401);
    let canonicalCwd: string;
    try {
      canonicalCwd = decodeURIComponent(encodedCwd);
    } catch {
      return c.json(CONNECTOR_RUNTIME_REFUSAL, 401);
    }

    let result;
    try {
      result = await principals.resolve({
        bearer: authorization.slice('Bearer '.length),
        expectedRuntime: runtimeHeader as ConnectorRuntime,
        expectedCanonicalCwd: canonicalCwd,
      });
    } catch {
      return c.json(
        { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null },
        500
      );
    }
    if (result.status !== 'resolved') return c.json(CONNECTOR_RUNTIME_REFUSAL, 401);

    c.set('connectorPrincipal', result.principal);
    await next();
  };
}
