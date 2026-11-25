/**
 * The run record (spec `turns-survive-restarts` §4, ADR 261124-150517): one
 * small DorkOS-owned row per attempt of a turn, so every device can read what
 * became of it, including after the process that ran it is gone.
 *
 * Space side. Turn code never imports this domain; it reports through the
 * facts sink this module registers at startup
 * (`services/session/turn-port/facts.ts`, §3.1). The space face of the turn
 * port (`start`, `get`, `list`, `watch`) is `turn-port.ts`, reached through
 * {@link turnPort}; a space-side caller starts a turn there and nowhere else.
 *
 * @module services/runs
 */
import type { Db } from '@dorkos/db';
import {
  chatKeyOf,
  getComputerTurnPort,
  isAgentLaunchCapFull,
  isRunHeld,
  queueRowExists,
  setTurnFactsSink,
  type ComputerTurnPort,
} from '../session/turn-port/index.js';
import { logger } from '../../lib/logger.js';
import { createRunFactsSink } from './run-facts-sink.js';
import { RUN_LEASE_RENEW_MS, RunStore, type RunStopRequest } from './run-store.js';
import { writeStopReceipt, writeStopRequest, type StopRequestRef } from './run-stops.js';
import { EffectStore } from './effects/effect-store.js';
import { TurnNotices } from './effects/turn-notices.js';
import type { ChatPlace } from './effects/handlers/notify-person.js';
import { effectHandlers, type EffectHandlerDeps } from './effects/handlers/index.js';
import { EffectWorker } from './effects/worker.js';
import { StartTurns } from './effects/start-turns.js';
import { startTurnHandler, type StartTurnDeps } from './effects/handlers/start-turn.js';
import { admit } from './admission.js';
import { SpaceTurnPort } from './turn-port.js';

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
export {
  RUN_ENDS,
  SpaceTurnPort,
  TurnStartRefusedError,
  type RunWatchFilter,
  type SpaceRefusalReason,
  type WordSource,
} from './turn-port.js';

/** The run record and its outbox, as one boot holds them. */
export interface RunRecord {
  store: RunStore;
  effects: EffectStore;
  worker: EffectWorker;
  /** The runs that owe their person a "finished" notice (§6.2). */
  notices: TurnNotices;
  /** The space face of the turn port (§3.1). */
  port: SpaceTurnPort;
  /** What a run's moves do to its `start_turn` (§6.2). */
  starts: StartTurns;
}

let installed:
  | (RunRecord & {
      renew: ReturnType<typeof setInterval>;
      onResumed?: RunRecordOptions['onResumed'];
      stopResumes?: () => void;
    })
  | undefined;

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
  /** The computer face the `start_turn` handler calls; defaults to the one startup wired. */
  computer?: () => ComputerTurnPort | undefined;
  /** Mesh's answer for an agent's home, read at call time; absent until Mesh runs. */
  agentHome?: () => ((agentId: string) => string | undefined) | undefined;
  /**
   * Admission's sources (startup passes the pause service's answer) and, in
   * tests, admission itself (§3.5).
   */
  admission?: Partial<Pick<StartTurnDeps, 'admission' | 'admit'>>;
  /** A lifted pause, heard so the runs it held go at once (`AgentPauseService.onResumed`). */
  onResumed?: (listener: () => void) => () => void;
}

/**
 * Build the run record and its outbox over the machine store, with nothing
 * registered or started. Every move to `ended` wakes the worker, which runs
 * the registry's handlers once started and settles the run.
 *
 * @param db - The machine store.
 * @param opts - This boot's epoch (§6.1), what the handlers need, and in tests the clock.
 */
