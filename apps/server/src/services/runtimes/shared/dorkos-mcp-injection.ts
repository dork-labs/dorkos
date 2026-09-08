/**
 * The `dorkos` MCP server DorkOS injects into Codex and OpenCode sessions.
 *
 * Claude Code carries the same capability audience in-process. Codex and
 * OpenCode are separate programs, so they reach it through the server-owned
 * loopback runtime listener. That listener resolves a short-lived bearer into
 * the canonical runtime, session, agent, and working directory before any tool
 * is listed or called. It is separate from public `/mcp`, so enabling login or
 * disabling the external MCP endpoint cannot take an agent's own tools away.
 *
 * The authorization, runtime, and canonical-directory headers are one binding.
 * The listener checks all three on every request and derives identity from its
 * stored principal. A caller cannot substitute `X-DorkOS-Agent`, a session id,
 * or another directory. The bearer is revoked when the turn ends and whenever
 * the runtime, working directory, registered agent, or server boot changes.
 *
 * @module services/runtimes/shared/dorkos-mcp-injection
 */
import { logger } from '../../../lib/logger.js';
import { configManager } from '../../core/config-manager.js';
import {
  CONNECTOR_RUNTIME_AUTHORIZATION_HEADER,
  CONNECTOR_RUNTIME_CWD_HEADER,
  CONNECTOR_RUNTIME_HEADER_ENV,
  CONNECTOR_RUNTIME_KIND_HEADER,
  type ConnectorRuntimeMcpInjection,
} from '../connector-tools.js';
import { DORKOS_MCP_SERVER_NAME } from './dorkos-tool-names.js';

export { DORKOS_MCP_SERVER_NAME };

/** Environment variables holding the runtime header values for Codex. */
export const DORKOS_MCP_HEADER_ENV_VARS: Readonly<Record<string, string>> = {
  [CONNECTOR_RUNTIME_AUTHORIZATION_HEADER]: CONNECTOR_RUNTIME_HEADER_ENV.authorization,
  [CONNECTOR_RUNTIME_KIND_HEADER]: CONNECTOR_RUNTIME_HEADER_ENV.runtime,
  [CONNECTOR_RUNTIME_CWD_HEADER]: CONNECTOR_RUNTIME_HEADER_ENV.cwd,
};

/** One injected `dorkos` server: where to reach it, and what to present. */
export interface DorkosMcpInjection {
  /** Streamable-HTTP endpoint on the loopback-only runtime listener. */
  url: string;
  /** Complete turn-bound runtime header set; never partial. */
  headers: Record<string, string>;
}

/** Whether this instance would inject the `dorkos` server for a directory. */
export type DorkosToolsPosture =
  | { wired: true }
  | { wired: false; why: 'experiment-off' | 'no-agent' | 'runtime-boundary-unavailable' };

/**
 * Ask whether this instance is configured to hand a directory's sessions the
 * DorkOS tools.
 *
 * This is the one decision both injection and `AgentRuntime.carriesRoomTools`
 * read. A room therefore suppresses a turn's text only when the same runtime is
 * able to inject the tool server that lets the agent speak for itself.
 *
 * The public `mcp.enabled`, login, local MCP token, and `MCP_API_KEY` settings
 * are intentionally absent. They govern clients outside the runtime trust
 * boundary; this entry is authenticated by its own turn principal.
 *
 * @param agentPath - Registered agent directory, or undefined for a plain session.
 * @param runtimeBoundaryAvailable - Whether boot installed the internal listener.
 * @returns Whether the entry can be built, and why not when it cannot.
 */
export function dorkosToolsPosture(
  agentPath: string | undefined,
  runtimeBoundaryAvailable = false
): DorkosToolsPosture {
  if (configManager?.get('runtimes')?.dorkosTools !== true) {
    return { wired: false, why: 'experiment-off' };
  }
  if (agentPath === undefined) return { wired: false, why: 'no-agent' };
  if (!runtimeBoundaryAvailable) return { wired: false, why: 'runtime-boundary-unavailable' };
  return { wired: true };
}

/**
 * Resolve the `dorkos` MCP entry for one agent-bound turn.
 *
 * @param agentPath - Registered agent directory, or undefined for a plain session.
 * @param runtimeTools - The already-open turn binding and its scoped URLs.
 * @returns The entry to inject, or null when no safe runtime boundary is available.
 */
export async function resolveDorkosMcpInjection(
  agentPath: string | undefined,
  runtimeTools: ConnectorRuntimeMcpInjection | null | undefined
): Promise<DorkosMcpInjection | null> {
  const posture = dorkosToolsPosture(agentPath, Boolean(runtimeTools?.agentToolsUrl));
  if (!posture.wired) {
    if (posture.why === 'runtime-boundary-unavailable') {
      logger.warn(
        '[dorkos-mcp] not injecting the DorkOS tools — the authenticated runtime boundary is unavailable.',
        { agentPath }
      );
    }
    return null;
  }
  if (!runtimeTools) return null;

  return { url: runtimeTools.agentToolsUrl, headers: runtimeTools.headers };
}
