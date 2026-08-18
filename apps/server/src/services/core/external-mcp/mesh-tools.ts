/**
 * Puts the `mesh_*` tools on the external `/mcp` server.
 *
 * The names, descriptions, and input schemas are NOT written here: they come from
 * `meshToolDefinitions`, the same definitions the in-session server uses, via
 * {@link registerFromDefinitions}. Only the external-only additions live here —
 * see that module for why (DOR-499).
 *
 * @module services/core/external-mcp/mesh-tools
 */
import { z } from 'zod';
import {
  MeshStatusSchema,
  MeshInspectSchema,
  TopologyViewSchema,
  AgentManifestSchema,
} from '@dorkos/shared/mesh-schemas';
import type { ToolRegistrar } from '../mcp-tool-gate.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { meshToolDefinitions } from '../../runtimes/claude-code/mcp-tools/mesh-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';
import { registerFromDefinitions, type ExternalToolConfigs } from './register-from-definitions.js';

const A = ToolAnnotationPresets;

/**
 * `outputSchema` for `mesh_list`.
 *
 * The manifest plus the one field the listing adds: `relaySubject`, the agent's
 * canonical endpoint address (DOR-1337). Optional because the handler omits it
 * rather than guessing when an id resolves to nothing.
 */
const meshListOutputSchema = {
  agents: z.array(
    AgentManifestSchema.extend({
      relaySubject: z
        .string()
        .optional()
        .describe('Canonical relay endpoint, e.g. relay.agent.{namespace}.{agentId}'),
    })
  ),
  count: z.number(),
};

/** The external-only additions for each `mesh_*` tool. */
const MESH_EXTERNAL_CONFIGS: ExternalToolConfigs = {
  // Auto-imports any `.dork/agent.json` found during the walk, upserting the
  // registry as a scan side effect — not a pure read.
  mesh_discover: { annotations: A.mutateUpdateLocal },
  // Assigns a fresh ULID every call, even for the same path — repeat calls create
  // additional agent records rather than converging.
  mesh_register: { annotations: A.mutateCreateLocal },
  mesh_list: { annotations: A.readOnlyLocal, outputSchema: meshListOutputSchema },
  mesh_deny: { annotations: A.mutateUpdateLocal },
  mesh_unregister: { annotations: A.mutateDeleteLocal },
  mesh_status: { annotations: A.readOnlyLocal, outputSchema: MeshStatusSchema },
  mesh_inspect: { annotations: A.readOnlyLocal, outputSchema: MeshInspectSchema },
  mesh_query_topology: { annotations: A.readOnlyLocal, outputSchema: TopologyViewSchema },
};

/**
 * Register every `mesh_*` tool (8 total) against `registrar`.
 *
 * @param registrar - The gated tool registrar from `mcp-server.ts`, which runs each
 *   tool's permission tier before its handler.
 * @param deps - Shared MCP tool dependencies.
 */
export function registerMeshTools(registrar: ToolRegistrar, deps: McpToolDeps): void {
  registerFromDefinitions(registrar, meshToolDefinitions(deps), MESH_EXTERNAL_CONFIGS);
}
