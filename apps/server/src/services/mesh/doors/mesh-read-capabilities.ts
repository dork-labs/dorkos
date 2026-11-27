/**
 * The agent registry's reads (`GET /api/mesh/*`) as capabilities the mount
 * serves (DOR-4978, ADR 261123-170830): the same paths, queries and bodies the
 * hand routes had.
 *
 * The roster, the registry's counts and the topology are open to agents, as
 * they were: the CLI an agent runs (`dorkos agent list`) reads them. What an agent reads about ANOTHER agent leaves out that
 * agent's instructions, permissions, MCP servers, workspace and folder
 * ({@link forReader}). The denied folders name folders on this computer, so
 * only a person reads them (`http.audience: 'person'`). The folder list, an
 * agent's reach and its health stay by hand until their paging is settled, and
 * one agent's read with them, since its `{id}` would answer `/agents/paths`
 * (`routes/mesh.ts`).
 *
 * @module services/mesh/doors/mesh-read-capabilities
 */
import { z } from 'zod';
import { PageQuerySchema, nextCursorOutput } from '@dorkos/shared/paging';
import {
  AgentListQuerySchema,
  AgentManifestSchema,
  DenialRecordSchema,
  MeshStatusSchema,
  TopologyViewSchema,
  type TopologyView,
} from '@dorkos/shared/mesh-schemas';

import { type CapabilityHandlerContext } from '../../core/capabilities/index.js';
import { defineCapability, invalidCursor } from '../../core/capabilities/capability-definition.js';
import { assertPageCursor, keysetPage } from '../../../lib/paging/keyset-page.js';
import { callerReaderKey } from '../../../lib/paging/caller-reader-key.js';
import { agentIsAsking, meshOf, type MeshCapabilityDeps } from './mesh-capability-deps.js';

/**
 * What an agent never reads about another agent: its instructions (persona
 * and conventions), its permissions, its MCP servers (which can carry keys),
 * its workspace and its folder.
 */
const PRIVATE_TO_THE_AGENT = [
  'persona',
  'conventions',
  'permissions',
  'mcpServers',
  'workspace',
  'projectPath',
] as const;

/**
 * One agent as this caller may read it: whole for a person and for the agent
 * itself, and without {@link PRIVATE_TO_THE_AGENT} for any other agent.
 *
 * @param mesh - The registry, for the folder each id lives in.
 * @param context - The call's context: who is reading.
 */
export function forReader(
  mesh: MeshCapabilityDeps,
  context: CapabilityHandlerContext
): <T extends { id?: string }>(agent: T) => T {
  if (!agentIsAsking(context)) return (agent) => agent;
  const own = context.identity?.agentPath;
  return <T extends { id?: string }>(agent: T): T => {
    if (own !== undefined && agent.id && mesh.meshCore.getProjectPath(agent.id) === own) {
      return agent;
    }
    const kept: Record<string, unknown> = { ...agent };
    for (const field of PRIVATE_TO_THE_AGENT) delete kept[field];
    return kept as T;
  };
}

/**
 * An agent as a read answers it: an agent reading ANOTHER agent gets it
 * without {@link PRIVATE_TO_THE_AGENT}, so the fields with defaults are
 * optional here.
 */
const AgentAsReadSchema = AgentManifestSchema.partial({
  mcpServers: true,
  workspace: true,
}).describe(
  'An agent. Read by another agent, it leaves out persona, conventions, permissions, ' +
    'mcpServers, workspace and projectPath.'
);

/** Why a read has no permission area: reading is free. */
const READ_NOTE = 'reading the registry; another agent’s private fields are left out';
/** Why a person-only read has no permission area. */
const PERSON_READ_NOTE = 'folders on this computer; only a person reads them';

