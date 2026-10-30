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

const RUNTIMES = new Set<ConnectorRuntime>([
  'claude-code',
  'codex',
  'opencode',
  'doe',
  'computer-local',
]);

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
 * The runtime whose principal is minted and used inside this process only.
 *
 * Claude Code resolves its turn's principal in process and never hands the
 * bearer to the CLI, so no agent can present one here. A claim of it on this
 * listener is refused: `callerOf` in `session/browser-seat/ui-capabilities.ts`
 * treats a Claude Code principal as the in-app surface that can ask a person,
 * so a kind claimed where it is not minted would reach past that check.
 */
const IN_PROCESS_RUNTIME: ConnectorRuntime = 'claude-code';

/** How the listener's authentication is configured. */
export interface ConnectorRuntimeAuthOptions {
  /**
   * Accept a Claude Code claim. Only the test runtime sets it, for server-run
   * probes that drive this listener as Claude Code (`DORKOS_TEST_RUNTIME`).
   */
  readonly acceptInProcessRuntime?: boolean;
}

/**
 * Authenticate a connector runtime bearer and attach its server proof.
 *
 * @param principals - Server-owned runtime principal resolver.
 * @param options - Whether the in-process runtime may be claimed here.
 * @returns Hono middleware for the internal listener.
 */
export function createConnectorRuntimeAuth(
  principals: ConnectorRuntimePrincipalPort,
  options: ConnectorRuntimeAuthOptions = {}
): MiddlewareHandler<ConnectorRuntimeEnv> {
  return async (c, next) => {
    const authorization = c.req.header('authorization');
    const runtimeHeader = c.req.header(CONNECTOR_RUNTIME_KIND_HEADER);
    if (
      !authorization?.startsWith('Bearer ') ||
      authorization.length === 'Bearer '.length ||
      !runtimeHeader ||
      !RUNTIMES.has(runtimeHeader as ConnectorRuntime) ||
      (runtimeHeader === IN_PROCESS_RUNTIME && options.acceptInProcessRuntime !== true)
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
