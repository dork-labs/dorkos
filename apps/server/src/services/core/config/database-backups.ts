/**
 * The copies of this computer's DorkOS database in `<dorkHome>/backups`, as Settings → Backups
 * (`routes/config-backups.ts`, DOR-4253) lists, removes and moves them. `@dorkos/db`'s
 * `backup-copies` decides which names a writer produced and re-checks the file right before it
 * acts; this module says where the folder is and where a Move may write. The route only decides
 * who may ask (DOR-4923).
 *
 * @module services/core/config/database-backups
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  listBackupCopies,
  moveOlderBackupCopy,
  removeOlderBackupCopy,
  type BackupMoveRefusal,
} from '@dorkos/db';
import { getBoundary, isContained } from '../../../lib/boundary.js';
import { resolveDorkHome } from '../../../lib/dork-home.js';

export type { BackupMoveRefusal };

/** Why a Move's destination was refused before the copy, as a code the route answers. */
export type DestinationRefusal =
  'destination_invalid' | 'destination_outside' | 'destination_in_data_folder';

/** Where the backup copies live; read per request so a test's data folder applies. */
export function backupsDir(): string {
  return path.join(resolveDorkHome(), 'backups');
}

/** Every backup copy, newest first, their total size, and the folder they are in. */
export function listDatabaseBackups() {
  const folder = backupsDir();
  return { folder, ...listBackupCopies(folder) };
}

/**
 * Remove one older copy by its file name.
 *
 * @param name - The copy's file name, already checked for shape.
 */
export function removeOlderDatabaseBackup(name: string) {
  return removeOlderBackupCopy(backupsDir(), name);
}

/**
 * Copy one older backup to `folder`, check it, then remove the original.
 *
 * @param name - The copy's file name, already checked for shape.
 * @param folder - A destination {@link resolveBackupDestination} allowed.
 */
export function moveOlderDatabaseBackup(name: string, folder: string) {
  return moveOlderBackupCopy(backupsDir(), name, folder);
}

/** Whether `child` is strictly below `parent` (both already real paths). */
function strictlyInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Where a Move may write, decided once on the destination's real path, so a
 * link is followed exactly once and every check reads the folder that will be
 * written to. Allowed: an existing folder inside the directory boundary, or on
 * an external drive (`<volumesRoot>/<drive>/…`, which is what Security chose
 * for backups). Never the data folder or anything in it, wherever the path
 * that named it lives: that would only rename the copy to where retention
 * can't see it.
 *
 * @param asked - The folder the person named, `~` already expanded.
 * @param volumesRoot - Where external drives are mounted.
 * @returns The real folder, or why it is refused.
 */
export function resolveBackupDestination(
  asked: string,
  volumesRoot: string
): { folder: string } | { refused: DestinationRefusal } {
  const decided = decideDestination(asked, volumesRoot);
  // A real folder is always absolute; a refusal code never is.
  return path.isAbsolute(decided)
    ? { folder: decided }
    : { refused: decided as DestinationRefusal };
}

/** {@link resolveBackupDestination}'s decision: a real absolute folder, or a refusal code. */
function decideDestination(asked: string, volumesRoot: string): string {
  let real: string;
  try {
    real = fs.realpathSync.native(asked);
    if (!fs.statSync(real).isDirectory()) return 'destination_invalid';
  } catch {
    return 'destination_invalid';
  }
  let home: string;
  try {
    home = fs.realpathSync.native(resolveDorkHome());
  } catch {
    // No data folder to compare with: refuse rather than guess.
    return 'destination_in_data_folder';
  }
  if (real === home || strictlyInside(real, home)) return 'destination_in_data_folder';
  if (isContained(real, getBoundary())) return real;
  let volumes: string | undefined;
  try {
    volumes = fs.realpathSync.native(volumesRoot);
  } catch {
    volumes = undefined;
  }
  return volumes !== undefined && strictlyInside(real, volumes) ? real : 'destination_outside';
}
