/**
 * Puts the `binding_*` tools on the external `/mcp` server.
 *
 * The names, descriptions, and input schemas are NOT written here: they come from
 * `bindingToolDefinitions`, the same definitions the in-session server uses, via
 * {@link registerFromDefinitions}. Only the external-only additions live here —
 * see that module for why (DOR-499).
 *
 * `binding_list_sessions` is deliberately absent from the config below, which is
 * what keeps it in-session-only.
 *
 * @module services/core/external-mcp/binding-tools
 */
import type { ToolRegistrar } from '../mcp-tool-gate.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { bindingToolDefinitions } from '../../runtimes/claude-code/mcp-tools/binding-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';
import { registerFromDefinitions, type ExternalToolConfigs } from './register-from-definitions.js';

const A = ToolAnnotationPresets;

/** The external-only additions for each `binding_*` tool that reaches `/mcp`. */
const BINDING_EXTERNAL_CONFIGS: ExternalToolConfigs = {
  binding_list: { annotations: A.readOnlyLocal },
  binding_create: { annotations: A.mutateCreateLocal },
  binding_delete: { annotations: A.mutateDeleteLocal },
};

/**
 * Register `binding_list`, `binding_create`, and `binding_delete` against
 * `registrar`.
 *
 * @param registrar - The gated tool registrar from `mcp-server.ts`, which runs each
 *   tool's permission tier before its handler.
 * @param deps - Shared MCP tool dependencies.
 */
export function registerBindingTools(registrar: ToolRegistrar, deps: McpToolDeps): void {
  registerFromDefinitions(registrar, bindingToolDefinitions(deps), BINDING_EXTERNAL_CONFIGS);
}
