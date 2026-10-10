/**
 * The process's answer to SIGINT and SIGTERM: shut down gracefully once, and
 * exit at once on a second signal.
 *
 * A second signal used to be swallowed, so whoever sent it (a person pressing
 * Ctrl+C again, a supervisor whose grace ran out) had no way to hurry a
 * shutdown that was taking too long short of SIGKILL. Now the first signal
 * starts the graceful shutdown and the second ends the process.
 *
 * @module lib/shutdown-signal
 */
import { logger } from './logger.js';

/** What {@link createSignalShutdown} touches, injectable for tests. */
export interface SignalShutdownDeps {
  /** Ends the process. Defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/**
 * Build the signal handler.
 *
 * @param shutdownServices - The graceful shutdown; awaited, then the process exits 0.
 * @param deps - Seams for tests.
 * @returns The handler to register for SIGINT and SIGTERM.
 */
export function createSignalShutdown(
  shutdownServices: () => Promise<void>,
  deps: SignalShutdownDeps = {}
): () => Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;
  return async () => {
    if (shuttingDown) {
      logger.warn('[DorkOS] Second shutdown signal; exiting now');
      exit(1);
      return;
    }
    shuttingDown = true;
    logger.info('[DorkOS] shutting down');
    await shutdownServices();
    exit(0);
  };
}
