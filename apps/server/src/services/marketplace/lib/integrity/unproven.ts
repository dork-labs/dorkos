/**
 * Files an update or uninstall of an older install kept because nothing proved
 * whose they were (DOR-2322; spec `marketplace-install-verification` §13).
 *
 * When an install made before DorkOS recorded package files is changed and
 * the version it came from cannot be checked, its rebuilt record lists the
 * files it could not tie to the package as `unproven`. They are kept as the
 * person's, and this module says so in one plain sentence.
 *
 * @module services/marketplace/lib/integrity/unproven
 */
import type { InstalledFiles, UnprovenFiles } from '../installed-files.js';
import { addedEffectFiles } from './strict-differences.js';

/** Most kept files one {@link describeUnproven} sentence names. */
export const UNPROVEN_NAMED_LIMIT = 10;

/**
 * The kept files that sit where a package keeps what it runs (a skill, a
 * command, a hook, a program), so they still run: the same paths
 * `addedEffectFiles` counts, limited to the record's unproven list.
 *
 * @param root - The install folder.
 * @param record - Its record.
 * @returns The running kept files, sorted.
 */
export async function runningUnproven(root: string, record: InstalledFiles): Promise<string[]> {
  const kept = Object.keys(record.unproven?.files ?? {});
  if (kept.length === 0) return [];
  const added = new Set(await addedEffectFiles(root, record));
  return kept.filter((p) => added.has(p)).sort();
}

/** "a, b, c", or the first {@link UNPROVEN_NAMED_LIMIT} and "…". */
function named(paths: readonly string[]): string {
  const sorted = [...paths].sort();
  return `${sorted.slice(0, UNPROVEN_NAMED_LIMIT).join(', ')}${sorted.length > UNPROVEN_NAMED_LIMIT ? ', …' : ''}`;
}

/**
 * One sentence about the files an update or uninstall kept because nothing
 * proved whose they were: why, which (up to {@link UNPROVEN_NAMED_LIMIT}),
 * which of them still run, and what the person can do next. After an update
 * the package is still there, so Check files can sort them once the earlier
 * version can be fetched; after an uninstall they are the person's to keep or
 * delete. `carried` means an earlier update kept them and this change kept
 * them again.
 *
 * @param name - The package name.
 * @param why - Why nothing could be proven.
 * @param kept - The kept files, as paths relative to the install folder.
 * @param after - What just ran.
 * @param opts - `carried`: an earlier update kept them; `running`: the kept files that still run.
 */
export function describeUnproven(
  name: string,
  why: UnprovenFiles['why'],
  kept: readonly string[],
  after: 'update' | 'uninstall',
  opts: { carried?: boolean; running?: readonly string[] } = {}
): string {
  const n = kept.length;
  const files = n === 1 ? '1 file' : `${n} files`;
  const them = n === 1 ? 'it' : 'them';
  const was = n === 1 ? 'was' : 'were';
  const running = opts.running ?? [];
  const runs =
    running.length === 0
      ? ''
      : ` ${running.length} of these still ${running.length === 1 ? 'runs' : 'run'}: ${named(running)}.`;
  const next =
    after === 'uninstall' || why === 'no-source'
      ? "Delete any you don't need."
      : why === 'fetch-failed' && !opts.carried
        ? `Once you're online, choose Check files on ${name} to sort ${them} out.`
        : `Choose Check files on ${name} to sort ${them} out.`;
  if (opts.carried) {
    return `An earlier update of ${name} kept ${files} DorkOS couldn't tell ${was} yours. ${n === 1 ? "It's" : "They're"} still here: ${named(kept)}.${runs} ${next}`;
  }
  const whose = after === 'update' ? 'yours or left over from that version' : `yours or ${name}'s`;
  const cause =
    why === 'fetch-failed'
      ? `DorkOS couldn't download the version of ${name} you had, so it couldn't tell whether ${files} ${was} ${whose}.`
      : why === 'mismatch'
        ? `The version of ${name} DorkOS downloaded didn't match the files you had, so it couldn't tell whether ${files} ${was} yours.`
        : `${name} was installed from a folder on this computer, so DorkOS had no earlier version to compare with and couldn't tell whether ${files} ${was} yours.`;
  return `${cause} It kept ${them}: ${named(kept)}.${runs} ${next}`;
}
