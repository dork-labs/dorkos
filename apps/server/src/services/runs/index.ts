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
import { EffectStore } from './effects/effect-store.js';
import { writeFollowUpsOfEnded } from './effects/follow-ups.js';
import { effectHandlers, type EffectHandlerDeps } from './effects/handlers/index.js';
import { EffectWorker } from './effects/worker.js';

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

/**
 * How long after a run ends the projector's "finished" status change is still
 * that run's (the two arrive in either order, as `chat-started-turns.ts` says
 * of its own linger).
 */
export const RUN_FINISHED_LINGER_MS = 10_000;

/** The run record and its outbox, as one boot holds them. */
export interface RunRecord {
  store: RunStore;
  effects: EffectStore;
  worker: EffectWorker;
}

let installed: (RunRecord & { renew: ReturnType<typeof setInterval> }) | undefined;

/** What {@link createRunRecord} and {@link installRunRecord} need. */
export interface RunRecordOptions {
  /** This boot's epoch, minted once at startup (§6.1). */
  epoch: string;
  /** The clock, epoch ms. Injected by tests. */
  now?: () => number;
  /**
   * Whether this process holds a run's owner; defaults to the turn code's own
   * record of it (`isRunHeld`).
   */
  ownerHolds?: (runId: string) => boolean;
  /** What the outbox's handlers need from the rest of the server. */
  handlers?: EffectHandlerDeps;
}

/**
 * Build the run record and its outbox over the machine store, with nothing
 * registered or started: every move to `ended` writes its follow-up effects
 * in the same transaction (§6.1) and wakes the worker, which runs the
 * registry's handlers once started.
 *
 * @param db - The machine store.
 * @param opts - This boot's epoch (§6.1), what the handlers need, and in tests the clock.
 */
export function createRunRecord(db: Db, opts: RunRecordOptions): RunRecord {
  const { handlers: handlerDeps, ...storeOpts } = opts;
  const now = opts.now ?? Date.now;
  const effects = new EffectStore(db, { now });
  // Renewed, and kept from retirement, only while this process holds the run.
  const store = new RunStore(db, {
    ownerHolds: isRunHeld,
    ...storeOpts,
    onEnded: (run) => {
      writeFollowUpsOfEnded(effects, run, now());
      // A run with nothing to follow it settles on the worker's next pass.
      effects.announceWork();
    },
  });
  const worker = new EffectWorker({
    effects,
    runs: store,
    handlers: effectHandlers(handlerDeps),
    epoch: opts.epoch,
    now,
  });
  return { store, effects, worker };
}

/**
 * Open the run record and its outbox over the machine store and register the
 * record as the turn code's facts sink. Live runs this boot owns renew their
 * lease every {@link RUN_LEASE_RENEW_MS} from here on. The worker that carries
 * out the follow-ups waits for {@link startRunEffects}.
 *
 * @param db - The machine store.
 * @param opts - This boot's epoch, what the handlers need, and in tests the clock.
 * @returns The store.
 */
export function installRunRecord(db: Db, opts: RunRecordOptions): RunStore {
  uninstallRunRecord();
  const record = createRunRecord(db, opts);
  const { store } = record;
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
  installed = { ...record, renew };
  return store;
}

/**
 * Start the outbox's worker. Called once the server is listening and the
 * notification pipeline exists (`startup/steps/after-listen.ts`), before any
 * chat's queue resumes (§7.3, step 8).
 */
export function startRunEffects(): void {
  installed?.worker.start();
}

/** The installed run record and its outbox, or `undefined` before startup wired them. */
export function getRunRecord(): RunRecord | undefined {
  return installed;
}

/**
 * Whether a chat's turn that just settled to idle is a run's, whose "finished"
 * row its `notify_person` effect writes (§6.2): the chat has a `started` or
 * `running` run, or one that ended in the last {@link RUN_FINISHED_LINGER_MS}.
 * The projector's emitter then leaves the row to the outbox, so the person is
 * told once. Never throws: an unreadable record means "no", and today's row.
 *
 * @param sessionId - The chat, by any id it answers to.
 */
export function runTellsTurnFinished(sessionId: string): boolean {
  const store = installed?.store;
  if (!store) return false;
  try {
    return store.hasTurnLiveOrEndedWithin(chatKeyOf(sessionId), RUN_FINISHED_LINGER_MS);
  } catch (err) {
    logger.warn('[runs] could not read whether a run tells its turn finished', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Unregister the run record, stop the worker and stop renewing leases (test isolation). */
export function uninstallRunRecord(): void {
  if (!installed) return;
  installed.worker.stop();
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
  // No new pass starts; what the endings below write waits for the next boot.
  installed!.worker.stop();
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
