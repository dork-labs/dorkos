/**
 * A started run's turn, read back as the stream of events its caller used to
 * get from a runtime (spec `turns-survive-restarts` §3.1 `watch` and `stop`).
 * A space-side caller that once drove a runtime itself and reads what its turn
 * said (a scheduled task's run, T12; a relay delivery, T13) starts the turn on
 * the space face and reads it here, so it never reaches a runtime.
 *
 * **What the stream holds.** The run's turn events, as its runtime sends them,
 * ending when the run's turn is over. While the run waits for a free slot it
 * says so once, with the server's slot-wait status, so a caller that pauses a
 * time limit while a turn waits (`pauseWhileWaitingToStart`, DOR-4576) does.
 * A run that never started (refused at the door, its start lost) ends the
 * stream with a throw naming why; one taken back by a stop just ends. A turn
 * whose stream broke off throws on the ending the record kept, since what
 * DorkOS closed it with never passed here.
 *
 * @module services/runs/run-turn-stream
 */
import { SLOT_WAIT_STATUS, SLOT_WAIT_TEXT, type InterruptReceipt } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../lib/logger.js';
import type { TurnRun } from './run-store.js';

/** The statuses after which a run never goes back in line, so its words are no longer needed. */
export const RUN_ENDS: ReadonlySet<TurnRun['status']> = new Set([
  'ended',
  'settled',
  'cancelled',
  'superseded',
]);

/** What the watcher reads of the space face (`SpaceTurnPort`). */
export interface RunTurnFace {
  /** One run by id. */
  get(runId: string): TurnRun | undefined;
  /** Hear a run's committed status changes. */
  watch(hear: (run: TurnRun) => void, filter: { runId: string }): () => void;
  /** Hear a run's turn events. */
  watchEvents(runId: string, hear: (event: StreamEvent) => void): () => void;
  /** Stop one run. */
  stop(runId: string, by?: string): Promise<InterruptReceipt | undefined>;
}

/** The server's slot-wait status: what pauses a run's time limit while it waits. */
const SLOT_WAIT_EVENT: StreamEvent = {
  type: 'system_status',
  data: { status: SLOT_WAIT_STATUS, message: SLOT_WAIT_TEXT },
} as StreamEvent;

/** How a caller words a run that never started. */
export interface RunTurnReading {
  /**
   * The sentence a run that never started throws with.
   *
   * @param run - The cancelled run; `endingDetail.cancelledBecause` says why.
   */
  notStarted: (run: TurnRun) => string;
  /** Called once the stream is over, however it ended. */
  onEnd?: () => void;
}

/**
 * A run's turn events until its turn is over. Subscribed at the first read,
 * which a caller makes before the outbox can hand the run over (`start` only
 * saved it), so nothing is missed.
 *
 * @param face - The space face the run was started on.
 * @param runId - The run.
 * @param reading - How a run that never started is worded.
 */
export async function* runTurnEvents(
  face: RunTurnFace,
  runId: string,
  reading: RunTurnReading
): AsyncGenerator<StreamEvent> {
  const waiting: StreamEvent[] = [];
  let over: TurnRun | undefined;
  let wake: (() => void) | undefined;
  let saidWaiting = false;
  let sawDone = false;
  const push = (event: StreamEvent): void => {
    if (event.type === 'done') sawDone = true;
    waiting.push(event);
    wake?.();
  };
  const hear = (run: TurnRun): void => {
    if (run.status === 'queued' && run.waitReason === 'machine_full' && !saidWaiting) {
      saidWaiting = true;
      push(SLOT_WAIT_EVENT);
    }
    if (RUN_ENDS.has(run.status)) {
      over = run;
      wake?.();
    }
  };
  const unwatchEvents = face.watchEvents(runId, push);
  const unwatchRun = face.watch(hear, { runId });
  try {
    const now = face.get(runId);
    if (now) hear(now);
    for (;;) {
      while (waiting.length > 0) yield waiting.shift()!;
      if (over) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
    if (over.status === 'cancelled' && over.endingDetail.cancelledBecause !== 'stopped') {
      throw new Error(reading.notStarted(over));
    }
    if (
      !sawDone &&
      over.ending !== null &&
      over.ending !== 'completed' &&
      over.ending !== 'stopped'
    ) {
      throw new Error(over.endingDetail.refusal ?? `The run’s turn ended early (${over.ending}).`);
    }
  } finally {
    unwatchEvents();
    unwatchRun();
    reading.onEnd?.();
  }
}

/**
 * Stop a run's turn. A run not yet begun is taken back; a launch still under
 * way has no turn to stop yet, so the stop is asked again the moment its run
 * has started. Never rejects: it is called from abort listeners, and a turn
 * that cannot be stopped must not keep its caller from finishing.
 *
 * @param face - The space face the run was started on.
 * @param runId - The run.
 * @param by - Who asked, as a `dork:` reference, when known.
 * @returns The receipt of the first ask, or `undefined` when no turn was running yet.
 */
export async function stopRun(
  face: RunTurnFace,
  runId: string,
  by?: string
): Promise<InterruptReceipt | undefined> {
  const ask = (): Promise<InterruptReceipt | undefined> =>
    face.stop(runId, by).catch((err: unknown) => {
      logger.warn('[runs] a run’s turn could not be stopped', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    });
  const receipt = await ask();
  if (receipt !== undefined) return receipt;
  const run = face.get(runId);
  if (!run || RUN_ENDS.has(run.status)) return undefined;
  const stopOnStart = face.watch(
    (moved) => {
      if (moved.status === 'started' || moved.status === 'running') {
        stopOnStart();
        void ask();
      } else if (RUN_ENDS.has(moved.status)) {
        stopOnStart();
      }
    },
    { runId }
  );
  return undefined;
}
