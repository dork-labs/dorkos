/**
 * The agent a folder belongs to, as the capability the mount serves on
 * `GET /api/agents/current?path=` (DOR-4978, ADR 261125-114705), with the
 * query and answer the hand route had: the agent's manifest with its SOUL.md,
 * NOPE.md, MEMORY.md and HEARTBEAT.md, or `null` when no agent lives there.
 *
 * It answers for the agent's HOME: a worktree or managed checkout of an
 * agent's repo resolves to the home it belongs to, never the branch's
 * committed `.dork/` copy (spec `agent-home-desk` §3.2 row 9). A folder
 * outside the ones DorkOS may use is refused with the boundary's own answer.
 *
 * Open to anyone the session gate let in, as it was: the app reads it for any
 * agent, and an agent for its own folder. An agent reading ANOTHER agent's
 * folder gets what the registry's reads give it
 * (`mesh-read-capabilities.ts`): no instructions (persona, conventions and the
 * four files), permissions, MCP servers, workspace or folder.
 *
 * @module services/mesh/doors/agent-current-capability
 */
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import { CONVENTION_FILES } from '@dorkos/shared/convention-files';
import { readConventionFile } from '@dorkos/shared/convention-files-io';
import type { CapabilityHandlerContext } from '../../core/capabilities/index.js';
import {
  defineCapability,
  type CapabilityDeps,
} from '../../core/capabilities/capability-definition.js';
import type { AgentHomeDeps } from './agent-persona-capability.js';

/** What a request that names no folder reads, as the hand route said it. */
const SEND_THE_FOLDER = 'Send the agent’s folder as `path`.';

/**
 * What an agent never reads about another agent: its instructions, its
 * permissions, its MCP servers (which can carry keys), its workspace and its
 * folder. The registry's reads leave out the same.
 */
const PRIVATE_TO_THE_AGENT = [
  'persona',
  'conventions',
  'permissions',
  'mcpServers',
  'workspace',
  'projectPath',
  'soulContent',
  'nopeContent',
  'memoryContent',
  'heartbeatContent',
] as const;

/** The deps, or a fault: the composition root always wires them. */
function depsOf(deps: CapabilityDeps): AgentHomeDeps {
  if (!deps.agentHomeDeps) throw new Error('Agent folders are not wired on this server.');
  return deps.agentHomeDeps;
}

/** A folder as the file system names it, so a symlinked spelling reads the same. */
async function realFolder(folder: string): Promise<string> {
  try {
    return await realpath(folder);
  } catch {
    return folder;
  }
}

/**
 * Whether an agent other than the one living at `home` is asking. Both
 * folders are compared as the file system names them, so an agent reading its
 * own folder through a symlink (`/tmp` for `/private/tmp`) is itself.
 */
async function anotherAgentAsks(context: CapabilityHandlerContext, home: string): Promise<boolean> {
  const asking = context.identity !== undefined || context.agentIdentityPresented === true;
  if (!asking) return false;
  const own = context.identity?.agentPath;
  if (own === undefined) return true;
  return own !== home && (await realFolder(own)) !== (await realFolder(home));
}

/** The agent at a folder, with its four files; an agent reading another gets less. */
const AgentAtFolderSchema = AgentManifestSchema.partial({ mcpServers: true, workspace: true })
  .extend({
    soulContent: z.string().nullable().optional(),
    nopeContent: z.string().nullable().optional(),
    memoryContent: z.string().nullable().optional(),
    heartbeatContent: z.string().nullable().optional(),
  })
  .nullable()
  .describe(
    'The agent, with its SOUL.md, NOPE.md, MEMORY.md and HEARTBEAT.md, or null when none lives ' +
      'there. Read by another agent, it leaves out persona, conventions, permissions, ' +
      'mcpServers, workspace, projectPath and the four files.'
  );

/** `agent.current`: the agent a folder belongs to. */
export const agentCurrentCapability = defineCapability({
  id: 'agent.current',
  title: 'Read the agent a folder belongs to',
  description:
    'The agent whose home a folder resolves to (its home, or a checkout of its repo), with ' +
    'its SOUL.md, NOPE.md, MEMORY.md and HEARTBEAT.md, or null when no agent lives there.',
  tier: 'observe',
  area: null,
  areaNote: 'reading an agent; another agent’s private fields are left out',
  input: z.object({
    path: z
      .string({ error: SEND_THE_FOLDER })
      .min(1, { error: SEND_THE_FOLDER })
      .describe('A folder of the agent: its home, or a checkout of its repo.'),
  }),
  output: AgentAtFolderSchema,
  surfaces: { http: { method: 'get', path: '/api/agents/current', query: ['path'] } },
  invoke: async (deps, { path: rawPath }, context) => {
    const found = await depsOf(deps).agentAt(rawPath);
    if (!found) return null;
    const { home, manifest } = found;
    if (await anotherAgentAsks(context, home)) {
      // Nothing private is read for another agent, so nothing private can leave.
      const kept: Record<string, unknown> = { ...manifest };
      for (const field of PRIVATE_TO_THE_AGENT) delete kept[field];
      return kept as z.infer<typeof AgentAtFolderSchema>;
    }
    const agent: Record<string, unknown> = {
      ...manifest,
      soulContent: await readConventionFile(home, CONVENTION_FILES.soul),
      nopeContent: await readConventionFile(home, CONVENTION_FILES.nope),
      // Read alongside the other two, so the editor that PATCHes `memoryContent`
      // can read back what it saved.
      memoryContent: await readConventionFile(home, CONVENTION_FILES.memory),
      // Read for the Heartbeat page's editor, for the same round-trip reason.
      heartbeatContent: await readConventionFile(home, CONVENTION_FILES.heartbeat),
    };
    return agent as z.infer<typeof AgentAtFolderSchema>;
  },
});
