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
 * Each process the guard loads into records a `loaded` line first. Fewer loads than the launcher
 * processes the caller started means at least one ran unguarded (it ignored `NODE_OPTIONS`, say)
 * and proves nothing: that is an error, never a clean pass.
 *
 * @param recordPath - The file named in the guarded environment.
 * @param expectedLoads - How many launcher processes the caller started with this record.
 * @returns Distinct host names; empty when no launcher contacted any.
 * @throws When the guard loaded fewer times than `expectedLoads`.
 */
export async function readDorkosHostsContacted(
  recordPath: string,
  expectedLoads = 1
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
    .map((line) => JSON.parse(line) as DorkosHostRefusal | { loaded: number });
  const loads = lines.filter((line) => 'loaded' in line).length;
  if (loads < expectedLoads) {
    throw new Error(
      `The DorkOS-host guard loaded into ${loads} of ${expectedLoads} launcher processes`
    );
  }
  const hosts = lines.flatMap((line) => ('host' in line ? [line.host] : []));
  return [...new Set(hosts)];
}
