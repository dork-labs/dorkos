/**
 * Where the shared append's builders read their facts from.
 *
 * The builders in `agent-context.ts` are the only code that writes the text an
 * agent is told. A real turn reads its facts from disk and the process: the
 * manifest, `SOUL.md`, `NOPE.md`, the memory provider, the profile, the host.
 * The context viewer (spec `context-viewer` phase 3) needs the SAME builders
 * to write the template every agent is told, with `{{agent.name}}` where the
 * name goes. So the facts come through this seam, and the viewer hands in a
 * source whose facts are the variable tokens themselves. There is no second
 * copy of the prompt text that could drift from the real one.
 *
 * The default, {@link diskContextSource}, is exactly what a turn read before
 * the seam existed.
 *
 * @module services/runtimes/shared/source/agent-context-source
 */
import os from 'node:os';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { UserProfile } from '@dorkos/shared/config-schema';
import type { MemorySnapshot } from '@dorkos/shared/memory-provider';
import { readConventionFile } from '@dorkos/shared/convention-files-io';
import { readHomeManifest, type AgentHome } from '../../../core/agent-identity/index.js';
import { configManager } from '../../../core/config-manager.js';
import { getMemoryProvider } from '../../../memory/index.js';
import { env } from '../../../../env.js';
import { SERVER_VERSION } from '../../../../lib/version.js';
import { currentDistribution } from '../../../../lib/distribution/index.js';
import { logger } from '../../../../lib/logger.js';
import { renderMemoryNotesLine } from '../../../memory/notes-line.js';

/** The manifest fields the append reads, and nothing else. */
export type ContextManifest = Pick<
  AgentManifest,
  'name' | 'id' | 'description' | 'capabilities' | 'mcpServers'
> & {
  persona?: string;
  personaEnabled?: boolean;
  traits?: Record<string, number>;
  conventions?: { soul?: boolean; nope?: boolean; memory?: boolean; dorkosKnowledge?: boolean };
};

/** The host facts the `<env>` block prints. */
export interface ContextEnvFacts {
  /** The session's working directory. */
  cwd: string;
  /** The install kind's label. */
  app: string;
  /** The server version. */
  version: string;
  /** The server port. */
  port: string;
  /** `os.platform()`. */
  platform: string;
  /** `os.release()`. */
  osVersion: string;
  /** `process.version`. */
  node: string;
  /** `os.hostname()`. */
  hostname: string;
}

/** Every fact the shared append reads, behind one interface. */
export interface AgentContextSource {
  /** The agent's manifest, or `null` when it has none. */
  manifest(home: AgentHome): Promise<ContextManifest | null>;
  /** One convention file's text, or `null` when it is absent. */
  conventionFile(home: AgentHome, name: 'SOUL.md' | 'NOPE.md'): Promise<string | null>;
  /** The agent's memory snapshot. */
  memorySnapshot(agentId: string, home: AgentHome): Promise<MemorySnapshot>;
  /**
   * The one DorkOS-written line pointing at the agent's notes files, or `''`
   * (`memory/notes-line.ts`). May reject; the builder drops the line then.
   */
  notesLine(agentId: string, home: AgentHome): Promise<string>;
  /** The stored user profile, or nothing. */
  profile(): Partial<UserProfile> | null | undefined;
  /** The host facts for `<env>`. */
  envFacts(cwd: string): ContextEnvFacts;
  /**
   * The fence nonce, when the caller pins it. A real turn leaves it unset so
   * every render mints a fresh one; the viewer pins a placeholder, because a
   * nonce it printed would never be the one a turn carries.
   */
  readonly fenceNonce?: string;
}

/** What a real turn reads: the agent's files, the memory provider, and this host. */
export const diskContextSource: AgentContextSource = {
  manifest: (home) => readHomeManifest(home),
  conventionFile: (home, name) => readConventionFile(home, name),
  memorySnapshot: (agentId, home) => getMemoryProvider().getSnapshot({ agentId, agentPath: home }),
  notesLine: async (agentId, home) => {
    const list = await getMemoryProvider().listNotes({ agentId, agentPath: home }, { limit: 3 });
    if (list.status === 'error') {
      logger.warn('[Memory] Could not list notes for agent %s: %s', agentId, list.error);
    }
    return renderMemoryNotesLine(list);
  },
  profile: () => configManager.getAll().profile,
  envFacts: (cwd) => ({
    cwd,
    app: currentDistribution().label,
    version: SERVER_VERSION,
    port: String(env.DORKOS_PORT),
    platform: os.platform(),
    osVersion: os.release(),
    node: process.version,
    hostname: os.hostname(),
  }),
};
