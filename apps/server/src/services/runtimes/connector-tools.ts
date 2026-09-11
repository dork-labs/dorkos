/**
 * Server-local connector tool injection shared by concrete runtime adapters.
 *
 * This contract deliberately does not extend the shared `AgentRuntime` port:
 * connector turn authority is a server composition concern and must never
 * become a client-facing runtime capability.
 *
 * @module services/runtimes/connector-tools
 */
import type {
  ConnectorRuntime,
  ConnectorRuntimePrincipalPort,
} from '../connectors/runtime-principal-port.js';
import type { ConnectorTurnLeaseSupervisorFactory } from './connectors/connector-turn-lease-supervisor.js';

/** Header carrying the short-lived internal runtime bearer. */
export const CONNECTOR_RUNTIME_AUTHORIZATION_HEADER = 'Authorization';
/** Header constraining a bearer to the adapter that opened it. */
export const CONNECTOR_RUNTIME_KIND_HEADER = 'X-DorkOS-Connector-Runtime';
/** Header constraining a bearer to the runtime's canonical working directory. */
export const CONNECTOR_RUNTIME_CWD_HEADER = 'X-DorkOS-Connector-Cwd';
/** Dedicated MCP server name used by Codex and OpenCode. */
export const CONNECTOR_RUNTIME_MCP_SERVER_NAME = 'dorkos_connections';

/** Environment variables holding connector listener header values for Codex. */
export const CONNECTOR_RUNTIME_HEADER_ENV = {
  authorization: 'DORKOS_CONNECTOR_MCP_AUTHORIZATION',
  runtime: 'DORKOS_CONNECTOR_MCP_RUNTIME',
  cwd: 'DORKOS_CONNECTOR_MCP_CWD',
} as const;

/** Server-derived access awareness; the revision never enters model context. */
export interface ConnectorAccessSnapshot {
  /** Number of accounts in the canonical granted-access inventory for this agent/session. */
  readonly accountCount: number;
  /** Opaque digest of scoped canonical grants and access state. */
  readonly revision: string;
}

/** Dependencies injected into a concrete runtime after the listener starts. */
export interface ConnectorRuntimeTools {
  /** Server-owned turn binding lifecycle. */
  readonly principals: ConnectorRuntimePrincipalPort;
  /** URL of the independently authenticated loopback MCP listener. */
  readonly listenerUrl: string;
  /** Loopback URL exposing the DorkOS capabilities declared for agent sessions. */
  readonly agentToolsUrl: string;
  /** Read scoped awareness from canonical state, without opening runtime authority. */
  readonly accessSnapshot?: (
    agentId: string,
    sessionId: string
  ) => Promise<ConnectorAccessSnapshot>;
  /** Broker-owned exact predicate for the five private runtime connector capabilities. */
  readonly isConnectorCapabilityId: (id: string) => boolean;
  /** Testable process-local supervisor constructor; production uses the default. */
  readonly createLeaseSupervisor?: ConnectorTurnLeaseSupervisorFactory;
}

/** One turn's fixed connector-only MCP transport configuration. */
export interface ConnectorRuntimeMcpInjection {
  /** Internal loopback MCP URL. */
  readonly url: string;
  /** Same turn-bound listener's agent-safe DorkOS capability route. */
  readonly agentToolsUrl: string;
  /** Authenticated runtime headers fixed for this turn. */
  readonly headers: Record<string, string>;
}

/** Server-local structural contract implemented by supported concrete runtimes. */
export interface ConnectorRuntimeToolConsumer {
  /** Install connector runtime tooling after boot initialized the listener. */
  setConnectorRuntimeTools(tools: ConnectorRuntimeTools): void;
}

/** Inputs required to build one runtime listener header set. */
export interface ConnectorRuntimeHeadersInput {
  /** Short-lived bearer returned by `openTurn`. */
  readonly bearer: string;
  /** Runtime adapter that opened the binding. */
  readonly runtime: ConnectorRuntime;
  /** Canonical runtime working directory checked on every listener request. */
  readonly canonicalCwd: string;
}

/**
 * Build the authenticated fixed headers injected into an MCP client.
 *
 * @param input - Bearer and server-derived runtime constraints.
 * @returns Header values for the internal listener.
 */
export function connectorRuntimeHeaders(
  input: ConnectorRuntimeHeadersInput
): Record<string, string> {
  return {
    [CONNECTOR_RUNTIME_AUTHORIZATION_HEADER]: `Bearer ${input.bearer}`,
    [CONNECTOR_RUNTIME_KIND_HEADER]: input.runtime,
    [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent(input.canonicalCwd),
  };
}
