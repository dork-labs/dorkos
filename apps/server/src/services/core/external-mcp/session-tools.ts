/**
 * Puts the session tools (`session_start`) on the external `/mcp` server.
 *
 * The names, descriptions, and input schemas come from `getSessionTools`, the
 * same definitions the in-session server uses, via
 * {@link registerFromDefinitions}. Only the external-only additions live here.
 * The external server carries no session, so no caller resolver is passed and
 * the Activity entry names the caller as the external server.
 *
 * @module services/core/external-mcp/session-tools
 */
import type { ToolRegistrar } from '../mcp-tool-gate.js';
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
 */
export function registerSessionTools(registrar: ToolRegistrar, deps: McpToolDeps): void {
  registerFromDefinitions(registrar, getSessionTools(deps), SESSION_EXTERNAL_CONFIGS);
}
