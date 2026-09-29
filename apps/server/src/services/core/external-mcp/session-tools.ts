/**
 * Puts the session tools (`session_start`) on the external `/mcp` server.
 *
 * The names, descriptions, and input schemas come from `getSessionTools`, the
 * same definitions the in-session server uses, via
 * {@link registerFromDefinitions}. Only the external-only additions live here.
 * The external server carries no session, so the caller is the agent the
 * request's `X-DorkOS-Agent` token names. With no such agent (a plain key, or a
 * revoked or expired token) every call is refused: a session always runs as the
 * agent that asked for it.
 *
 * @module services/core/external-mcp/session-tools
 */
import type { ToolRegistrar } from '../mcp-tool-gate.js';
import type { AgentIdentity } from '../agent-identity/index.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { getSessionTools } from '../../runtimes/claude-code/mcp-tools/session-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';
import { registerFromDefinitions, type ExternalToolConfigs } from './register-from-definitions.js';

/** The external-only additions for each session tool. */
const SESSION_EXTERNAL_CONFIGS: ExternalToolConfigs = {
  // A new session every call, on this machine: not read-only, not idempotent.
  // No `outputSchema`: an `act` tool can be refused by the tier gate, and a
  // refusal carries no structured result.
  session_start: { annotations: ToolAnnotationPresets.mutateCreateLocal },
};

/**
 * Register `session_start` against `registrar`.
 *
 * @param registrar - The gated tool registrar from `mcp-server.ts`.
 * @param deps - Shared MCP tool dependencies.
 * @param identity - The calling agent the request's token resolved to, if any.
 */
export function registerSessionTools(
  registrar: ToolRegistrar,
  deps: McpToolDeps,
  identity?: AgentIdentity
): void {
  // An inactive identity names who tried, never who may act.
  const caller = identity && !identity.inactive ? { agentPath: identity.agentPath } : undefined;
  registerFromDefinitions(
    registrar,
    getSessionTools(deps, () => caller),
    SESSION_EXTERNAL_CONFIGS
  );
}
