/**
 * `ctx.projects`: an extension's view of the project registry (spec
 * `flow-multiproject` §6.1, §11.2).
 *
 * Scoped to the calling extension, so an extension does not learn every
 * folder the person works in: `list()` answers only the projects that hold a
 * copy of it and the ones it reported itself. `resolve()` and `report()` both
 * apply the directory boundary to the folder and to its root, and need a git
 * repository; a project an extension names that core had not seen is recorded
 * as `reported`, which never widens where core looks for extension code and
 * stays out of the person's list, and counts against the extension's cap of
 * `MAX_REPORTED_ROOTS_PER_EXTENSION`. Only `report()` adds a project to the
 * extension's own list.
 *
 * @module services/projects/extension-projects-api
 */
import type { ProjectRef, ProjectsApi } from '@dorkos/extension-api/server';

import { logger } from '../../lib/logger.js';

import type { ProjectRegistry } from './project-registry.js';

/**
 * Build one extension's {@link ProjectsApi}. Every change listener it adds is
 * tracked, so `release` removes them when the extension shuts down or reloads.
 *
 * @param extensionId - The extension the API answers for.
 * @param registry - The server's project registry.
 */
export function createProjectsApi(
  extensionId: string,
  registry: ProjectRegistry
): { projects: ProjectsApi; release: () => void } {
  const removers = new Set<() => void>();
  let released = false;
  let warned = false;

  /**
   * A storage failure (a full disk, or a clash with another server process on
   * the same database) reaches the extension as "no project", never as a raw
   * SQLite error. Logged once per extension instance.
   */
  const orNull = async (named: Promise<ProjectRef | null>): Promise<ProjectRef | null> => {
    try {
      return await named;
    } catch (err) {
      if (!warned) {
        warned = true;
        logger.warn(`[ext:${extensionId}] could not record a project; answering null`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    }
  };

  const projects: ProjectsApi = {
    resolve(cwd) {
      if (typeof cwd !== 'string' || cwd.length === 0) return Promise.resolve(null);
      return orNull(
        registry
          .resolveWithin(cwd, extensionId)
          .then((project) => (project === 'outside' ? null : project))
      );
    },
    list() {
      return registry.listForExtension(extensionId);
    },
    report(dir) {
      return typeof dir === 'string' && dir.length > 0
        ? orNull(registry.report(dir, extensionId))
        : Promise.resolve(null);
    },
    onChange(listener) {
      if (released) {
        throw new Error(
          `projects.onChange was called after the extension "${extensionId}" shut down or reloaded.`
        );
      }
      if (typeof listener !== 'function') {
        throw new TypeError('projects.onChange needs a listener function.');
      }
      const remove = registry.onChange(listener);
      let removed = false;
      const once = () => {
        if (removed) return;
        removed = true;
        removers.delete(once);
        remove();
      };
      removers.add(once);
      return once;
    },
  };

  return {
    projects,
    release: () => {
      released = true;
      for (const remove of [...removers]) remove();
    },
  };
}
