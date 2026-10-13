/**
 * The health timer's canvas sweep, asked only when there is something to sweep.
 *
 * The sweep deletes the canvas of a session a runtime has reported gone for good
 * (spec `canvas-agent-seat` §Data model 6). It needs a session listing to make
 * that call, and the timer used to list every session in the default folder
 * every five minutes whether or not any session had been reported gone, which
 * is nearly always (DOR-2905). Now the listing runs only while a session is
 * marked.
 *
 * @module services/canvas/sweep-orphaned-canvases
 */
import { logger, logError } from '../../lib/logger.js';
import type { CanvasService } from './canvas-service.js';

/** What the sweep needs from a session listing. */
export interface OrphanSweepListing {
  /** The live sessions, with the runtime each belongs to. */
  sessions: readonly { id: string; runtime?: string | undefined }[];
  /** Runtimes that failed to list, whose sessions all look absent. */
  degradedRuntimes: readonly string[];
}

/**
 * Delete the canvas of every session marked gone that the listing confirms is
 * gone, listing sessions only when one is marked.
 *
 * Two-phase, like the message-queue sweep: `noteSessionOrphaned` marks, and this
 * asks a second time before deleting anything, so a session that came back
 * between the two is spared. A runtime that degraded in the listing is skipped,
 * so one flaky sidecar cannot delete every canvas it owns, and a listing that
 * failed outright sweeps nothing.
 *
 * @param canvas - The canvas service, or `undefined` before it exists.
 * @param listSessions - Lists the live sessions; called only when a session is marked.
 * @returns How many documents were deleted.
 */
export async function sweepOrphanedCanvases(
  canvas: Pick<CanvasService, 'orphanMarkCount' | 'sweepOrphanedCanvasDocuments'> | undefined,
  listSessions: () => Promise<OrphanSweepListing>
): Promise<number> {
  if (!canvas || canvas.orphanMarkCount() === 0) return 0;
  try {
    return canvas.sweepOrphanedCanvasDocuments(await listSessions());
  } catch (err) {
    // The listing failed, or the sweep did partway through: either way the
    // case that must delete nothing more. Told rather than assumed: `null` is
    // the sweep's own "I could not ask" input.
    logger.warn('[canvas] could not list sessions for the orphan sweep', logError(err));
    return canvas.sweepOrphanedCanvasDocuments(null);
  }
}
