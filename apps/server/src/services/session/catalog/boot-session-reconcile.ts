/**
 * The boot reconcile as startup runs it: the installed durable stores, handed
 * to {@link reconcileSessionRows}, with its outcome logged. Split from
 * `startup/steps/rooms.ts` so the exact wiring a boot runs can be driven by a
 * test: a store left out here is a store a boot never reclaims (DOR-4002).
 *
 * @module services/session/catalog/boot-session-reconcile
 */
import { logger } from '../../../lib/logger.js';
import { getMessageQueueStore } from '../message-queue-store.js';
import { getStagedContextStore } from '../staged-context-store.js';
import { getTurnContextStore } from '../turn-context/record-turn-context.js';
import {
  reconcileSessionRows,
  type SessionRowReconcileDeps,
  type SessionRowReconcileReport,
} from './reconcile-session-rows.js';

/** What only the host can answer: who owns each session, and what is on disk. */
export type BootReconcileProbes = Pick<
  SessionRowReconcileDeps,
  'bindingsFor' | 'claudeCodeInventory' | 'bootedAt'
>;

/**
 * Reclaim what sessions that vanished while this server was down left in the
 * durable tables, and log what happened. Never rejects.
 *
 * @param probes - The ownership lookup and the inventory probe.
 * @returns The report, or `null` when the stores are not wired.
 */
export async function runBootSessionReconcile(
  probes: BootReconcileProbes
): Promise<SessionRowReconcileReport | null> {
  const queue = getMessageQueueStore();
  const staged = getStagedContextStore();
  const contextRecords = getTurnContextStore();
  if (!queue || !staged) {
    // Unreachable in this host (both stores are injected right after
    // `createDb()`) and said out loud anyway: a reconcile that silently did not
    // run is the one outcome nobody could tell from nothing to reclaim.
    logger.warn('[SessionRows] skipped the boot reconcile: the durable stores are not wired');
    return null;
  }
  try {
    const report = await reconcileSessionRows({
      queue,
      staged,
      // What a vanished chat's turns were sent goes with it (DOR-4002).
      ...(contextRecords ? { contextRecords } : {}),
      ...probes,
    });
    // Every outcome except the clean, complete, nothing-to-do one: a partial
    // delete and an unreadable inventory both mean rows are still there.
    if (report.reaped > 0 || report.failedDeletes > 0 || !report.inventoryComplete) {
      logger.info('[SessionRows] checked what vanished sessions left behind', { ...report });
    }
    return report;
  } catch (err) {
    logger.warn('[SessionRows] could not check what vanished sessions left behind', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
