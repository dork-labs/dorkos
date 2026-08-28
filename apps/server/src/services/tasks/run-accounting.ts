/**
 * Which runs this process is currently accountable for (DOR-1482).
 *
 * ## Why this is not just a map of AbortControllers
 *
 * A task run leaves this process by one of two doors. A DIRECT run is executed
 * here, by `AgentManager`, and is held by an `AbortController` this process can
 * pull. A RELAY run is published onto the message bus and executed inside an
 * adapter, so this process holds no handle on it at all.
 *
 * The scheduler used to record only the first kind. Everything that counts runs
 * — the `maxConcurrentRuns` cap, `getActiveRunCount()`, the shutdown drain —
 * read that map, so with the relay enabled they all read zero: the cap never
 * tripped no matter how many runs were in flight, the count in the UI was a
 * flat lie, and a shutdown drained nothing.
 *
 * This registry holds both kinds under one count, which is what makes the cap
 * mean the same thing on either path, and keeps the two facts a caller needs —
 * "how many runs are live?" and "can I abort this one myself?" — from drifting
 * apart.
 *
 * ## How a relay slot is given back
 *
 * A direct run releases its slot in its own `finally`. A relay run has no such
 * moment here: it ends somewhere else, and the only thing that observes the
 * ending is the run row going terminal. So a relay entry is reaped on READ —
 * every count re-reads the rows it is holding and drops the ones that have
 * finished (or vanished).
 *
 * Reading rather than subscribing is deliberate. `TaskStore` holds a SINGLE
 * run-terminal listener, and `index.ts` owns it (the attention broadcast and the
 * run-completed notification are composed into it), so a scheduler that wanted
 * to be told would have to either clobber that listener or grow the store a
 * listener registry. Re-reading at most `maxConcurrentRuns` rows, only when
 * somebody asks for the count, costs less than either.
 *
 * A relay run also carries a deadline, because "the row went terminal" is not
 * guaranteed to ever happen: if the runner dies, nothing finalizes the row and
 * an unreaped entry would hold a cap slot for the life of the process. The
 * deadline is the run's own `maxRuntime` plus a margin — past it, whoever was
 * executing the run has either finished it or is gone.
 *
 * @module services/tasks/run-accounting
 */
import { isTerminalRunStatus, type TaskStore } from './task-store.js';
import { createTaggedLogger } from '../../lib/logger.js';

const logger = createTaggedLogger('Tasks');

/**
 * How long past a relay run's own `maxRuntime` its slot is held before this
 * process stops waiting for a terminal row that is not coming. Generous: the
 * runner is entitled to the whole deadline plus the time it takes to write the
 * ending.
 */
const RELAY_SLOT_GRACE_MS = 60_000;

/**
 * How long a relay run with no `maxRuntime` of its own holds a slot. A task
 * without a deadline is not a run without an end, and the alternative — holding
 * the slot forever — silently shrinks the cap every time a runner dies.
 */
const RELAY_SLOT_DEFAULT_TTL_MS = 60 * 60 * 1000;

/** One run this process is accountable for. */
type ActiveRun =
  | {
      kind: 'direct';
      /** How this process ends the run. Only a direct run has one. */
      controller: AbortController;
    }
  | {
      kind: 'relay';
      /** Epoch ms after which this slot is given back unconditionally. */
      expiresAt: number;
    };

/** The live runs of one scheduler, across both dispatch paths. */
export class RunAccounting {
  private runs = new Map<string, ActiveRun>();

  /**
   * Build an empty registry.
   *
   * @param store - Read-only here; used to ask whether a relay run has ended.
   */
  constructor(private readonly store: Pick<TaskStore, 'getRun'>) {}

  /**
   * Record a run this process is executing itself.
   *
   * @param runId - The run.
   * @param controller - Aborting it ends the turn.
   */
  addDirect(runId: string, controller: AbortController): void {
    this.runs.set(runId, { kind: 'direct', controller });
  }

  /**
   * Record a run this process has handed to the relay.
   *
   * Called at DISPATCH rather than after a successful publish, so a run counts
   * against the cap for the whole time it is in flight — including the window
   * in which in-process delivery runs the entire turn inside `publish()`.
   *
   * @param runId - The run.
   * @param maxRuntimeMs - The task's own deadline, when it has one.
   */
  addRelay(runId: string, maxRuntimeMs?: number | null): void {
    const ttl = maxRuntimeMs ? maxRuntimeMs + RELAY_SLOT_GRACE_MS : RELAY_SLOT_DEFAULT_TTL_MS;
    this.runs.set(runId, { kind: 'relay', expiresAt: Date.now() + ttl });
  }

  /** Give back a run's slot. */
  release(runId: string): void {
    this.runs.delete(runId);
  }

  /**
   * How many runs are live right now, on either path — the number the
   * concurrency cap is compared against.
   *
   * Reaps finished relay runs first, so this is never stale in the direction
   * that matters (a slot held by a run that already ended).
   */
  count(): number {
    this.reapRelayRuns();
    return this.runs.size;
  }

  /** How many runs this process is executing itself (the shutdown drain reads this). */
  directCount(): number {
    let n = 0;
    for (const run of this.runs.values()) if (run.kind === 'direct') n++;
    return n;
  }

  /**
   * The abort handle for a run this process is executing, or undefined when the
   * run is somebody else's to stop.
   *
   * @param runId - The run to stop.
   */
  directController(runId: string): AbortController | undefined {
    const run = this.runs.get(runId);
    return run?.kind === 'direct' ? run.controller : undefined;
  }

  /** Every relay-dispatched run still held, newest state as recorded. */
  relayRunIds(): string[] {
    this.reapRelayRuns();
    return [...this.runs.entries()].filter(([, run]) => run.kind === 'relay').map(([id]) => id);
  }

  /**
   * Every run this process is accountable for right now, on either path.
   *
   * Read by crash recovery, which must never end a run THIS process is still
   * working on — the one case where "is anybody still running this?" has a
   * definite local answer instead of a judgement about ownership.
   */
  heldRunIds(): ReadonlySet<string> {
    this.reapRelayRuns();
    return new Set(this.runs.keys());
  }

  /**
   * Abort every run this process is executing itself.
   *
   * @param reason - Passed to `AbortController.abort`, so finalization can tell
   *   a shutdown apart from an operator's cancel.
   */
  abortDirect(reason?: unknown): void {
    for (const run of this.runs.values()) {
      if (run.kind === 'direct') run.controller.abort(reason);
    }
  }

  /** Forget every relay run, without claiming anything about how it ended. */
  forgetRelayRuns(): void {
    for (const [id, run] of this.runs) {
      if (run.kind === 'relay') this.runs.delete(id);
    }
  }

  /**
   * Drop relay entries whose run has ended, gone, or outlived its deadline.
   *
   * The row is the authority: a run finalized by the receiver — completed,
   * failed or cancelled — is no longer occupying anything here, whichever
   * process wrote that ending.
   */
  private reapRelayRuns(): void {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      if (run.kind !== 'relay') continue;
      const row = this.store.getRun(id);
      if (!row || isTerminalRunStatus(row.status)) {
        this.runs.delete(id);
        continue;
      }
      if (now >= run.expiresAt) {
        // Deliberately does NOT touch the row: this process does not know that
        // the run failed, only that it has stopped waiting for it. The row is
        // left for whoever owns it, and for the crash sweep on the next boot.
        logger.warn(
          `run ${id} was dispatched over the relay and has not reported an ending — ` +
            "releasing its slot; the run itself is the runner's to finish"
        );
        this.runs.delete(id);
      }
    }
  }
}