/** `mesh.list_agents`: every registered agent, with its health. */
export const meshListAgentsCapability = defineCapability({
  id: 'mesh.list_agents',
  title: 'List the agents',
  description:
    'Every registered agent with its health (`healthStatus`, `lastSeenAt`), filtered by ' +
    'runtime or capability. `callerNamespace` narrows it to the namespaces that one can reach. ' +
    'Newest registered first, a page at a time: pass `nextCursor` back as `cursor` until it ' +
    'is null, or you see only the first page.',
  tier: 'observe',
  area: null,
  areaNote: READ_NOTE,
  input: AgentListQuerySchema.extend(PageQuerySchema.shape),
  output: z.object({ agents: z.array(AgentAsReadSchema), nextCursor: nextCursorOutput }),
  surfaces: { http: { method: 'get', path: '/api/mesh/agents' } },
  invoke: async (deps, { cursor, limit, ...filters }, context) => {
    const mesh = meshOf(deps);
    // The filters are bound into the cursor, and the cursor to its reader: what
    // an agent reads of another agent differs from what the person reads.
    const list = `agents:${JSON.stringify(filters)}`;
    const sealedFor = callerReaderKey(context);
    assertPageCursor(list, cursor, invalidCursor, sealedFor);
    // Newest registered first, as the registry lists them: a key that never
    // moves, so an agent registered while paging is never repeated.
    const page = keysetPage(
      list,
      mesh.meshCore.listWithHealth(filters),
      (agent) => [agent.registeredAt, agent.id],
      { cursor, limit },
      invalidCursor,
      sealedFor
    );
    const paths = mesh.meshCore.listWithPaths();
    const readable = forReader(mesh, context);
    const agents = page.items.map((agent) =>
      readable(mesh.views.projectPlacementById(agent, paths))
    );
    return { agents, nextCursor: page.nextCursor };
  },
});

/** `mesh.status`: the registry's counts. */
export const meshStatusCapability = defineCapability({
  id: 'mesh.status',
  title: 'Read the registry’s counts',
  description:
    'How many agents are registered, how many are active, and by runtime and project. ' +
    '`byProject` is keyed by folder, so an agent gets it empty.',
  tier: 'observe',
  area: null,
  areaNote: READ_NOTE,
  input: z.object({}),
  output: MeshStatusSchema,
  surfaces: { http: { method: 'get', path: '/api/mesh/status' } },
  invoke: async (deps, _input, context) => {
    const status = meshOf(deps).meshCore.getStatus();
    // Keyed by every agent's folder: a person's to read, not an agent's.
    return agentIsAsking(context) ? { ...status, byProject: {} } : status;
  },
});

/** `mesh.topology`: agents by namespace, and the rules on who may message whom. */
export const meshTopologyCapability = defineCapability({
  id: 'mesh.topology',
  title: 'Read the agent network',
  description:
    'Every agent grouped by namespace, with health, schedules and the access rules. ' +
    '`namespace` scopes the view to what that namespace can reach; `*` (the default) is all.',
  tier: 'observe',
  area: null,
  areaNote: READ_NOTE,
  input: z.object({
    namespace: z
      .string()
      .optional()
      .describe('The namespace whose view to read. Defaults to `*`, every namespace.'),
  }),
  output: TopologyViewSchema,
  surfaces: { http: { method: 'get', path: '/api/mesh/topology', query: ['namespace'] } },
  invoke: async (deps, input, context) => {
    const mesh = meshOf(deps);
    const enriched = mesh.views.enrichTopology(
      mesh.meshCore.getTopology(input.namespace ?? '*') as TopologyView,
      mesh
    );
    const readable = forReader(mesh, context);
    enriched.namespaces.forEach((ns) => {
      ns.agents = ns.agents.map((agent) => readable(mesh.views.projectPlacement(agent)));
    });
    return enriched;
  },
});

/** `mesh.list_denied`: the folders hidden from discovery. */
export const meshListDeniedCapability = defineCapability({
  id: 'mesh.list_denied',
  title: 'List the folders hidden from discovery',
  description:
    'The folders a person hid from agent discovery, with why and when. Newest first, the folder ' +
    'breaking a tie, a page at a time: pass `nextCursor` back as `cursor` for the next. A ' +
    'folder hidden, hidden again or shown while paging can repeat or be missed.',
  tier: 'observe',
  area: null,
  areaNote: PERSON_READ_NOTE,
  input: PageQuerySchema,
  output: z.object({ denied: z.array(DenialRecordSchema), nextCursor: nextCursorOutput }),
  surfaces: { http: { method: 'get', path: '/api/mesh/denied', audience: 'person' } },
  invoke: async (deps, query) => {
    const denied = meshOf(deps).meshCore.listDenied();
    const page = keysetPage(
      'mesh-denied',
      denied,
      (row) => [row.deniedAt, row.path],
      query,
      invalidCursor
    );
    return { denied: page.items, nextCursor: page.nextCursor };
  },
});

/** The registry's reads, in the mesh domain. */
export const MESH_READ_CAPABILITIES = [
  meshListAgentsCapability,
  meshStatusCapability,
  meshTopologyCapability,
  meshListDeniedCapability,
] as const;
