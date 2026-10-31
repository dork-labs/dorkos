/**
 * The first step of startup: resolve the data directory, start the logger,
 * claim the directory for this process, and clear what a previous run left behind.
 *
 * Moved out of `index.ts` unchanged; it runs at the same point in `start()`.
 *
 * @module startup/steps/data-directory
 */
import { resolveDorkHome } from '../../lib/dork-home.js';
import { env } from '../../env.js';
import { initLogger, logger } from '../../lib/logger.js';
import path from 'path';
import { acquireInstanceLock, isInstanceLockEnabled } from '../../lib/instance-lock.js';
import { SERVER_VERSION } from '../../lib/version.js';
import {
  PREDECESSOR_EXIT_WAIT_MS,
  reapOrphanedWarmProcesses,
} from '../../services/runtimes/claude-code/sessions/warm-process-ledger.js';
import { sharedBackgroundWorkLedger } from '../../services/runtimes/claude-code/messaging/background-work-ledger.js';
import { initMoveStaging } from '../../services/core/cloud/community-move-upload.js';
import type { ServerRefs } from '../server-refs.js';

/** What {@link claimDataDirectory} reads from the startup steps before it. */
export interface ClaimDataDirectoryInput {
  PORT: number;
}

/**
 * Resolve and claim the data directory, then sweep what the last run left in it.
 *
 * @param refs - The server's live references, which shutdown reads.
 * @param built - What the steps before this one built.
 */
export async function claimDataDirectory(refs: ServerRefs, built: ClaimDataDirectoryInput) {
  const { PORT } = built;
  // Resolve data directory once and make it available to all downstream services.
  // Priority: DORK_HOME env var > .temp/.dork (dev) > ~/.dork (production)
  const dorkHome = resolveDorkHome();
  // eslint-disable-next-line no-restricted-syntax -- write (not read): broadcasts resolved dorkHome to services loaded after this point
  process.env.DORK_HOME = dorkHome;
  console.log(`[DorkOS] Data directory: ${dorkHome}`);

  const logLevel = env.DORKOS_LOG_LEVEL;
  initLogger({ level: logLevel, logDir: path.join(dorkHome, 'logs') });

  // One server per data directory (DOR-532). Claimed here, before the database
  // opens and before any reconciler starts, because a second instance sharing
  // this directory would corrupt both. The port check further down catches only
  // the case where both listen on the same port; this catches the rest.
  const lock = acquireInstanceLock({ dorkHome, port: PORT, version: SERVER_VERSION });
  if (!lock.acquired) {
    logger.error(lock.reason);
    // Also to stderr: an operator starting from a terminal must see this even
    // when the logger only writes to the log file.
    console.error(`\n${lock.reason}\n`);
    process.exit(1);
  }
  refs.releaseInstanceLock = lock.release;

  // End the warm agent processes a previous run of THIS data directory left
  // behind (DOR-1310). Deliberately here: after the instance lock, so no live
  // server's processes are in scope, and long before any session can be warmed,
  // so the sweep never races a process this run just spawned. Never fatal — a
  // boot must not fail over a cleanup. Holding the lock means a ledger owner
  // still alive is the server this one replaces, finishing its exit, so the
  // sweep waits for it rather than leaving its processes running (DOR-3049).
  await reapOrphanedWarmProcesses({
    ownerExitWaitMs: isInstanceLockEnabled() ? PREDECESSOR_EXIT_WAIT_MS : 0,
  }).catch((error: unknown) => {
    logger.warn('[DorkOS] could not sweep leftover agent processes', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  // The chats whose agent process was still holding background work when the
  // previous run ended — a graceful restart or a hard kill — each owed a turn
  // (DOR-2065). Read HERE, beside the sweep that just ended those processes and
  // before anything can warm a new one, so a record this run writes is never
  // mistaken for one. Not cleared: each record is removed only once its chat is
  // settled, so a boot that dies midway wakes the rest next time. The wakes go
  // out once the server is listening. A file another data directory wrote (a
  // copy of this one) wakes nothing (DOR-3071).
  const backgroundWorkCutShort = sharedBackgroundWorkLedger().readLeftover();

  // Empty the hosted-community move staging directory. A copy a previous run
  // left behind can never be sent: its upload token died with that process.
  // After the instance lock for the same reason as the sweep above.
  await initMoveStaging(dorkHome).catch((error: unknown) => {
    logger.warn('[DorkOS] could not set up community move staging', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return { dorkHome, logLevel, backgroundWorkCutShort };
}

/** What {@link claimDataDirectory} hands the steps after it. */
export type ClaimDataDirectoryResult = Awaited<ReturnType<typeof claimDataDirectory>>;
