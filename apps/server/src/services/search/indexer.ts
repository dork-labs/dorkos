/**
 * The message-search reconciler: a startup sweep, then one every five minutes
 * (message-search spec §5, ADR 260728-214214).
 *
 * The fourth periodic sweep in a process that already runs three, and it
 * inherits ADR-0043's accepted trade-off deliberately: up to five minutes of
 * staleness in a cache that is derived, disposable, and rebuilt in seconds.
 *
 * @module server/services/search/indexer
 */
import type { Db } from '@dorkos/db';
import { logger } from '../../lib/logger.js';
import { sweepFileSource } from './jsonl-frontier.js';
import { sweepRowSource } from './row-frontier.js';
import { sweepSnapshotSource } from './snapshot-frontier.js';
import type { SearchSource, SourceFailure } from './types.js';

/**
 * How often the index catches up, in milliseconds.
 *
 * Five minutes, matching the three reconcilers that already exist
 * (`mesh-core.ts`, `task-reconciler.ts`, `workspace-reconciler.ts`). A test
 * imports this constant, so shortening it to five seconds is a red test rather
 * than a silent change in how hard this process works.
 */
export const SEARCH_RECONCILE_INTERVAL_MS = 300_000;

/**
 * The `originKey` a failure carries when a whole source threw before its
 * mechanism could attribute the error to anything.
 *
 * Every mechanism catches per container, and every mechanism also catches its
 * own discovery — one that rejects, a snapshot that will not open, a container
 * list that will not read. What is left for this backstop is a throw belonging
 * to no container at all: the prune, or the one statement that stamps the
 * attempt across the source. It exists so that one source's bad day cannot stop
 * the sources swept after it.
 */
export const SOURCE_FAILURE_KEY = '(source)';

/** What one sweep across every source did. */
export interface SweepResult {
  /** Containers discovered across all sources. */
  containers: number;

  /** Message rows written. Zero when nothing was said since the last sweep. */
  indexed: number;

  /**
   * Rows a projection read and could not make a message out of.
   *
   * Non-zero means a source's on-disk shape has drifted from what its projection
   * expects. It is not an error — the container still indexes everything else —
   * but it is the only thing that distinguishes a drifted format from a quiet
   * source, so it is logged rather than swallowed.
   */
  skipped: number;

  /** Containers that no longer exist and were dropped from the index. */
  pruned: number;

  /** Containers re-read whole because their ordinals were renumbered. */
  rebuilt: number;

  /**
   * Every container that failed, and why.
   *
   * A sweep with failures still resolves. A source whose projection an upstream
   * format change has broken contributes zero rows and one recorded error; it
   * never fails the sweep, and it never silently looks like a source with
   * nothing new.
   */
  failures: SourceFailure[];
}

/**
 * Keeps the message-search index caught up with the sources it derives from.
 *
 * Owns no data. Every row it writes can be deleted and rebuilt, and deleting the
 * whole index is a supported recovery rather than data loss — the sweep after a
 * `DELETE FROM messages; DELETE FROM search_sources;` reproduces exactly what
 * incremental indexing would have left behind.
 */
export class SearchIndexer {
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Set for the duration of one {@link SearchIndexer.sweep} pass; see {@link runSweep}. */
  private sweepInFlight = false;

  /**
   * Whether the current skip streak has already logged.
   *
   * A pass stuck well past the interval fires many ticks while it runs; without
   * this, each one would log, and the log line meant to say "overlap was
   * avoided" would instead read as "the sweep is on fire".
   */
  private skippedTickLogged = false;

  /**
   * Build an indexer over a database and a set of sources.
   *
   * @param db - The database, opened through `createDb` so `recursive_triggers`
   *   is on.
   * @param sources - Which sources to sweep. **Required, with no default**
   *   (DOR-1551). It used to default to the whole registry, which made "sweep
   *   the operator's real transcripts" the thing that happened when a caller
   *   said nothing — and the browser suite's servers were exactly such callers.
   *   The set a run may read is now a decision somebody makes out loud:
   *   `selectSearchSources()` at boot, one named source in a test.
   * @param intervalMs - Sweep cadence. Defaults to
   *   {@link SEARCH_RECONCILE_INTERVAL_MS}.
   */
  constructor(
    private readonly db: Db,
    private readonly sources: readonly SearchSource[],
    private readonly intervalMs: number = SEARCH_RECONCILE_INTERVAL_MS
  ) {}

  /**
   * Sweep once now, then every {@link SearchIndexer.intervalMs}.
   *
   * The startup sweep is not awaited: an index that is a few hundred
   * milliseconds behind is the normal state of this cache, and boot should not
   * wait on a cache.
   *
   * **Not awaiting it is only half of not waiting for it.** `better-sqlite3` is
   * synchronous, so a row source's whole pass used to run to completion inside
   * this call whatever the caller did with the promise — boot blocked on the
   * work rather than on the await. What makes the claim true end to end is the
   * yield every sweep takes between containers (`frontier-store.ts`), which is
   * why this returns after the first container rather than after the last
   * (DOR-702).
   *
   * The timer is `unref`'d so it never holds the process open — **optionally**,
   * because not every host's `setInterval` is Node's. In an Electron renderer
   * with node integration the global is Blink's, which returns a plain number
   * with no `unref` on it, and an unguarded call throws a `TypeError` out of
   * `start()`. Matching `task-scheduler-service.ts` and
   * `agent-mcp-token-refresher.ts`, which guard for the same reason. A host with
   * no `unref` also has no process to hold open.
   */
  start(): void {
    if (this.timer) return;
    this.runSweep();
    this.timer = setInterval(() => this.runSweep(), this.intervalMs);
    this.timer.unref?.();
  }

