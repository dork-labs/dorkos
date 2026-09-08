/** Authentication middleware for the connector-only runtime MCP listener. */
import type { NextFunction, Request, Response } from 'express';
import type {
  ConnectorRuntime,
  ConnectorRuntimePrincipalPort,
} from '../../connectors/runtime-principal-port.js';
import type { ServerPrincipalProof } from '../../connectors/principal/server-principal.js';
import { CONNECTOR_RUNTIME_CWD_HEADER, CONNECTOR_RUNTIME_KIND_HEADER } from '../connector-tools.js';

/** Express local populated only after a runtime bearer resolves successfully. */
export interface ConnectorRuntimeAuthLocals {
  /** Process-authenticated principal resolved from the bearer. */
  connectorPrincipal?: ServerPrincipalProof;
}

const RUNTIMES = new Set<ConnectorRuntime>(['claude-code', 'codex', 'opencode']);

/** Return a uniform unauthorized response without disclosing refusal state. */
function refuse(res: Response): void {
  res.status(401).json({
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message: 'Connections access ended. Start a new turn to continue.',
    },
    id: null,
  });
}

/**
 * Authenticate a connector runtime bearer and attach its server proof.
 *
 * @param principals - Server-owned runtime principal resolver.
 * @returns Express middleware for the internal listener.
 */
export function createConnectorRuntimeAuth(principals: ConnectorRuntimePrincipalPort) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authorization = req.header('authorization');
    const runtimeHeader = req.header(CONNECTOR_RUNTIME_KIND_HEADER);
    if (
      !authorization?.startsWith('Bearer ') ||
      authorization.length === 'Bearer '.length ||
      !runtimeHeader ||
      !RUNTIMES.has(runtimeHeader as ConnectorRuntime)
    ) {
      refuse(res);
      return;
    }

    const encodedCwd = req.header(CONNECTOR_RUNTIME_CWD_HEADER);
    if (!encodedCwd) {
      refuse(res);
      return;
    }
    let canonicalCwd: string;
    try {
      canonicalCwd = decodeURIComponent(encodedCwd);
    } catch {
      refuse(res);
      return;
    }

    let result;
    try {
      result = await principals.resolve({
        bearer: authorization.slice('Bearer '.length),
        expectedRuntime: runtimeHeader as ConnectorRuntime,
        expectedCanonicalCwd: canonicalCwd,
      });
    } catch {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null,
      });
      return;
    }
    if (result.status !== 'resolved') {
      refuse(res);
      return;
    }

    (res.locals as ConnectorRuntimeAuthLocals).connectorPrincipal = result.principal;
    next();
  };
}
