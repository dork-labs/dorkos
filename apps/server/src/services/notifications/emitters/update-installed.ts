/**
 * Notices, once, that DorkOS is running a version it was not running before.
 *
 * **There is no seam for this**, because nothing in the server ever learns that
 * an update happened: the CLI replaces the bundle and the next boot is simply a
 * different program. The existing update checker asks npm what the LATEST
 * version is, which is a different question. So this is a boot-time comparison
 * against the last version that booted, kept in one small file beside the rest
 * of DorkOS's data.
 *
 * A file rather than a config field on purpose: this is a fact DorkOS records
 * about itself, not a setting anybody chooses, and putting it in `config.json`
 * would put a machine-written value in the file a person edits.
 *
 * @module services/notifications/emitters/update-installed
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import { IS_DEV_BUILD, SERVER_VERSION } from '../../../lib/version.js';
import { logger } from '../../../lib/logger.js';
import { notify } from '../notification-service.js';

/** Where the last version that booted is remembered, under the data directory. */
const STATE_FILE = path.join('state', 'last-seen-version.json');

/** What that file holds. */
interface LastSeenVersion {
  version: string;
}

/**
 * Raise `update.installed` when this boot is running a different version from
 * the last one, and remember the current version either way.
 *
 * Silent on the very first boot that records a version: there is nothing to
 * compare against, and "DorkOS updated to 0.60.0" is not true of a fresh
 * install. Silent in a development tree too, where the version is a placeholder
 * that never moves.
 *
 * Never throws: a version file that cannot be read or written costs a
 * notification, and nothing else.
 *
 * @param dorkHome - The resolved data directory.
 */
export async function announceInstalledVersion(dorkHome: string): Promise<void> {
  if (IS_DEV_BUILD) return;

  const file = path.join(dorkHome, STATE_FILE);
  try {
    const previousVersion = await readLastSeen(file);
    if (previousVersion === SERVER_VERSION) return;

    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(
      file,
      JSON.stringify({ version: SERVER_VERSION } satisfies LastSeenVersion)
    );

    // Recording the version has to happen whether or not anything is announced,
    // so a first boot is silent ONCE rather than on every boot after it.
    if (previousVersion === undefined) return;

    await notify('update.installed', { version: SERVER_VERSION, previousVersion });
  } catch (err) {
    logger.debug('[Notifications] Could not settle the installed version', { err });
  }
}

/** The version that booted last, or `undefined` when nothing recorded one. */
async function readLastSeen(file: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as Partial<LastSeenVersion>;
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    // Absent, unreadable or corrupt all mean the same thing here: nothing to
    // compare against. The write below replaces it.
    return undefined;
  }
}
