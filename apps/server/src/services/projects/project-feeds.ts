/**
 * What feeds the project registry (spec `flow-multiproject` §6.1, N4).
 *
 * - **Live sessions**: every lifecycle transition a session-state projector
 *   reports carries the session's folder, and a launch or a turn always makes
 *   one, so every folder a chat runs in is resolved as soon as it runs. That
 *   is also what lets a live event stamp its project with a cache peek rather
 *   than a git call (§6.2).
 * - **Agents, workspaces and installs**: every agent's `projectPath`, every
 *   workspace `source` that is a folder on this machine, and every project a
 *   package was installed into (`project-installs.json`). Read at boot and
 *   again, at most once a minute, when the list is asked for.
 * - **Extensions**, through `ctx.projects.report` (second-class; see the registry).
 *
 * @module services/projects/project-feeds
 */
import path from 'node:path';

import { logger } from '../../lib/logger.js';
import { readProjectInstalls } from '../marketplace/lib/project-install-index.js';
import { onProjectorStatusChange } from '../session/session-state-projector.js';
import type { ProjectRegistry } from './project-registry.js';

/** What {@link startProjectRegistry} reads the seed folders from. */
export interface ProjectFeedSources {
  /** The server's data directory, where the install index lives. */
  dorkHome: string;
  /** Every registered agent's folder. */
  agentPaths: () => string[];
  /** Every workspace's `source` (a folder or a remote address). */
  workspaceSources: () => string[];
}

async function installedProjectPaths(dorkHome: string): Promise<string[]> {
  try {
    return (await readProjectInstalls(dorkHome)).map((install) => install.projectPath);
  } catch (err) {
    // A corrupt index costs only these seeds; the installer repairs it.
    logger.warn('[project-registry] could not read the project install index', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Seed the registry and keep it fed from live sessions. Called once at boot,
 * after the agent registry exists. The store is attached much earlier, before
 * extensions start (`index.ts`), so no name is handed out before the saved
 * names are loaded.
 *
 * @param registry - The server's project registry, its store already attached.
 * @param sources - Where the seed folders come from.
 * @returns Stops the live-session feed.
 */
export function startProjectRegistry(
  registry: ProjectRegistry,
  sources: ProjectFeedSources
): () => void {
  void registry.setSources(async () => [
    ...sources.agentPaths(),
    // A workspace source may be a remote address; only a folder names a project.
    ...sources.workspaceSources().filter((source) => path.isAbsolute(source)),
    ...(await installedProjectPaths(sources.dorkHome)),
  ]);
  return onProjectorStatusChange(({ cwd }) => {
    if (!cwd || !path.isAbsolute(cwd)) return;
    void registry.resolve(cwd).catch((err) => {
      logger.warn('[project-registry] could not resolve a session folder', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}
