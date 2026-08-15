/**
 * Backups of a config file that had to be replaced.
 *
 * ## Why a single `.bak` was not enough
 *
 * Recovery used to copy the doomed file to one fixed `config.json.bak`. That
 * file is the person's settings, and the next recovery overwrote it — so a
 * machine that hit the recovery path more than once kept only the LAST wipe's
 * evidence, and the settings from before the first one were gone for good. That
 * really happened: five recoveries were logged on one machine and a single
 * `.bak` survived them, holding a config that had already been replaced by
 * defaults.
 *
 * So backups are timestamped and rotated. Each recovery writes its own file, the
 * newest {@link CONFIG_BACKUPS_KEPT} are kept, and older ones are pruned. The
 * name is sortable and carries no colon, because a colon in a filename is not
 * portable to Windows.
 *
 * The pre-rotation `config.json.bak` is deliberately left alone by everything
 * here: it does not match {@link CONFIG_BACKUP_PATTERN}, so pruning never
 * removes it, and someone whose settings are in it keeps them.
 *
 * @module services/core/config/backups
 */
import fs from 'fs';
import path from 'path';
import { logger, logError } from '../../../lib/logger.js';

/**
 * How many timestamped backups to keep.
 *
 * Enough to cover a run of recoveries — the reason rotation exists — without
 * letting a machine that recovers in a loop fill the data directory. At a few
 * kilobytes each this is a rounding error on disk.
 */
export const CONFIG_BACKUPS_KEPT = 10;

/**
 * How many names one millisecond may hold before this gives up.
 *
 * Only reached when {@link CONFIG_BACKUP_COLLISION_LIMIT} processes recover the
 * same file inside the same millisecond, which is not a thing that happens — but
 * an uncapped search for a free name is a boot path that can hang, and hanging
 * is a worse failure than saying so.
 */
const CONFIG_BACKUP_COLLISION_LIMIT = 100;

/**
 * The names {@link backupConfigFile} writes, and the only ones pruning removes.
 *
 * `config-20260815-134501-902.json.bak` is the usual shape: date, time,
 * milliseconds. Group 1 is that stamp; group 2 is the collision counter, present
 * only on the second and later backup of one millisecond.
 *
 * Not exported. It describes a naming scheme that is this module's business, and
 * a test that reused it would be agreeing with the code rather than checking it.
 */
const CONFIG_BACKUP_PATTERN = /^config-(\d{8}-\d{6}-\d{3})(?:-(\d+))?\.json\.bak$/;

/**
 * Zero-pad a number to a fixed width.
 *
 * @param value - The number to pad.
 * @param width - How many digits the result must have.
 */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * The timestamp part of a backup name, in local time.
 *
 * Local rather than UTC because the only person who reads these names is the one
 * whose machine wrote them, and they are looking for "the one from this
 * morning".
 *
 * @param when - The moment to stamp.
 */
function stamp(when: Date): string {
  const date = `${when.getFullYear()}${pad(when.getMonth() + 1, 2)}${pad(when.getDate(), 2)}`;
  const time = `${pad(when.getHours(), 2)}${pad(when.getMinutes(), 2)}${pad(when.getSeconds(), 2)}`;
  return `${date}-${time}-${pad(when.getMilliseconds(), 3)}`;
}

/**
 * A backup name split into the two things age is decided by.
 *
 * @param name - A filename that matched {@link CONFIG_BACKUP_PATTERN}.
 */
function ageKeyOf(name: string): { stamp: string; collision: number } {
  const match = CONFIG_BACKUP_PATTERN.exec(name)!;
  return { stamp: match[1]!, collision: match[2] === undefined ? 1 : Number(match[2]) };
}

/**
 * Every timestamped backup in a directory, newest first.
 *
 * Sorted on the parsed name rather than the string, because a plain string sort
 * gets the collision case backwards: `-` (0x2D) is below `.` (0x2E), so
 * `config-…-000-2.json.bak` sorts BEFORE `config-…-000.json.bak` and the newer
 * of the two would be pruned first at the ten-backup boundary.
 *
 * @param dir - The directory holding `config.json`.
 * @returns Absolute paths, newest first. Empty when the directory cannot be read.
 */
export function listConfigBackups(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((name) => CONFIG_BACKUP_PATTERN.test(name))
    .sort((a, b) => {
      const left = ageKeyOf(a);
      const right = ageKeyOf(b);
      if (left.stamp !== right.stamp) return left.stamp < right.stamp ? 1 : -1;
      return right.collision - left.collision;
    })
    .map((name) => path.join(dir, name));
}

/**
 * Copy a config file that is about to be replaced to a timestamped backup, and
 * prune the older ones.
 *
 * Throws whatever the copy threw. The caller treats a refused copy as a reason
 * to STOP rather than to replace the file anyway — half-replacing settings is
 * the outcome this whole module exists to prevent — so the failure must not be
 * swallowed here. Pruning is best-effort by contrast: failing to delete an old
 * backup is not a reason to abandon a recovery that has already succeeded.
 *
 * @param configPath - Absolute path of the file being replaced.
 * @param now - The moment to stamp the backup with. Defaults to the wall clock.
 * @returns Absolute path of the backup that was written.
 */
export function backupConfigFile(configPath: string, now: Date = new Date()): string {
  const dir = path.dirname(configPath);
  const base = stamp(now);
  // Millisecond stamps do not collide in practice, but two processes recovering
  // the same file at once is exactly the situation where "in practice" fails,
  // and COPYFILE_EXCL makes the loser rename rather than overwrite a backup that
  // holds somebody's settings.
  for (let attempt = 1; attempt <= CONFIG_BACKUP_COLLISION_LIMIT; attempt++) {
    const name = attempt === 1 ? `config-${base}.json.bak` : `config-${base}-${attempt}.json.bak`;
    const backupPath = path.join(dir, name);
    try {
      fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
      pruneConfigBackups(dir);
      return backupPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  // Bounded rather than endless: this runs during boot, and a search for a free
  // name that never finishes would hang the thing it exists to protect. The
  // caller reads a throw as "stop and change nothing", which is the right answer
  // here too.
  throw new Error(
    `Could not find a free backup name for ${configPath} after ` +
      `${CONFIG_BACKUP_COLLISION_LIMIT} tries.`
  );
}

/**
 * Delete all but the newest {@link CONFIG_BACKUPS_KEPT} timestamped backups.
 *
 * Never throws: a backup that will not delete is a tidiness problem, and the
 * recovery it belongs to has already done the part that matters.
 *
 * @param dir - The directory holding `config.json`.
 */
function pruneConfigBackups(dir: string): void {
  for (const stale of listConfigBackups(dir).slice(CONFIG_BACKUPS_KEPT)) {
    try {
      fs.unlinkSync(stale);
    } catch (error) {
      logger.warn(`[Config] Could not remove the old backup ${stale}`, logError(error));
    }
  }
}
