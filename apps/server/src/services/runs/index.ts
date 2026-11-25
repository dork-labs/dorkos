/**
 * The run record (spec `turns-survive-restarts` §4, ADR 261124-150517): one
 * small DorkOS-owned row per attempt of a turn, so every device can read what
 * became of it, including after the process that ran it is gone.
 *
 * Space side. Turn code never imports this domain; it reports through the
 * facts sink this module registers at startup
 * (`services/session/turn-port/facts.ts`, §3.1). The space face of the turn
 * port (`start`, `stop`, `get`, `list`) lands here with T5.
 *
 * @module services/runs
 */
import type { Db } from '@dorkos/db';
import { chatKeyOf, isRunHeld, setTurnFactsSink } from '../session/turn-port/index.js';
import { logger } from '../../lib/logger.js';
import { createRunFactsSink } from './run-facts-sink.js';
import { RUN_LEASE_RENEW_MS, RunStore, type RunStopRequest } from './run-store.js';
import { writeStopReceipt, writeStopRequest, type StopRequestRef } from './run-stops.js';

export {
  IllegalRunTransitionError,
  RunStore,
  RUN_LEASE_MS,
  RUN_LEASE_RENEW_MS,
  type RunEndingDetail,
  type RunStopRequest,
  type TurnRun,
} from './run-store.js';
export { createRunFactsSink } from './run-facts-sink.js';
export type { StopRequestRef } from './run-stops.js';

let installed: { store: RunStore; renew: ReturnType<typeof setInterval> } | undefined;

/**
 * Open the run record over the machine store and register it as the turn
 * code's facts sink. Live runs this boot owns renew their lease every
 * {@link RUN_LEASE_RENEW_MS} from here on.
 *
 * @param db - The machine store.
 * @param opts.epoch - This boot's epoch, minted once at startup (§6.1).
 * @param opts.now - The clock, in tests.
 * @param opts.ownerHolds - Whether this process holds a run's owner; defaults
 *   to the turn code's own record of it (`isRunHeld`).
 * @returns The store.
 */
export function installRunRecord(
  db: Db,
  opts: { epoch: string; now?: () => number; ownerHolds?: (runId: string) => boolean }
): RunStore {
  uninstallRunRecord();
  // Renewed, and kept from retirement, only while this process holds the run.
  const store = new RunStore(db, { ownerHolds: isRunHeld, ...opts });
  setTurnFactsSink(createRunFactsSink(store));
  const renew = setInterval(() => {
    try {
      store.renewLeases();
    } catch (err) {
      logger.warn('[runs] could not renew run leases', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, RUN_LEASE_RENEW_MS);
  renew.unref?.();
  installed = { store, renew };
  return store;
}

/** Unregister the run record and stop renewing leases (shutdown, and test isolation). */
export function uninstallRunRecord(): void {
  if (!installed) return;
  clearInterval(installed.renew);
  setTurnFactsSink(undefined);
  installed = undefined;
}

/**
 * Write a stop request on a chat's running turn, before the runtime is asked
 * (§4.4). Never throws: a record that cannot be written must not stop a Stop.
 *
 * @param sessionId - The chat, by any id it answers to.
 * @param request - Who asked, and through which door.
 * @returns The request as written, for {@link recordStopReceipt}.
 */
export function recordStopRequest(
  sessionId: string,
  request: Pick<RunStopRequest, 'by' | 'via'>
): StopRequestRef | undefined {
  const store = installed?.store;
  if (!store) return undefined;
  try {
    return writeStopRequest(store, chatKeyOf(sessionId), request);
  } catch (err) {
    logger.warn('[runs] could not record a stop request', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/**
 * Add a stop's receipt to the request {@link recordStopRequest} wrote.
 *
 * @param request - The request {@link recordStopRequest} wrote; nothing happens for `undefined`.
 * @param receipt - What the runtime answered.
 */
export function recordStopReceipt(
  request: StopRequestRef | undefined,
  receipt: { outcome: string }
): void {
  const store = installed?.store;
  if (!store || request === undefined) return;
  try {
    writeStopReceipt(store, request, receipt);
  } catch (err) {
    logger.warn('[runs] could not record a stop receipt', {
      runId: request.runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A graceful shutdown: end every turn this boot is running with the ending
 * `shutdown` (§4.4), while SQLite is still open. A turn whose `turn_end` was
 * already seen keeps the ending it recorded, so a turn that finished and was
 * draining background work does not read as cut short. A run still `starting`
 * is left: its runtime never saw its words, and the next boot puts it back in
 * line. Then stops renewing leases.
 *
 * @returns How many runs it ended.
 */
export function markRunsShutdown(): number {
  const store = installed?.store;
  if (!store) return 0;
  let ended = 0;
  try {
    store.transaction(() => {
      for (const run of store.ownTurnsRunning()) {
        store.endTurn(run, 'shutdown');
        ended += 1;
      }
    });
  } catch (err) {
    logger.warn('[runs] could not record the shutdown on running turns', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  clearInterval(installed!.renew);
  return ended;
}
