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
import type { UnprovenFiles } from '../installed-files.js';

/** Most kept files one {@link describeUnproven} sentence names. */
export const UNPROVEN_NAMED_LIMIT = 10;

/**
 * One sentence about the files an update or uninstall kept because nothing
 * proved whose they were: why, which (up to {@link UNPROVEN_NAMED_LIMIT}), and
 * what the person can do next. After an update the package is still there, so
 * Check files can sort them once the old version can be fetched; after an
 * uninstall, the files are simply the person's to keep or delete.
 *
 * @param name - The package name.
 * @param why - Why nothing could be proven.
 * @param kept - The kept files, as paths relative to the install folder.
 * @param after - What just ran.
 */
export function describeUnproven(
  name: string,
  why: UnprovenFiles['why'],
  kept: readonly string[],
  after: 'update' | 'uninstall'
): string {
  const sorted = [...kept].sort();
  const n = sorted.length;
  const files = n === 1 ? '1 file' : `${n} files`;
  const them = n === 1 ? 'it' : 'them';
  const was = n === 1 ? 'was' : 'were';
  const shown = `${sorted.slice(0, UNPROVEN_NAMED_LIMIT).join(', ')}${n > UNPROVEN_NAMED_LIMIT ? ', …' : ''}`;
  const whose = after === 'update' ? 'yours or left over from that version' : `yours or ${name}'s`;
  const cause =
    why === 'fetch-failed'
      ? `DorkOS couldn't download the version of ${name} you had, so it couldn't tell whether ${files} ${was} ${whose}.`
      : why === 'mismatch'
        ? `The version of ${name} DorkOS downloaded didn't match the files you had, so it couldn't tell whether ${files} ${was} yours.`
        : `${name} was installed from a folder on this computer, so DorkOS had no earlier version to compare with and couldn't tell whether ${files} ${was} yours.`;
  const next =
    after === 'uninstall' || why === 'no-source'
      ? "Delete any you don't need."
      : why === 'fetch-failed'
        ? `Once you're online, choose Check files on ${name} to sort ${them} out.`
        : `Choose Check files on ${name} to sort ${them} out.`;
  return `${cause} It kept ${them}: ${shown}. ${next}`;
}
