/**
 * Registers the `dorkos://agents` and `dorkos://agents/{id}` MCP resources
 * against a live `McpServer` instance. Split out of `mcp-server.ts` — see
 * `core-tools.ts` in this directory for why.
 *
 * Reuses `MeshCore` — the same dependency and the same `AgentManifest` shape
 * the `mesh_list`/`mesh_inspect` external MCP tools already expose
 * (`mesh-tools.ts`), so these resources add a read surface, not new data: an
 * `AgentManifest` never carries a filesystem path (see
 * `packages/shared/src/mesh-schemas.ts`), so no cwd/project-path exposure is
 * introduced here beyond what `mesh_list`/`mesh_inspect` already return.
 *
 * @module services/core/external-mcp/agent-resources
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import {
  firstVar,
  jsonResourceContents,
  resourceNotFound,
  resourceUnavailable,
} from './resource-helpers.js';

/** `dorkos://agents` list payload — mirrors the `mesh_list` tool's `outputSchema`. */
const AgentListResourceSchema = z.object({
  agents: z.array(AgentManifestSchema),
  count: z.number(),
});

/** Guard that returns the injected `MeshCore` or throws a clear "not available" error. */
function requireMeshCore(deps: McpToolDeps): NonNullable<McpToolDeps['meshCore']> {
  if (!deps.meshCore) {
    resourceUnavailable('Mesh is not enabled — agent resources are unavailable.');
  }
  return deps.meshCore;
}

/**
 * Register `dorkos://agents` and `dorkos://agents/{id}` against `server`.
 *
 * @param server - The external `McpServer` instance to register resources against.
 * @param deps - Shared MCP tool dependencies.
 */
export function registerAgentResources(server: McpServer, deps: McpToolDeps): void {
  server.registerResource(
    'agents',
    'dorkos://agents',
    {
      title: 'Agents',
      description:
        'Every agent registered with Mesh — the same manifests the mesh_list tool returns.',
      mimeType: 'application/json',
    },
    async () => {
      const mesh = requireMeshCore(deps);
      const agents = mesh.list();
      return jsonResourceContents(
        'dorkos://agents',
        AgentListResourceSchema.parse({ agents, count: agents.length })
      );
    }
  );

  server.registerResource(
    'agent',
    // `list: undefined` — `dorkos://agents` above already enumerates every
    // valid id; see the identical rationale on the session template.
    new ResourceTemplate('dorkos://agents/{id}', { list: undefined }),
    {
      title: 'Agent',
      description: 'A single agent manifest (.dork/agent.json content) by agent ULID.',
      mimeType: 'application/json',
    },
    async (uri, { id }) => {
      const mesh = requireMeshCore(deps);
      const agentId = firstVar(id);
      const agent = mesh.get(agentId);
      if (!agent) resourceNotFound(`Agent not found: ${agentId}`);
      return jsonResourceContents(uri.toString(), AgentManifestSchema.parse(agent));
    }
  );
}
