/**
 * The project roots extension discovery scans (spec `flow-multiproject` §9.2).
 *
 * Three sources, all of them folders core found on its own:
 *
 * - every project the registry has SEEN (`list()`: sessions, agents,
 *   workspaces, installs), never one known only because an extension reported
 *   it — an extension must not widen where core looks for code to run;
 * - every project DorkOS's installer put a package into, read straight from
 *   `project-installs.json` so a plugin installed a moment ago is found without
 *   waiting for the registry's once-a-minute re-seed;
 * - the project the working directory belongs to.
 *
 * @module services/projects/extension-scan-roots
 */
import { logger } from '../../lib/logger.js';
import { readProjectInstalls } from '../marketplace/lib/project-install-index.js';
import type { ProjectRegistry } from './project-registry.js';

/**
 * Every project root discovery should scan besides the working directory.
 *
 * @param registry - The server's project registry.
 * @param dorkHome - DorkOS's data directory, where the install index lives.
 * @param cwd - The working directory, or null.
 * @returns Absolute roots; duplicates are the caller's to drop.
 */
export async function knownProjectRootsForExtensions(
  registry: Pick<ProjectRegistry, 'list' | 'resolve'>,
  dorkHome: string,
  cwd: string | null
): Promise<string[]> {
  const roots = (await registry.list()).map((project) => project.root);
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
