/**
 * **M3** — the mechanism that indexes another program's SQLite store through a
 * throwaway snapshot (message-search spec §3 as amended, ADR 260825-110420).
 *
 * It is deliberately the shortest of the three files, and that is the finding
 * rather than an accident. M3 was named in the spec as the mechanism whose
 * arrival would promote the registry array to a `SearchAdapter` port; what it
 * actually needed was a snapshot lifetime and nothing else. The watermark
 * arithmetic, the shrink rebuild, the frontier write and the prune are M2's, run
 * unchanged through {@link sweepContainers}.
 *
 * The two things this file owns:
 *
 * - **The snapshot's lifetime.** One copy per sweep, closed and deleted in a
 *   `finally`, however the pass ends.
 * - **The difference between "no store" and "nothing left".** A machine where
 *   OpenCode has never run has no `opencode.db`, and that must index nothing and
 *   prune nothing. Reading an absent store as an empty container list would
 *   delete every indexed OpenCode session the first time the runtime was
 *   uninstalled, then rebuild it all if it came back.
 *
 * @module server/services/search/snapshot-frontier
 */
import type { Db } from '@dorkos/db';
import { sweepContainers } from './row-frontier.js';
import type { SnapshotSource, SourceSweep } from './types.js';

/**
 * The `originKey` a failure carries when the snapshot itself could not be taken.
 *
 * Same shape and same reasoning as `jsonl-frontier.ts`'s
 * `DISCOVERY_FAILURE_KEY`: no container was enumerated, so there is nothing to
 * blame, and no `search_sources` row is written — a row keyed on an invented
 * container id would be one the reader can never return, which the prune would
 * then delete on the first healthy sweep. The visibility comes through
 * {@link SourceSweep.failures}, which the reconciler logs.
 */
export const SNAPSHOT_FAILURE_KEY = '(snapshot)';

/**
 * Bring one snapshot-backed source's slice of the index up to date.
 *
 * **A snapshot that cannot be taken is a source failure, not a sweep failure.**
 * It reaches a filesystem and copies a file another process is writing, so it
 * can fail for reasons that have nothing to do with DorkOS — a full temp
 * volume, a permission removed underneath it, a store whose schema moved.
 * Letting that reject would take down every OTHER source in the same tick.
 * Nothing is pruned on that path.
 *
 * @param db - The database to write the index to. Must have been opened through
 *   `createDb` — see the `recursive_triggers` note in `packages/db/src/index.ts`.
 * @param source - The registry row being swept.
 * @param at - The ISO-8601 timestamp to stamp this attempt with.
 */
export async function sweepSnapshotSource(
  db: Db,
  source: SnapshotSource,
  at: string
): Promise<SourceSweep> {
  const empty: SourceSweep = {
    sourceId: source.id,
    containers: 0,
    indexed: 0,
    skipped: 0,
    pruned: 0,
    rebuilt: 0,
    failures: [],
  };

  let reader;
  try {
    reader = await source.open();
  } catch (err) {
    return {
      ...empty,
      failures: [
        {
          sourceId: source.id,
          originKey: SNAPSHOT_FAILURE_KEY,
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }

  // No store on this machine. Not a failure, and emphatically not an empty
  // container list — see the module doc.
  if (reader === null) return empty;

  try {
    return sweepContainers(db, source.id, reader, at);
  } finally {
    reader.close();
  }
}
