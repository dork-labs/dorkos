/**
 * Stop requests on the run record (spec `turns-survive-restarts` §4.4, §4.7).
 *
 * Every stop asked of a turn is written to its run when it is asked, in its
 * own transaction, before the runtime is asked: a crash between the two must
 * still show that somebody asked, because recovery's rule "a stop by a person
 * or agent: nothing continues" (§7.3) reads it. The receipt is added when it
 * comes. A receipt whose outcome is `acked` or `closed` is the proof that the
 * stop ended the turn (§4.4, the rule `RunFactSchema` holds), so it records
 * the ending `stopped` on a run that is `started`, `running` or `ended`; a
 * `turn_end` read later never overwrites it. An `unconfirmed`, `failed` or
 * `not-running` receipt records nothing more: that turn ends as the runtime
 * reports it.
 *
 * **A receipt can land after the turn settled** (the runtime answers the
 * interrupt after the turn's own end). It is still read: the ending is
 * written when the receipt arrives, on a run that is `ended` but not yet
 * `settled`. Holding the settle until a receipt would leave a turn open on a
 * receipt that may never come; an ending written late is one write. Runs
 * reach `settled` only once their follow-ups are done (T4), so from then a
 * receipt that comes after `settled` is kept on the request and changes no
 * ending. A run a pause cut back to `queued` is never `stopped`: the pause's
 * own receipt finds no request left on it.
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
    const confirmed =
      (outcome.data === 'acked' || outcome.data === 'closed') &&
      (run.status === 'started' || run.status === 'running' || run.status === 'ended');
    store.annotate(run.id, {
      endingDetail: { ...run.endingDetail, stopRequests },
      ...(confirmed ? { ending: 'stopped' } : {}),
    });
  });
}
