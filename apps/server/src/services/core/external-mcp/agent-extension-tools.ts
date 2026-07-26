/**
 * Puts `create_agent` and the extension tools (6 total, always the full set
 * regardless of `deps.extensionManager`) on the external `/mcp` server.
 *
 * The names, descriptions, and input schemas are NOT written here: they come from
 * `getAgentTools` and `extensionToolDefinitions`, the same in-session definitions
 * the internal `dorkos` server uses (the latter is deliberately unguarded — see
 * its TSDoc in `extension-tools.ts`), via {@link registerFromDefinitions}. Only
 * the external-only additions live here — see that module for why (DOR-499).
 *
 * @module services/core/external-mcp/agent-extension-tools
 */
import type { ToolRegistrar } from '../mcp-tool-gate.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { getAgentTools } from '../../runtimes/claude-code/mcp-tools/agent-tools.js';
import { extensionToolDefinitions } from '../../runtimes/claude-code/mcp-tools/extension-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';
import { registerFromDefinitions, type ExternalToolConfigs } from './register-from-definitions.js';

const A = ToolAnnotationPresets;

/** The external-only additions for `create_agent`. */
const AGENT_EXTERNAL_CONFIGS: ExternalToolConfigs = {
  create_agent: { annotations: A.mutateCreateLocal },
};

/** The external-only additions for each extension tool. */
const EXTENSION_EXTERNAL_CONFIGS: ExternalToolConfigs = {
  get_extension_api: { annotations: A.readOnlyLocal },
  list_extensions: { annotations: A.readOnlyLocal },
  get_extension_errors: { annotations: A.readOnlyLocal },
  create_extension: { annotations: A.mutateCreateLocal },
  reload_extensions: { annotations: A.mutateUpdateLocal },
  test_extension: { annotations: A.mutateUpdateLocal },
};

/**
 * Register `create_agent` and every `*_extension(s)` tool (7 total) against
 * `registrar`.
 *
 * @param registrar - The gated tool registrar from `mcp-server.ts`, which runs each
 *   tool's permission tier before its handler.
 * @param deps - Shared MCP tool dependencies.
 */
export function registerAgentAndExtensionTools(registrar: ToolRegistrar, deps: McpToolDeps): void {
  registerFromDefinitions(registrar, getAgentTools(deps), AGENT_EXTERNAL_CONFIGS);
  registerFromDefinitions(registrar, extensionToolDefinitions(deps), EXTENSION_EXTERNAL_CONFIGS);
}
