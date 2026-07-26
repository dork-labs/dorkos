/**
 * Puts the core tools (`ping`, `get_server_info`, `get_session_count`,
 * `get_agent`) on the external `/mcp` server.
 *
 * The names, descriptions, and input schemas are NOT written here: they come from
 * `getCoreTools`, the same definitions the in-session server uses, via
 * {@link registerFromDefinitions}. Only the external-only additions live here —
 * see that module for why (DOR-499).
 *
 * @module services/core/external-mcp/core-tools
 */
import { z } from 'zod';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import type { ToolRegistrar } from '../mcp-tool-gate.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { getCoreTools } from '../../runtimes/claude-code/mcp-tools/core-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';
import { registerFromDefinitions, type ExternalToolConfigs } from './register-from-definitions.js';

const A = ToolAnnotationPresets;

/** `outputSchema` for `get_agent` — mirrors both its null and hit success shapes. */
const getAgentOutputSchema = {
  agent: AgentManifestSchema.nullable(),
  message: z.string().optional(),
};

/** The external-only additions for each core tool. */
const CORE_EXTERNAL_CONFIGS: ExternalToolConfigs = {
  ping: { annotations: A.readOnlyLocal },
  get_server_info: { annotations: A.readOnlyLocal },
  get_session_count: { annotations: A.readOnlyLocal },
  get_agent: { annotations: A.readOnlyLocal, outputSchema: getAgentOutputSchema },
};

/**
 * Register `ping`, `get_server_info`, `get_session_count`, and `get_agent`
 * against `registrar`.
 *
 * @param registrar - The gated tool registrar from `mcp-server.ts`, which runs each
 *   tool's permission tier before its handler.
 * @param deps - Shared MCP tool dependencies.
 */
export function registerCoreTools(registrar: ToolRegistrar, deps: McpToolDeps): void {
  registerFromDefinitions(registrar, getCoreTools(deps), CORE_EXTERNAL_CONFIGS);
}
