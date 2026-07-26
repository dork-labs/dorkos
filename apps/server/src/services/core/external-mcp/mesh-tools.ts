/**
 * Registers the `mesh_*` external MCP tools against the gated tool
 * registrar (`mcp-tool-gate.ts`). Split out of `mcp-server.ts` — see `core-tools.ts` in this
 * directory for why.
 *
 * @module services/core/external-mcp/mesh-tools
 */
import type { ToolRegistrar } from '../mcp-tool-gate.js';
import { z } from 'zod';
import {
  AgentManifestSchema,
  MeshStatusSchema,
  MeshInspectSchema,
  TopologyViewSchema,
} from '@dorkos/shared/mesh-schemas';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import {
  createMeshDiscoverHandler,
  createMeshRegisterHandler,
  createMeshListHandler,
  createMeshDenyHandler,
  createMeshUnregisterHandler,
  createMeshStatusHandler,
  createMeshInspectHandler,
  createMeshQueryTopologyHandler,
} from '../../runtimes/claude-code/mcp-tools/mesh-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';

const A = ToolAnnotationPresets;

/** `outputSchema` for `mesh_list`. */
const meshListOutputSchema = {
  agents: z.array(AgentManifestSchema),
  count: z.number(),
};

/**
 * Register every `mesh_*` tool (8 total) against `registrar`.
 *
 * @param registrar - The gated tool registrar from `mcp-server.ts`, which runs each
 *   tool's permission tier before its handler.
 * @param deps - Shared MCP tool dependencies.
 */
export function registerMeshTools(registrar: ToolRegistrar, deps: McpToolDeps): void {
  registrar.registerTool(
    'mesh_discover',
    {
      description:
        'Scan directories for agent candidates. Returns paths with detected runtime, capabilities, and suggested names.',
      inputSchema: {
        roots: z.array(z.string()).describe('Root directories to scan for agents'),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Maximum directory depth (default 3)'),
      },
      // Auto-imports any `.dork/agent.json` found during the walk, upserting
      // the registry as a scan side effect — not a pure read.
      annotations: A.mutateUpdateLocal,
    },
    createMeshDiscoverHandler(deps)
  );
  registrar.registerTool(
    'mesh_register',
    {
      description:
        'Register an agent from a filesystem path. Creates a .dork/agent.json manifest and adds the agent to the registry.',
      inputSchema: {
        path: z.string().describe('Filesystem path to the agent directory'),
        name: z.string().optional().describe('Display name override'),
        description: z.string().optional().describe('Agent description'),
        runtime: z.string().optional().describe('Runtime: claude-code, cursor, codex, or other'),
        capabilities: z.array(z.string()).optional().describe('Agent capabilities'),
      },
      // Assigns a fresh ULID every call, even for the same path — repeat calls
      // create additional agent records rather than converging.
      annotations: A.mutateCreateLocal,
    },
    createMeshRegisterHandler(deps)
  );
  registrar.registerTool(
    'mesh_list',
    {
      description: 'List all registered agents with optional filters.',
      inputSchema: {
        runtime: z.string().optional().describe('Filter by runtime'),
        capability: z.string().optional().describe('Filter by capability'),
        callerNamespace: z.string().optional().describe('Filter by namespace visibility'),
      },
      annotations: A.readOnlyLocal,
      outputSchema: meshListOutputSchema,
    },
    createMeshListHandler(deps)
  );
  registrar.registerTool(
    'mesh_deny',
    {
      description: 'Deny a candidate path from future discovery scans.',
      inputSchema: {
        path: z.string().describe('Path to deny'),
        reason: z.string().optional().describe('Reason for denial'),
      },
      annotations: A.mutateUpdateLocal,
    },
    createMeshDenyHandler(deps)
  );
  registrar.registerTool(
    'mesh_unregister',
    {
      description: 'Unregister an agent by ID, removing it from the registry.',
      inputSchema: {
        agentId: z.string().describe('Agent ID to unregister'),
      },
      annotations: A.mutateDeleteLocal,
    },
    createMeshUnregisterHandler(deps)
  );
  registrar.registerTool(
    'mesh_status',
    {
      description:
        'Get aggregate mesh health status — total agents, active/inactive/stale counts, by runtime, by project.',
      inputSchema: {},
      annotations: A.readOnlyLocal,
      outputSchema: MeshStatusSchema,
    },
    createMeshStatusHandler(deps)
  );
  registrar.registerTool(
    'mesh_inspect',
    {
      description: 'Inspect a specific agent — manifest, health status, relay endpoint.',
      inputSchema: {
        agentId: z.string().describe('The agent ULID to inspect'),
      },
      annotations: A.readOnlyLocal,
      outputSchema: MeshInspectSchema,
    },
    createMeshInspectHandler(deps)
  );
  registrar.registerTool(
    'mesh_query_topology',
    {
      description:
        'Query the agent network topology visible to a given namespace. Returns namespaces, agents, and access rules.',
      inputSchema: {
        namespace: z.string().optional().describe('Caller namespace (omit for admin view)'),
      },
      annotations: A.readOnlyLocal,
      outputSchema: TopologyViewSchema,
    },
    createMeshQueryTopologyHandler(deps)
  );
}
