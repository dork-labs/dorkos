/**
 * Stop requests on the run record (spec `turns-survive-restarts` §4.4, §4.7).
 *
 * Every stop asked of a turn is written to its run when it is asked, in its
 * own transaction, before the runtime is asked: a crash between the two must
 * still show that somebody asked, because recovery's rule "a stop by a person
 * or agent: nothing continues" (§7.3) reads it. The receipt is added when it
 * comes. Neither decides the run's ending: a run ends `stopped` only on a
 * `turn_end` that reports the interrupt (§4.4), and an `unconfirmed` stop
 * whose turn then finishes ends as the runtime reports it.
 *
 * The callers are the Stop button's route and a pause, which are not turn
 * code, so they write through `services/runs` (§3.4) until they move to the
 * port's `stop()`.
 *
 * @module services/runs/run-stops
 */
import { InterruptReceiptSchema } from '@dorkos/shared/schemas';
import type { RunStopRequest, RunStore } from './run-store.js';

/**
 * Write a stop request on the chat's turn, if one is running.
 *
 * @param store - The run store.
 * @param chatKey - The chat, by the id its queue rows are kept under.
 * @param request - Who asked, and through which door.
 * @returns The run it was written on, for {@link writeStopReceipt}; `undefined`
 *   when no turn of the chat is `started` or `running`.
 */
export function writeStopRequest(
  store: RunStore,
  chatKey: string,
  request: Pick<RunStopRequest, 'by' | 'via'>
): string | undefined {
  return store.transaction(() => {
    const live = store.liveRunOf(chatKey);
    if (!live || (live.status !== 'started' && live.status !== 'running')) return undefined;
    const stopRequests = [
      ...(live.endingDetail.stopRequests ?? []),
      {
        at: store.stamp(),
        via: request.via,
        ...(request.by !== undefined ? { by: request.by } : {}),
      },
    ];
    store.annotate(live.id, { endingDetail: { ...live.endingDetail, stopRequests } });
    return live.id;
  });
}

/**
 * Add the receipt to the newest stop request on a run that has no receipt yet.
 * An outcome outside the receipt vocabulary (ADR 260823-021312) is not kept.
 *
 * @param store - The run store.
 * @param runId - The run {@link writeStopRequest} wrote on.
 * @param receipt - What the runtime answered.
 */
export function writeStopReceipt(
  store: RunStore,
  runId: string,
  receipt: { outcome: string }
): void {
  const outcome = InterruptReceiptSchema.shape.outcome.safeParse(receipt.outcome);
  if (!outcome.success) return;
  store.transaction(() => {
    const run = store.get(runId);
    const requests = run?.endingDetail.stopRequests;
    if (!run || !requests) return;
    let index = requests.length - 1;
    while (index >= 0 && requests[index]!.outcome !== undefined) index -= 1;
    if (index === -1) return;
    const stopRequests = requests.map((request, i) =>
      i === index ? { ...request, outcome: outcome.data } : request
    );
    store.annotate(run.id, { endingDetail: { ...run.endingDetail, stopRequests } });
  });
}
