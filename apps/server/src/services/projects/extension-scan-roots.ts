/**
 * The project roots extension discovery scans (spec `flow-multiproject` §9.2).
 *
 * Four sources, all of them folders core found on its own:
 *
 * - every project the registry has SEEN (`list()`: sessions, agents,
 *   workspaces, installs), never one known only because an extension reported
 *   it — an extension must not widen where core looks for code to run;
 * - every project DorkOS's installer put a package into, read straight from
 *   `project-installs.json` so a plugin installed a moment ago is found without
 *   waiting for the registry's once-a-minute re-seed;
 * - the project the working directory belongs to;
 * - every registered agent's own folder (DOR-3068), which is where an
 *   agent's mini apps live (`<agentHome>/.dork/extensions/<id>`). An agent's
 *   folder is often not a project root of its own (no repository, or a
 *   subfolder of one), so the registry's roots alone would miss them, and
 *   the person would only see an agent's mini app while that agent's folder
 *   was the working directory.
 *
 * @module services/projects/extension-scan-roots
 */
import path from 'node:path';

import { logger } from '../../lib/logger.js';
import { readProjectInstalls } from '../marketplace/lib/project-install-index.js';
import type { ProjectRegistry } from './project-registry.js';

/**
 * Every project root discovery should scan besides the working directory.
 *
 * @param registry - The server's project registry.
 * @param dorkHome - DorkOS's data directory, where the install index lives.
 * @param cwd - The working directory, or null.
 * @param agentHomes - Every registered agent's folder, from the agent registry.
 * @returns Absolute roots; duplicates are the caller's to drop.
 */
export async function knownProjectRootsForExtensions(
  registry: Pick<ProjectRegistry, 'list' | 'resolve'>,
  dorkHome: string,
  cwd: string | null,
  agentHomes: () => readonly string[] = () => []
): Promise<string[]> {
  const roots = (await registry.list()).map((project) => project.root);
  roots.push(...agentHomes().filter((home) => path.isAbsolute(home)));
  try {
    roots.push(...(await readProjectInstalls(dorkHome)).map((install) => install.projectPath));
  } catch (err) {
    logger.warn('[Extensions] Could not read the project install index', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (cwd) {
    const own = await registry.resolve(cwd).catch(() => null);
    if (own) roots.push(own.root);
  }
  return roots;
}
