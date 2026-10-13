/**
 * Opening the `conf` store at boot, riding out a failure that is not the
 * file's fault and refusing to touch a file it could not read. Split out of
 * `config-manager.ts` (Hard Rule 9), whose constructor calls it.
 *
 * @module services/core/config/load-store
 */
import Conf from 'conf';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { logError, logger } from '../../../lib/logger.js';
import {
  ConfigMigrationFailedError,
  ConfigUnreadableError,
  formatConfigLoadError,
} from './boot-errors.js';
import { cacheStoreReads } from './cached-store-reads.js';
import { classifyConfigLoadFailure } from './load-failure.js';
import { sleepSync } from './salvage-read.js';

/** The exact options object both `Conf` constructions are built from. */
export type ConfConstructorOptions = ConstructorParameters<typeof Conf<UserConfig>>[0];

/**
 * Open the `conf` store, riding out a failure that is not the file's fault.
 *
 * Three outcomes, and they are deliberately not the same shape:
 *
 * 1. It opened — the store comes back.
 * 2. The file is condemned — the error comes back so the caller can back it up,
 *    salvage what protects the person, and start a fresh one. Either the
 *    failure was `corrupt` outright, or it was `unknown` and survived the whole
 *    staircase, which makes it deterministic and therefore about the file.
 * 3. The OS refused the file (`io`) — retried on a short backoff, then thrown.
 *    **The file is never touched on this path, however long the failure
 *    lasts.** Losing the ability to read a file is not evidence that the file
 *    is bad, and the person's settings are sitting in it, intact.
 * 4. A migration body threw (`migration`) — thrown straight away, with the file
 *    untouched. Not retried, because DorkOS's own code failing is deterministic
 *    and a staircase would only delay the same answer.
 *
 * @param options - Constructor options, shared with the recovery construction.
 * @param configPath - Absolute path of the config file, for logs.
 * @param retryDelaysMs - Backoff between attempts; its length is the retry count.
 * @param backupPath - Where the old settings already went, when this call is
 *   the second leg of corrupt-recovery. Only changes what an error says.
 * @returns The opened store, or the error that condemned the file.
 * @throws {ConfigUnreadableError} When every attempt was refused by the OS.
 * @throws {ConfigMigrationFailedError} When a migration body threw.
 */
export function loadConfigStore(
  options: ConfConstructorOptions,
  configPath: string,
  retryDelaysMs: readonly number[],
  backupPath?: string
): { store: Conf<UserConfig> } | { corruptedBy: Error } {
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      return { store: cacheStoreReads(new Conf<UserConfig>(options)) };
    } catch (error) {
      lastError = error;
      const kind = classifyConfigLoadFailure(error);
      const condemn = (): { corruptedBy: Error } => ({
        corruptedBy: error instanceof Error ? error : new Error(String(error)),
      });
      if (kind === 'corrupt') return condemn();
      if (kind === 'migration') {
        logger.error(
          `[Config] A migration failed while updating ${configPath}. ` +
            `Leaving the file exactly as it is.`,
          logError(error)
        );
        throw new ConfigMigrationFailedError(configPath, error);
      }
      const delay = retryDelaysMs[attempt];
      if (delay === undefined) {
        // The staircase is spent. An `io` failure still says nothing about the
        // contents, so it is reported and the file survives. An `unknown` one
        // has now failed identically across ~750ms, which is what a
        // file-caused failure looks like and a transient one does not: condemn
        // it, so a config `conf` can never open again gets recovered instead of
        // blocking every boot from here on.
        if (kind === 'unknown') {
          logger.warn(
            `[Config] ${configPath} failed to open the same way on every attempt: ` +
              `${formatConfigLoadError(error)}. Treating it as damaged.`
          );
          return condemn();
        }
        break;
      }
      logger.warn(
        `[Config] Could not read ${configPath}: ${formatConfigLoadError(error)}. ` +
          `Leaving the file alone and retrying in ${delay}ms.`
      );
      sleepSync(delay);
    }
  }
  logger.error(`[Config] Gave up reading ${configPath} without modifying it`, logError(lastError));
  throw new ConfigUnreadableError(configPath, lastError, backupPath);
}
