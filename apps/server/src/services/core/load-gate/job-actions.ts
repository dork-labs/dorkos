/**
 * A person's three actions on one waiting heavy job (DOR-4209): let it through
 * now, mark it urgent, or move it to the front of the line. Each one writes a
 * mark beside the ticket in the shared folder ({@link TicketQueue}); the job's
 * own wait sees the mark on its next check.
 *
 * Only the person's routes call these (`routes/system-load-gate.ts`). Who did
 * it is recorded there, in the audit trail, because any program running as
 * this user could write the same mark by hand.
 *
 * @module services/core/load-gate/job-actions
 */
import { isTicketId, type TicketQueue } from './ticket-queue.js';

/**
 * How one action came out: done, an id that cannot be a ticket's, no waiting
 * job with that id (it started, or its owner left), or the shared folder could
 * not be used.
 */
export type JobActionResult = 'ok' | 'invalid-id' | 'not-found' | 'unavailable';

/** A person's actions on one waiting job, by its ticket id. */
export interface LoadGateJobActions {
  /**
   * Let the job run now, past the load limit and the slot count.
   *
   * @param id - The job's ticket id.
   */
  letThrough(id: string): JobActionResult;
  /**
   * Move the job ahead of every normal one.
   *
   * @param id - The job's ticket id.
   */
  markUrgent(id: string): JobActionResult;
  /**
   * Move the job to the front of the line, ahead of urgent ones too.
   *
   * @param id - The job's ticket id.
   */
  moveToFront(id: string): JobActionResult;
}

/**
 * The actions over one queue.
 *
 * @param openQueue - Opens the shared queue, or throws when its folder cannot be used.
 */
export function createJobActions(openQueue: () => TicketQueue): LoadGateJobActions {
  const run =
    (mark: (queue: TicketQueue, id: string) => boolean) =>
    (id: string): JobActionResult => {
      // Checked before anything names a file, so an id from outside can only ever name a mark.
      if (!isTicketId(id)) return 'invalid-id';
      try {
        return mark(openQueue(), id) ? 'ok' : 'not-found';
      } catch {
        return 'unavailable';
      }
    };
  return {
    letThrough: run((queue, id) => queue.markLetThrough(id)),
    markUrgent: run((queue, id) => queue.markUrgent(id)),
    moveToFront: run((queue, id) => queue.markFront(id)),
  };
}
