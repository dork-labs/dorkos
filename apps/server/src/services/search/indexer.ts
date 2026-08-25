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
import { SEARCH_SOURCES } from './registry.js';
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

  /**
   * Build an indexer over a database and a set of sources.
   *
   * @param db - The database, opened through `createDb` so `recursive_triggers`
   *   is on.
   * @param sources - Which sources to sweep. Defaults to the whole registry.
   *   A test that cares about one source passes just that one: the default set
   *   reaches the filesystem, and a room test has no business reading the
   *   operator's transcripts.
   * @param intervalMs - Sweep cadence. Defaults to
   *   {@link SEARCH_RECONCILE_INTERVAL_MS}.
   */
  constructor(
    private readonly db: Db,
    private readonly sources: readonly SearchSource[] = SEARCH_SOURCES,
    private readonly intervalMs: number = SEARCH_RECONCILE_INTERVAL_MS
  ) {}

  /**
   * Sweep once now, then every {@link SearchIndexer.intervalMs}.
   *
   * The startup sweep is not awaited: an index that is a few hundred
   * milliseconds behind is the normal state of this cache, and boot should not
   * wait on a cache. The timer is `unref`'d so it never holds the process open.
   */
  start(): void {
    if (this.timer) return;
    this.runSweep();
    this.timer = setInterval(() => this.runSweep(), this.intervalMs);
    this.timer.unref();
  }

  /** Stop sweeping. */
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
      // The registry row names its mechanism, so nothing here infers one from
      // the shape of the record (spec §3).
      const swept =
        source.mechanism === 'jsonl'
          ? await sweepFileSource(this.db, source, at)
          : source.mechanism === 'sqlite-snapshot'
            ? await sweepSnapshotSource(this.db, source, at)
            : sweepRowSource(this.db, source, at);
      result.containers += swept.containers;
      result.indexed += swept.indexed;
      result.skipped += swept.skipped;
      result.pruned += swept.pruned;
      result.rebuilt += swept.rebuilt;
      result.failures.push(...swept.failures);
    }

    return result;
  }

  /** Run a sweep in the background, logging whatever it reports. */
  private runSweep(): void {
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
      .catch((err: unknown) => logger.error('[Search] sweep failed', err));
  }
}
