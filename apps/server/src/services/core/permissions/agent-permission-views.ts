/**
 * One agent's permissions and the level it runs at, as the capabilities the
 * mount serves on `GET /api/agents/{agentId}/permissions` and
 * `GET /api/agents/{agentId}/level` (DOR-4978, ADR 261125-114705).
 *
 * Both are reads, `observe` with no permission area, like `list_my_permissions`:
 * a switch that blocked them would hide an agent's own settings from it and
 * stop nothing. Neither changes anything, so neither can raise any agent's
 * power; the change stays `PATCH /api/agents/:agentId/permissions`, a person's.
 *
 * **Every reader, as before.** Whoever could read the hand routes still can: a
 * person, a program with the API key, and an agent, its own or another's.
 * `GET /api/permissions` and its history already show every agent's settings,
 * and agents are trusted co-workers (`dorkos agent permissions <agent>` runs
 * from an agent's shell).
 *
 * @module services/core/permissions/agent-permission-views
 */
import { z } from 'zod';
import {
  AgentLevelResponseSchema,
  AgentPermissionsResponseSchema,
  type AgentLevelResponse,
} from '@dorkos/shared/permissions';
import {
  defineCapability,
  type CapabilityDomain,
  CapabilityToolError,
} from '../capabilities/capability-definition.js';
import { PermissionError, type PermissionService } from './permission-service.js';

/** What the running server teaches these reads to read from. */
export interface AgentPermissionViews {
  /** The one owner of every permission read and write. */
  permissions: Pick<PermissionService, 'getAgent'>;
  /** The level an agent runs at (`agent-level.ts`); `null` for an id no agent has. */
  readLevel: (agentId: string) => Promise<AgentLevelResponse | null>;
}

let views: AgentPermissionViews | undefined;

/**
 * Teach `permissions.view_agent` and `permissions.view_agent_level` where to read.
 *
 * @param next - The readers, or `undefined` at shutdown.
 */
export function setAgentPermissionViews(next: AgentPermissionViews | undefined): void {
  views = next;
}

/** The tool code an id no agent has answers with: `404 agent_not_found`. */
export const UNKNOWN_AGENT_CODE = 'PERMISSIONS_UNKNOWN_AGENT';

/** The agent a path names. */
const AgentIdInput = z.object({
  id: z.string().min(1).max(200).describe('The agent’s id.'),
});

/** Why these reads have no permission area. */
const READ_NOTE = 'reading permissions changes nothing; the settings page shows every agent’s';

/** No agent with that id. */
function unknownAgent(): CapabilityToolError {
  return new CapabilityToolError({
    code: UNKNOWN_AGENT_CODE,
    error: 'No agent with that id.',
  });
}

/** The readers, or a refusal while boot has not handed them over. */
function wiredViews(): AgentPermissionViews {
  if (views) return views;
  throw new CapabilityToolError({ code: 'NOT_READY', error: 'DorkOS is still starting.' });
}

/** `permissions.view_agent`: one agent's permissions, where each came from. */
export const viewAgentPermissionsCapability = defineCapability({
  id: 'permissions.view_agent',
  title: 'Read one agent’s permissions',
  description:
    'The agent’s resolved state per area and per action, where each came from, and what it ' +
    'would be without the agent’s own settings.',
  tier: 'observe',
  area: null,
  areaNote: READ_NOTE,
  input: AgentIdInput,
  output: AgentPermissionsResponseSchema,
  surfaces: {
    http: { method: 'get', path: '/api/agents/{agentId}/permissions', params: { agentId: 'id' } },
  },
  invoke: async (_deps, { id }) => {
    const wired = wiredViews();
    try {
      return await wired.permissions.getAgent(id);
    } catch (err) {
      if (err instanceof PermissionError && err.code === 'UNKNOWN_AGENT') throw unknownAgent();
      throw err;
    }
  },
});

/** `permissions.view_agent_level`: the Files & commands level an agent starts at. */
export const viewAgentLevelCapability = defineCapability({
  id: 'permissions.view_agent_level',
  title: 'Read the level an agent runs at',
  description:
    'The Files & commands level a new chat of this agent starts at, before any per-chat limit, ' +
    'the level its runtime’s agents get by default, and whether a person’s setting holds it ' +
    'lower.',
  tier: 'observe',
  area: null,
  areaNote: READ_NOTE,
  input: AgentIdInput,
  output: AgentLevelResponseSchema,
  surfaces: {
    http: { method: 'get', path: '/api/agents/{agentId}/level', params: { agentId: 'id' } },
  },
  invoke: async (_deps, { id }) => {
    const wired = wiredViews();
    const level = await wired.readLevel(id);
    if (!level) throw unknownAgent();
    return level;
  },
});

/** The permission reads the app's Permissions and profile pages make, one agent at a time. */
export const permissionViewsDomain: CapabilityDomain = {
  name: 'permissions',
  capabilities: [viewAgentPermissionsCapability, viewAgentLevelCapability],
};