export function createRunRecord(db: Db, opts: RunRecordOptions): RunRecord {
  const {
    handlers: handlerDeps,
    computer,
    agentHome,
    admission,
    onResumed: _onResumed,
    ...storeOpts
  } = opts;
  const now = opts.now ?? Date.now;
  const effects = new EffectStore(db, { now });
  // Renewed, and kept from retirement, only while this process holds the run.
  const store = new RunStore(db, {
    ownerHolds: isRunHeld,
    ...storeOpts,
    // A run with nothing to follow it settles on the worker's next pass.
    onEnded: () => effects.announceWork(),
    // Its `start_turn` settles, goes back to `pending`, or wakes the waiting.
    // Read at call time: nothing moves a run before the record is built.
    onMoved: (run, from) => starts.onRunMoved(run, from),
  });
  // A pause the record is not told of still refuses at the door (`AGENT_PAUSED`).
  const admissionSources = admission?.admission ?? {
    pausedAgent: () => undefined,
    machineFull: isAgentLaunchCapFull,
  };
  const admitRun = admission?.admit ?? admit;
  const port: SpaceTurnPort = new SpaceTurnPort({
    runs: store,
    effects,
    ...(agentHome ? { agentHome } : {}),
    computer: computer ?? getComputerTurnPort,
    queueRowExists,
    starts: (): StartTurns => starts,
    pausedAgent: (agentId, cwd) => admissionSources.pausedAgent(agentId, cwd),
    preview: (run, start) => {
      if (run.origin === null) return undefined;
      const verdict = admitRun({ ...run, origin: run.origin }, start, {
        runs: store,
        ...admissionSources,
      });
      return 'wait' in verdict ? verdict.wait : undefined;
    },
  });
  const starts: StartTurns = new StartTurns(store, effects, () => port, now);
  const worker = new EffectWorker({
    effects,
    runs: store,
    handlers: {
      ...effectHandlers(handlerDeps),
      start_turn: startTurnHandler({
        runs: store,
        starts,
        port,
        computer: computer ?? getComputerTurnPort,
        queueRowExists,
        admission: admissionSources,
        admit: admitRun,
      }),
    },
    epoch: opts.epoch,
    now,
  });
  return {
    store,
    effects,
    worker,
    notices: new TurnNotices(store, effects, now),
    port,
    starts,
  };
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
  setTurnFactsSink(createRunFactsSink(store, record.notices, record.starts));
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
  installed = { ...record, renew, ...(opts.onResumed ? { onResumed: opts.onResumed } : {}) };
  return store;
}

/**
 * Start the outbox's worker. Called once the server is listening and the
 * notification pipeline exists (`startup/steps/after-listen.ts`), before any
 * chat's queue resumes (§7.3, step 8).
 */
export function startRunEffects(): void {
  if (!installed) return;
  installed.worker.start();
  // A lifted pause lets the runs it held go now, not at their next backoff (§3.5).
  installed.stopResumes ??= installed.onResumed?.(() => installed?.effects.wakeAllStarts());
}

/** The space face of the turn port, or `undefined` before startup wired the run record. */
export function turnPort(): SpaceTurnPort | undefined {
  return installed?.port;
}

/** The installed run record and its outbox, or `undefined` before startup wired them. */
export function getRunRecord(): RunRecord | undefined {
  return installed;
}

/**
 * The projector's emitter found a turn finished and worth telling (§6.2):
 * when the turn is a run's, the run's `notify_person` effect tells it, and
 * this answers `true` so the emitter writes nothing. A turn with no run (a
 * task's or a relay's, until T12 and T13), or a boot whose worker never
 * started, answers `false`, and the emitter tells it as before. Never throws.
 *
 * @param sessionId - The chat, by any id it answers to.
 * @param turnRef - The turn, by its `turn_start` seq, as the status change carries it.
 * @param place - The chat's folder and agent as the emitter knows them: the row's name and agent.
 */
export function claimTurnFinished(
  sessionId: string,
  turnRef: number | undefined,
  place: ChatPlace = {}
): boolean {
  if (!installed?.worker.isRunning || turnRef === undefined) return false;
  try {
    return installed.notices.claim(sessionId, turnRef, place);
  } catch (err) {
    logger.warn('[runs] could not hand a finished turn to its run', {
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
  installed.stopResumes?.();
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
 * line. A turn past its `turn_end` that still owes its person a "finished"
 * gets it in the same write. Then stops renewing leases.
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
        // Its `turn_end` was seen: it finished, so a "finished" it still owes
        // is saved with its end, for the next boot to tell (§6.2).
        if (run.ending !== null) installed!.notices.atSettle(store.get(run.id)!);
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
