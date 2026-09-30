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
 * Every DorkOS host the guarded launcher tried to reach, in first-seen order.
 *
 * The guard creates the record file the moment it loads, so a missing file means it never ran
 * (a launcher that ignored `NODE_OPTIONS`, say) and proves nothing: that is an error, not a pass.
 *
 * @param recordPath - The file named in the guarded environment.
 * @returns Distinct host names; empty when the launcher contacted none.
 */
export async function readDorkosHostsContacted(recordPath: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(recordPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('The DorkOS-host guard never loaded into the launcher', { cause: error });
    }
    throw error;
  }
  const hosts = text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as DorkosHostRefusal).host);
  return [...new Set(hosts)];
}
