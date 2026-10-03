/**
 * Dev links, as Harness Sync reads them (DOR-2696, spec `marketplace-dev-link`
 * §5).
 *
 * A dev link is a symlink (a junction on Windows) in a package's normal slot,
 * `<dorkHome>/plugins/<name>` or `<project>/.dork/plugins/<name>`, pointing at a
 * developer's working folder, plus one record in
 * `<dorkHome>/marketplace/dev-links.json` that DorkOS writes only on a person's
 * yes. The scan follows a symlinked slot for exactly that pair and nothing
 * else: a link somebody committed into a repository, made by hand, or pointed
 * somewhere new since the record was written stays skipped, as every link in a
 * plugins root always was (the containment rule `collectPortableSkills` states).
 *
 * The registry is read with the same parser the server and the CLI use
 * (`parseDevLinksFile`), so the three can never disagree about what the file
 * says. A file that cannot be read or parsed yields no records: no slot may
 * count as dev-linked on the strength of a file nobody can read.
 *
 * @module sources/dev-links
 */
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_TEXT_MAX_BYTES, readTextFileWithinSync } from '@dorkos/shared/bounded-read';
import {
  DEV_LINKS_FILE,
  parseDevLinksFile,
  type DevLinkRecord,
} from '@dorkos/shared/marketplace-schemas';

/**
 * Every recorded dev link, read synchronously off `<dorkHome>/marketplace/dev-links.json`.
 *
 * @param dorkHome - The resolved DorkOS data directory, or `undefined` when the
 *   caller has none (an offline sync), which means no dev links at all.
 * @returns The records, or none when there is no file or it cannot be read or parsed.
 */
export function readDevLinksSync(dorkHome: string | undefined): DevLinkRecord[] {
  if (dorkHome === undefined) return [];
  let text: string;
  try {
    text = readTextFileWithinSync(
      join(dorkHome, DEV_LINKS_FILE),
      PACKAGE_TEXT_MAX_BYTES,
      'The dev links file'
    );
  } catch {
    return [];
  }
  const parsed = parseDevLinksFile(text);
  return parsed === 'unreadable' ? [] : parsed.links;
}

/** A path's real path as the operating system spells it, or `null` when it cannot be resolved. */
function realPathOf(target: string): string | null {
  try {
    // `.native`, the same resolver the server's `fs.promises.realpath` uses to
    // write `record.target`, so the two spell one folder the same way
    // (including letter case on a case-insensitive disk).
    return realpathSync.native(target);
  } catch {
    return null;
  }
}

/**
 * The dev link record a symlinked plugin slot may be followed for, or `null`.
 *
 * All four must hold: the slot itself is a link (`lstat`); a record names
 * exactly this slot, spelled canonically (its plugins root resolved, its own
 * name kept, as the server records it); the record is for this scope; and the
 * slot resolves to exactly the folder the record names. A retargeted link
 * fails the last test and is treated like any other link: skipped.
 *
 * @param pluginsRoot - The plugins root the slot sits in, as the scan spells it.
 * @param entryName - The slot's name in that root.
 * @param scope - Which root this is.
 * @param records - The recorded dev links.
 * @returns The matching record, or `null` when the slot must be skipped.
 */
export function devLinkForSlot(
  pluginsRoot: string,
  entryName: string,
  scope: DevLinkRecord['scope'],
  records: readonly DevLinkRecord[]
): DevLinkRecord | null {
  if (records.length === 0) return null;
  const slot = join(pluginsRoot, entryName);
  if (lstatSync(slot, { throwIfNoEntry: false })?.isSymbolicLink() !== true) return null;
  const realRoot = realPathOf(pluginsRoot);
  if (realRoot === null) return null;
  const canonicalSlot = join(realRoot, entryName);
  const record = records.find((r) => r.scope === scope && r.slot === canonicalSlot);
  if (!record) return null;
  return isStillLinked(slot, record) ? record : null;
}

/**
 * Whether a slot still resolves to exactly the folder its record names. Asked
 * again after a scan has read through the link, so a link pointed elsewhere
 * while the scan ran does not leave the scan's reading of the other folder
 * standing.
 *
 * @param slot - The slot path.
 * @param record - Its dev link record.
 * @returns True while the slot resolves to `record.target`.
 */
export function isStillLinked(slot: string, record: Pick<DevLinkRecord, 'target'>): boolean {
  return realPathOf(slot) === record.target;
}
