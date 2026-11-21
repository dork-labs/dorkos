import path from 'node:path';
import log from 'electron-log';
import { resolveDataDirectory } from '../dork-home';

/**
 * The updater's own log, kept apart from `main.log` (DOR-4847).
 *
 * Every updater line used to go to the shared `main.log`, which electron-log
 * rotates at 1 MiB by renaming it over the one `main.old.log` it keeps. A busy
 * day fills that twice, so the lines saying why an update never appeared were
 * gone by the time anyone looked. The updater writes a few lines per check,
 * so a file of its own holds months of them.
 *
 * The file sits beside the server's `dorkos.log` in the data directory's
 * `logs/` folder, the folder people are already pointed at. The server's
 * rotation there only renames and deletes `dorkos*.log` files
 * (`apps/server/src/lib/logger.ts`), so it never touches this one; electron-log
 * rotates this file only by its own size, into `updater.old.log`.
 *
 * @module main/updater/log
 */

/** Name of the updater's log file inside the data directory's `logs/` folder. */
export const UPDATER_LOG_FILE = 'updater.log';

/**
 * Where the updater log lives for a given data directory.
 *
 * @param dataDirectory - The data directory the server child uses.
 * @returns Absolute path to `updater.log`.
 */
export function updaterLogPath(dataDirectory: string): string {
  return path.join(dataDirectory, 'logs', UPDATER_LOG_FILE);
}

/**
 * The logger every updater module writes through, and the one handed to
 * electron-updater as `autoUpdater.logger`.
 *
 * Its file transport is resolved lazily, on the first line written, so
 * importing this module never asks Electron for a path before the app is
 * ready.
 */
export const updaterLog = log.create({ logId: 'updater' });

updaterLog.transports.file.resolvePathFn = () => updaterLogPath(resolveDataDirectory());
