/**
 * A person's one-time move of an agent's old `persona` field into SOUL.md, as
 * the capability the mount serves on `POST /api/agents/current/migrate-persona`
 * (DOR-4978, ADR 261125-114705), with the path, query and body the hand route
 * had. It answers for the agent's HOME: a worktree or managed checkout of an
 * agent's repo resolves to the home it belongs to, never the branch's
 * committed `.dork/` copy (spec `agent-home-desk` §3.2 row 9).
 *
 * **A person's** (`http.audience: 'person'`), with no MCP surface: it writes an
 * agent's instructions and can add its NOPE.md. An agent that wants to change
 * SOUL.md uses `update_agent`, which its Agents area gates; this door gives it
 * no second way past that gate.
 *
 * @module services/mesh/doors/agent-persona-capability
 */
import { z } from 'zod';
import {
  buildSoulContent,
  CONVENTION_FILES,
  defaultNopeTemplate,
} from '@dorkos/shared/convention-files';
import { readConventionFile, writeConventionFile } from '@dorkos/shared/convention-files-io';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import {
  defineCapability,
  type CapabilityDeps,
  CapabilityToolError,
} from '../../core/capabilities/capability-definition.js';

/** The agent at a folder, as the composition root finds it (`startup/steps/agent-persona-deps.ts`). */
export interface AgentAtFolder {
  /** The agent's home: a checkout resolves to the home it belongs to. */
  home: string;
  /** The home's manifest, as read from disk. */
  manifest: Record<string, unknown>;
}

/** What the persona move reads from the composition root, so this domain imports no other. */
export interface AgentHomeDeps {
  /**
   * The agent a folder belongs to, or `null` when none lives there. Throws the
   * capability's path refusal for a folder the boundary refuses.
   */
  agentAt(rawPath: string): Promise<AgentAtFolder | null>;
}

declare module '../../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** How the persona move finds the agent a folder belongs to. */
    agentHomeDeps?: AgentHomeDeps;
  }
}

/** The tool code a folder with no agent answers with: `404 not_found`. */
export const NO_AGENT_IN_FOLDER = 'AGENT_FOLDER_NOT_FOUND';

/** What a request that names no folder reads, as the hand route said it. */
const SEND_THE_FOLDER = 'Send the agent’s folder as `path`.';

/** The folder a query names. */
const FolderInput = z.object({
  path: z
    .string({ error: SEND_THE_FOLDER })
    .min(1, { error: SEND_THE_FOLDER })
    .describe('A folder of the agent: its home, or a checkout of its repo.'),
});

/** The deps, or a fault: the composition root always wires them. */
function depsOf(deps: CapabilityDeps): AgentHomeDeps {
  if (!deps.agentHomeDeps) throw new Error('The persona move is not wired on this server.');
  return deps.agentHomeDeps;
}

/** `agent.migrate_persona`: move an old `persona` field into SOUL.md, once. */
export const migratePersonaCapability = defineCapability({
  id: 'agent.migrate_persona',
  title: 'Move an agent’s old persona into SOUL.md',
  description:
    'Write an agent’s old `persona` field into SOUL.md with its traits, and add NOPE.md if it ' +
    'has none. Nothing changes when SOUL.md already exists or there is no persona.',
  tier: 'act',
  area: null,
  areaNote: 'a person’s door; agents change SOUL.md with update_agent',
  input: FolderInput,
  output: z.object({ migrated: z.boolean(), reason: z.string().optional() }),
  surfaces: {
    http: {
      method: 'post',
      path: '/api/agents/current/migrate-persona',
      query: ['path'],
      audience: 'person',
    },
  },
  invoke: async (deps, { path: rawPath }) => {
    const found = await depsOf(deps).agentAt(rawPath);
    if (!found) {
      throw new CapabilityToolError({
        code: NO_AGENT_IN_FOLDER,
        error: 'No agent is registered in that folder.',
      });
    }
    const { home, manifest } = found;
    if (await readConventionFile(home, CONVENTION_FILES.soul)) {
      return { migrated: false, reason: 'SOUL.md already exists' };
    }
    const { persona, traits } = manifest as {
      persona?: string;
      traits?: Record<string, number>;
    };
    if (!persona) return { migrated: false, reason: 'No persona to migrate' };
    const traitBlock = renderTraits({ ...DEFAULT_TRAITS, ...traits });
    await writeConventionFile(home, CONVENTION_FILES.soul, buildSoulContent(traitBlock, persona));
    if (!(await readConventionFile(home, CONVENTION_FILES.nope))) {
      await writeConventionFile(home, CONVENTION_FILES.nope, defaultNopeTemplate());
    }
    return { migrated: true };
  },
});