  /**
   * Stop sweeping.
   *
   * **It stops the timer, not the sweep already running.** A sweep now yields
   * between containers, so one can be mid-pass when this is called — an admin
   * reset closes the database underneath it, and the next container's write
   * lands on a closed handle. That is safe rather than lucky: every write in a
   * pass is inside the per-container `catch`, a `tryWrite`, or — for the prune
   * and the attempt stamp, which belong to no container — this class's own
   * per-source wrap. The throw becomes one recorded failure and the pass ends
   * normally on a result nobody reads. Traced deliberately (DOR-702 review) and
   * recorded here so nobody "fixes" it into an unhandled rejection by moving a
   * write out of a guard.
   */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Bring every source up to date, and report what changed.
   *
   * Resolves even when a source fails — see {@link SweepResult.failures}.
   */
  async sweep(): Promise<SweepResult> {
    const at = new Date().toISOString();
    const result: SweepResult = {
      containers: 0,
      indexed: 0,
      skipped: 0,
      pruned: 0,
      rebuilt: 0,
      failures: [],
    };

    for (const source of this.sources) {
      // **One source may not take the tick down with it.** Each mechanism
      // already degrades per container, but a throw from OUTSIDE a container's
      // own `try` — a container list that will not read, a snapshot that will
      // not open — escapes the mechanism entirely, and before this was wrapped
      // it also skipped every source ORDERED AFTER the failing one. That is the
      // worst version of the failure this whole feature refuses: rooms and
      // Claude Code silently stop indexing because OpenCode's store moved, and
      // the only trace is one line in a log.
      //
      // `SweepResult.failures` already promises a sweep with failures still
      // resolves; this is what makes that true for the paths a mechanism cannot
      // catch for itself.
      try {
        // The registry row names its mechanism, so nothing here infers one from
        // the shape of the record (spec §3).
        const swept =
          source.mechanism === 'jsonl'
            ? await sweepFileSource(this.db, source, at)
            : source.mechanism === 'sqlite-snapshot'
              ? await sweepSnapshotSource(this.db, source, at)
              : await sweepRowSource(this.db, source, at);
        result.containers += swept.containers;
        result.indexed += swept.indexed;
        result.skipped += swept.skipped;
        result.pruned += swept.pruned;
        result.rebuilt += swept.rebuilt;
        result.failures.push(...swept.failures);
      } catch (err) {
        result.failures.push({
          sourceId: source.id,
          // No container was reached, so there is nothing to blame and no
          // `search_sources` row to write — the same reasoning as
          // `DISCOVERY_FAILURE_KEY` and `SNAPSHOT_FAILURE_KEY`, one level up.
          originKey: SOURCE_FAILURE_KEY,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /**
   * Run a sweep in the background, logging whatever it reports.
   *
   * **An in-flight guard is what keeps two sweeps from overlapping.** A tick
   * that fires while the previous pass is still running is skipped rather than
   * started — the guard is set before {@link SearchIndexer.sweep} is called and
   * cleared in a `finally`, so a pass that throws still releases it for the
   * next tick (DOR-1578).
   *
   * Overlap was left unguarded once, safe by argument rather than by
   * construction: since a sweep yields between containers, a pass slower than
   * the interval could still be running when the next tick fired, and nothing
   * stopped the two running concurrently. That argument is kept here as
   * history, not as the reason overlap can't happen today — every write is its
   * own transaction, the message insert is an idempotent upsert keyed
   * `(source, container, ordinal)`, the frontier write is an upsert of the same
   * shape, and each pass computes its prune set from the container list IT
   * discovered, so neither could delete on the other's view. The first write
   * that is not idempotent would have broken that argument; the guard makes it
   * moot instead.
   */
  private runSweep(): void {
    if (this.sweepInFlight) {
      if (!this.skippedTickLogged) {
        this.skippedTickLogged = true;
        logger.debug('[Search] sweep tick skipped: the previous pass is still running');
      }
      return;
    }
    this.sweepInFlight = true;
    this.skippedTickLogged = false;
    this.sweep()
      .then((result) => {
        for (const failure of result.failures) {
          // Deliberately not "a source produced nothing", and deliberately not
          // pointing at `last_error`. This one line covers four shapes: a
          // container whose projection threw (which DID write `last_error`), a
          // discovery that failed outright, several files claiming one container
          // id, and one root of several that would not open — and in that last
          // case the source contributed plenty from the roots that did open.
          // What is true of all four is that something identifiable is missing
          // from the index, and the entry says which.
          logger.warn('[Search] a source could not index part of what it covers', failure);
        }
        if (result.skipped > 0) {
          // The quiet failure. Nothing is broken enough to stop a container, and
          // that is exactly why it needs saying out loud.
          logger.warn('[Search] a source held rows its projection did not recognise', {
            skipped: result.skipped,
          });
        }
        if (result.indexed > 0 || result.pruned > 0 || result.rebuilt > 0) {
          logger.info('[Search] index updated', {
            indexed: result.indexed,
            pruned: result.pruned,
            rebuilt: result.rebuilt,
          });
        }
      })
      .catch((err: unknown) => logger.error('[Search] sweep failed', err))
      .finally(() => {
        this.sweepInFlight = false;
      });
  }
}
