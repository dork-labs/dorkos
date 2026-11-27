/**
 * The agent facts the space side serves the computer (spec
 * `computer-side-starts-alone` §5.3): who each agent is and where it lives,
 * whose home a folder is, where git may run, where an agent may work, which
 * agent a chat is, who an agent is for a tool call, and the token one launch
 * hands the agent's DorkOS CLI.
 *
 * Every answer comes from the same resolver and stores the server read
 * before the port existed (`agent-home.ts`, `may-run-git.ts`,
 * `session-agent.ts`, the identity service), read at call time, so the
 * computer sees what a space-side caller sees. The prompt and package halves
 * of the port are composed beside this at startup (`startup/agent-facts.ts`),
 * from the folders that own them.
 *
 * @module services/core/agent-identity/facts
 */
import { readConventionFile } from '@dorkos/shared/convention-files-io';
import { readManifest } from '@dorkos/shared/manifest';
import type { AgentFacts, AgentFactsPort, AgentHome } from '@dorkos/shared/agent-facts';
import { logger } from '../../../../lib/logger.js';
import {
  assertOwnDesk,
  DeskNotOwnError,
  isInsideRoomsDir,
  resolveAgentHome,
} from '../agent-home.js';
import { resolveAgentTokenEnv, describeInSessionAgent } from '../agent-token-env.js';
import { mayRunGitHere } from '../may-run-git.js';
import { chatFolderById, sessionAgentById } from '../session-agent.js';

/** One registered agent, as the registry lists it. */
export interface RegisteredAgentRef {
  /** The agent's id. */
  id: string;
  /** Its home. */
  projectPath: string;
}

/** An installed package, by name and version. */
export interface AgentPackageRef {
  /** The package name. */
  name: string;
  /** Its version. */
  version: string;
}

/** What the facts read from the rest of the server, wired once at boot. */
export interface AgentFactSources {
  /** Every registered agent, read per call off the live registry. */
  agents(): readonly RegisteredAgentRef[];
  /** The managed checkouts an agent owns. */
  desksOf(home: string): readonly string[];
  /** The agent's author id in rooms, or `null` when it has none yet. */
  authorIdOf(home: string): string | null;
  /** The packages installed in the agent's own folder. */
  packagesOf(home: string): Promise<readonly AgentPackageRef[]>;
}

let sources: AgentFactSources | undefined;

/**
 * Register (or clear) where the facts read agents, desks, authors and packages.
 * Unwired, no agent is listed.
 *
 * @param next - The live lookups, or `undefined` to clear them.
 */
export function setAgentFactSources(next: AgentFactSources | undefined): void {
  sources = next;
}

/** The identity files an agent's facts carry, when present. */
const IDENTITY_FILES = ['SOUL.md', 'NOPE.md'] as const;

/** The facts the identity half of the port serves. */
export type AgentIdentityFacts = Pick<
  AgentFactsPort,
  | 'get'
  | 'list'
  | 'ofChat'
  | 'folderOfChat'
  | 'home'
  | 'insideRoomsDir'
  | 'mayRunGit'
  | 'deskRefusal'
  | 'describeAgent'
  | 'launchTokenEnv'
>;

/**
 * One agent's facts, or `null` when its manifest cannot be read (an agent is
 * its `agent.json`, ADR-0043).
 *
 * @param from - The live lookups.
 * @param agent - The registered agent.
 */
async function factsOf(
  from: AgentFactSources,
  agent: RegisteredAgentRef
): Promise<AgentFacts | null> {
  const home = agent.projectPath as AgentHome;
  const manifest = await readManifest(home, logger);
  if (!manifest) return null;
  const files: AgentFacts['files'] = [];
  for (const name of IDENTITY_FILES) {
    const text = await readConventionFile(home, name);
    if (text !== null) files.push({ name, text });
  }
  return {
    op: 'agents.sync',
    agentId: agent.id,
    manifest: { ...manifest },
    files,
    packages: (await from.packagesOf(home)).map(({ name, version }) => ({ name, version })),
    home,
    desks: [...from.desksOf(home)],
    authorId: from.authorIdOf(home),
  };
}

/** The identity half of the agent facts port. */
export const agentIdentityFacts: AgentIdentityFacts = {
  get: async (agentId) => {
    const from = sources;
    const agent = from?.agents().find((candidate) => candidate.id === agentId);
    return from && agent ? factsOf(from, agent) : null;
  },
  list: async () => {
    const from = sources;
    if (!from) return [];
    const all = await Promise.all(from.agents().map((agent) => factsOf(from, agent)));
    return all.filter((facts): facts is AgentFacts => facts !== null);
  },
  ofChat: (sessionId) => sessionAgentById(sessionId),
  folderOfChat: (sessionId) => chatFolderById(sessionId),
  home: (dir, forAgent) => resolveAgentHome(dir, forAgent),
  insideRoomsDir: (dir) => isInsideRoomsDir(dir),
  mayRunGit: (dir) => mayRunGitHere(dir),
  deskRefusal: (forAgent, cwd, binding, defaultCwd) => {
    try {
      assertOwnDesk(forAgent, cwd, binding, defaultCwd);
      return null;
    } catch (err) {
      if (!(err instanceof DeskNotOwnError)) throw err;
      return { message: err.message, cwd: err.cwd, forAgent: err.forAgent };
    }
  },
  describeAgent: (agentPath) => describeInSessionAgent(agentPath),
  launchTokenEnv: (agentPath, displayName) => resolveAgentTokenEnv(agentPath, displayName),
};
