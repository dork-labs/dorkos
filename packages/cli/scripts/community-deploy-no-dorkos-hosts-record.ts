/**
 * Loads the DorkOS-host guard into an installed launcher and reads back what it refused. Shared by
 * the offline package proof and the paid live gate, so both hold the launcher to the same check
 * (DOR-2593).
 *
 * @module scripts/community-deploy-no-dorkos-hosts-record
 */
import { readFile } from 'node:fs/promises';
import {
  NO_DORKOS_HOSTS_RECORD_VARIABLE,
  type DorkosGuardLoad,
  type DorkosHostRefusal,
} from './community-deploy-no-dorkos-hosts.mjs';

/** The guard preload, as the file URL `--import` takes (a URL survives spaces in the path). */
export const NO_DORKOS_HOSTS_GUARD_URL = new URL(
  './community-deploy-no-dorkos-hosts.mjs',
  import.meta.url
).href;

/**
 * Add the guard to a launcher environment. It is appended to any existing `NODE_OPTIONS`, so it
 * loads after an offline fake that replaces `fetch` and wraps that fake from the outside.
 *
 * @param environment - The environment the launcher would otherwise run with.
 * @param recordPath - File the guard appends each refused attempt to.
 * @returns A new environment with the guard loaded and the record file named.
 */
export function withNoDorkosHostsGuard(
  environment: Readonly<Record<string, string>>,
  recordPath: string
): Record<string, string> {
  const existing = environment.NODE_OPTIONS?.trim();
  const preload = `--import=${NO_DORKOS_HOSTS_GUARD_URL}`;
  return {
    ...environment,
    NODE_OPTIONS: existing ? `${existing} ${preload}` : preload,
    [NO_DORKOS_HOSTS_RECORD_VARIABLE]: recordPath,
  };
}

/**
 * Every DorkOS host the guarded launchers tried to reach, in first-seen order.
 *
 * Each process the guard loads into records a `loaded` line naming its parent. The caller lists the
 * parent of every launcher it started (its own pid for a direct spawn, a wrapper's pid otherwise),
 * once per launcher; each parent must have exactly that many guarded children. Loads with any
 * other parent (a guarded node grandchild) are ignored, so they can never stand in for a launcher
 * that ran unguarded, and an unguarded launcher is an error, never a clean pass.
 *
 * @param recordPath - The file named in the guarded environment.
 * @param launcherParents - The parent pid of each launcher process started, one entry per launcher;
 *   `null` skips the load check (a best-effort read on a failure path).
 * @returns Distinct host names; empty when no launcher contacted any.
 * @throws When a listed parent has a different number of guarded children than it started.
 */
export async function readDorkosHostsContacted(
  recordPath: string,
  launcherParents: readonly number[] | null
): Promise<string[]> {
  let text = '';
  try {
    text = await readFile(recordPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lines = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DorkosHostRefusal | DorkosGuardLoad);
  if (launcherParents) {
    const loads = lines.flatMap((line) => ('loaded' in line ? [line.parent] : []));
    const count = (list: readonly number[], parent: number) =>
      list.filter((item) => item === parent).length;
    for (const parent of new Set(launcherParents)) {
      const started = count(launcherParents, parent);
      const guarded = count(loads, parent);
      if (guarded !== started) {
        throw new Error(
          `The DorkOS-host guard loaded into ${guarded} of the ${started} launcher processes started by ${parent}`
        );
      }
    }
  }
  const hosts = lines.flatMap((line) => ('host' in line ? [line.host] : []));
  return [...new Set(hosts)];
}
