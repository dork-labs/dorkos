/**
 * **M2** — the mechanism that indexes rows above a monotonic watermark
 * (message-search spec §3, §5, §6.4).
 *
 * Written once for the mechanism, not once per source: discovery, change
 * detection and the incremental read live here, and a source contributes only
 * two functions and a projection. The writes it makes are the ones both
 * mechanisms make, and they live in `frontier-store.ts` — a copy per mechanism
 * is how the two would drift on the `ON CONFLICT` clause that keeps FTS5 in
 * sync.
 *
 * Nothing in this file is a store. Every row it writes is derived from a source
 * DorkOS reads and never owns, and deleting the index is a supported recovery
 * rather than data loss (ADR 260728-214214).
 *
 * **What "deleting the index" has to survive is BOTH tables, separately.**
 * `messages` is the half anyone would think to throw away and `search_sources`
 * is bookkeeping, so a resume position trusted on its own turns an emptied
 * `messages` into a permanently empty index that reports success every five
 * minutes. The frontier is therefore never the only signal: the index's own
 * high-water ordinal is read alongside it, and the sweep resumes from whichever
 * is lower.
 *
 * @module server/services/search/row-frontier
 */
import { messages, searchSources, and, eq, sql, type Db } from '@dorkos/db';
import {
  deleteContainerMessages,
  insertMessages,
  pruneVanished,
  readIndexedOrdinals,
  stampAttempt,
  type Writer,
} from './frontier-store.js';
import type { RowContainer, RowSource, SourceSweep } from './types.js';

/** One container's resume state, read once per sweep rather than once per container. */
interface FrontierState {
  /** What the frontier row claims. `null` means there is no frontier row at all. */
  watermark: number | null;

  /** The highest ordinal the index ACTUALLY holds for this container. */
  indexedTo: number;
}

/**
 * Bring one row-backed source's slice of the index up to date.
 *
 * Three queries set the pass up — the container list, the frontier rows, and the
 * index's own high-water ordinal per container — and then only containers that
 * changed do any work. An unchanged container costs no read, no write and no
 * transaction of its own.
 *
 * **A container that throws does not stop the sweep.** Its failure is written to
 * `search_sources.last_error`, its watermark is left where it was so the next
 * pass retries from the same place, and the remaining containers index normally.
 *
 * @param db - The database to read the source from and write the index to. Must
 *   have been opened through `createDb` — see the `recursive_triggers` note in
 *   `packages/db/src/index.ts`.
 * @param source - The registry row being swept.
 * @param at - The ISO-8601 timestamp to stamp this attempt with.
 */
export function sweepRowSource(db: Db, source: RowSource, at: string): SourceSweep {
  const sweep: SourceSweep = {
    sourceId: source.id,
    containers: 0,
    indexed: 0,
    skipped: 0,
    pruned: 0,
    rebuilt: 0,
    failures: [],
  };

  const containers = source.listContainers(db);
  sweep.containers = containers.length;
  const state = readFrontierState(db, source.id);
  const live = new Set(containers.map((container) => container.originKey));

  for (const container of containers) {
    try {
      const outcome = indexContainer(db, source, container, state, at);
      sweep.indexed += outcome.indexed;
      sweep.skipped += outcome.skipped;
      if (outcome.rebuilt) sweep.rebuilt += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordFailure(db, source.id, container, state, at, message);
      sweep.failures.push({ sourceId: source.id, originKey: container.originKey, message });
    }
  }

  sweep.pruned = pruneVanished(db, source.id, live, state.keys());
  stampAttempt(db, source.id, at);
  return sweep;
}

/**
 * Bring ONE container of a row-backed source up to date, now.
 *
 * The write-through path (spec §5, Amendment 6): DorkOS owns the room log's
 * write, so it knows the instant a container has gained something and does not
 * have to wait up to five minutes for the sweep to notice. Everything else about
 * the pass is identical — the same resume rule, the same rebuild detection, the
 * same watermark — because it IS the same function; only the container list and
 * the prune are skipped, and both of those are the parts that scale with how
 * many containers exist rather than with what changed.
 *
 * **It reads the frontier for this container alone.** Two lookups on primary-key
 * columns rather than the sweep's two whole-source scans, which is what makes it
 * cheap enough to sit on a write path.
 *
 * **It throws rather than recording a failure**, unlike the sweep. A single-
 * container caller is not a sweep and has no other containers to protect; the
 * caller decides what a failure means, and for the room path it means "log it and
 * let the sweep catch up" (`write-through.ts`).
 *
 * @param db - The database. Must have been opened through `createDb`.
 * @param source - The registry row this container belongs to.
 * @param container - The container, with its ordinal high-water mark as the
 *   caller knows it — the `seq` just committed, for a room.
 * @param at - The ISO-8601 timestamp to stamp the attempt with.
 * @returns What was written, and what the projection could not use.
 */
export function indexRowContainer(
  db: Db,
  source: RowSource,
  container: RowContainer,
  at: string
): { indexed: number; skipped: number; rebuilt: boolean } {
  return indexContainer(db, source, container, readContainerState(db, source.id, container), at);
}

/**
 * One container's resume state, read by key rather than by scanning the source.
 *
 * The same two facts {@link readFrontierState} gathers for every container —
 * what the frontier claims and what the index can be seen to hold — narrowed to
 * one. Both reads ride primary-key columns: `search_sources` is keyed
 * `(source_id, origin_key)`, and `MAX(ordinal)` for one container rides the
 * leading columns of `messages_source_id_origin_key_ordinal_unique`.
 */
function readContainerState(
  db: Db,
  sourceId: string,
  container: RowContainer
): Map<string, FrontierState> {
  const frontier = db
    .select({ lastOrdinal: searchSources.lastOrdinal })
    .from(searchSources)
    .where(
      and(eq(searchSources.sourceId, sourceId), eq(searchSources.originKey, container.originKey))
    )
    .get();
  const indexed = db
    .select({ indexedTo: sql<number | null>`MAX(${messages.ordinal})` })
    .from(messages)
    .where(and(eq(messages.sourceId, sourceId), eq(messages.originKey, container.originKey)))
    .get();

  return new Map([
    [
      container.originKey,
      {
        // `null` when there is no frontier row at all — the state that makes a
        // container's first write-through create one, exactly as its first sweep
        // would.
        watermark: frontier ? (frontier.lastOrdinal ?? 0) : null,
        indexedTo: indexed?.indexedTo ?? 0,
      },
    ],
  ]);
}

/**
 * Read every container's resume state for one source, in two queries.
 *
 * The high-water ordinal comes from `messages` itself, and that is what makes
 * the frontier non-authoritative. `MAX(ordinal)` grouped by container rides the
 * leading columns of `messages_source_id_origin_key_ordinal_unique`, so it is an
 * index-only read of this source's own slice.
 */
function readFrontierState(db: Db, sourceId: string): Map<string, FrontierState> {
  const state = new Map<string, FrontierState>();

  for (const row of db
    .select({ originKey: searchSources.originKey, lastOrdinal: searchSources.lastOrdinal })
    .from(searchSources)
    .where(eq(searchSources.sourceId, sourceId))
    .all()) {
    state.set(row.originKey, { watermark: row.lastOrdinal ?? 0, indexedTo: 0 });
  }

  for (const [originKey, indexedTo] of readIndexedOrdinals(db, sourceId)) {
    const known = state.get(originKey);
    if (known) known.indexedTo = indexedTo;
    else state.set(originKey, { watermark: null, indexedTo });
  }

  return state;
}

/**
 * Index everything one container has gained since the last pass.
 *
 * @returns What was written, what the projection could not use, and whether the
 *   container was re-read whole.
 */
function indexContainer(
  db: Db,
  source: RowSource,
  container: RowContainer,
  state: ReadonlyMap<string, FrontierState>,
  at: string
): { indexed: number; skipped: number; rebuilt: boolean } {
  const known = state.get(container.originKey);
  const watermark = known?.watermark ?? 0;
  const indexedTo = known?.indexedTo ?? 0;

  // The index holds rows the container no longer has, so its ordinals were
  // renumbered underneath us and the strays have to go — nothing above the
  // container's end will ever be overwritten by a re-read, and every one of them
  // stays searchable. This is M1's shrink-means-rebuild rule (spec §5) on the
  // mechanism that has ordinals instead of bytes.
  //
  // **The rows are the evidence, not the watermark**, and the difference is not
  // cosmetic. A version of this also asked whether `maxOrdinal < watermark`, and
  // that disjunct is subsumed: it can only be true with nothing stale above the
  // container's end, and `resumeFrom`'s clamp already handles that case
  // correctly. Measured, by dropping each half in turn — the watermark half
  // alone leaves every test green. Keying on the rows also covers the state a
  // watermark cannot see at all, because it has been deleted: an invalidation
  // that drops the frontier row landing on a container that has ALSO shrunk.
  //
  // It covers no source shipping today, and that is worth stating plainly
  // because an earlier version of this comment claimed otherwise. The room log
  // only appends, nothing in the repo deletes a `room_entries` row and there is
  // no cascade that would, and the thread retirement on `retire-thread-rooms`
  // (DOR-634) reallocates by APPENDING above the parent's existing maximum — it
  // never lowers any room's `max(seq)`. A room retired outright is handled by
  // {@link pruneVanished}, with no watermark reasoning involved. What justifies
  // keeping it is that M2 is generic machinery and this is one integer
  // comparison: a DorkOS-owned table that reallocates its own ordinals is
  // expressible here, and this is the answer when one arrives.
  const rebuilt = container.maxOrdinal < indexedTo;

  // Nothing new AND the index really holds what the frontier claims. Both halves
  // are load-bearing. `maxOrdinal <= watermark` on its own let a `DELETE FROM
  // messages` — the half of the index anyone would actually think to throw away —
  // leave every container reporting "nothing new" forever, with search returning
  // nothing and no error recorded anywhere.
  if (!rebuilt && container.maxOrdinal <= watermark && indexedTo >= watermark) {
    // The frontier row still has to EXIST. A container that has never held a
    // projectable message — an empty room — is a no-op on its very first pass,
    // and skipping the write would leave it undiscovered until somebody spoke.
    if (known?.watermark == null) {
      db.transaction((tx) => writeFrontier(tx, source.id, container, watermark, at, null));
    }
    return { indexed: 0, skipped: 0, rebuilt: false };
  }

  // Resume from whichever is lower: what the frontier claims, or what the index
  // can be seen to hold. Re-reading is idempotent, so resuming too early costs a
  // wasted read while resuming too late leaves a permanent hole.
  const resumeFrom = rebuilt ? 0 : Math.min(watermark, indexedTo);
  const projection = source.readSince(db, container.originKey, resumeFrom);
  const highest = projection.messages.at(-1)?.ordinal ?? 0;

  // The watermark tracks the CONTAINER, not the projection: a container whose
  // newest rows all project to nothing (every one a notice) has still been read
  // up to `maxOrdinal`, and a watermark that stopped at the last row which
  // happened to produce a message would re-read those rows on every sweep
  // forever.
  //
  // `highest` covers the other direction. Discovery and the read are two separate
  // statements, so a source whose writer can commit between them returns rows
  // above the `maxOrdinal` discovery reported. Recording what was actually read
  // is what keeps the invariant this whole file rests on — the watermark is never
  // behind the index — and without it a lagging discovery would leave
  // `indexedTo` above the watermark and trip the rebuild above on a container
  // that only grew. Unreachable for rooms, where the two statements run
  // synchronously on one connection, and not unreachable for M1.
  //
  // On a rebuild it is `maxOrdinal` outright and never a `max`: guarding the
  // watermark against moving backwards is exactly what a renumbered container
  // needs it NOT to do.
  const reached = rebuilt ? container.maxOrdinal : Math.max(container.maxOrdinal, highest);

  db.transaction((tx) => {
    if (rebuilt) deleteContainerMessages(tx, source.id, container.originKey);
    insertMessages(tx, source.id, projection.messages);
    writeFrontier(tx, source.id, container, reached, at, null);
  });

  return { indexed: projection.messages.length, skipped: projection.skipped, rebuilt };
}

/** Upsert the container's frontier row. */
function writeFrontier(
  writer: Writer,
  sourceId: string,
  container: RowContainer,
  lastOrdinal: number,
  at: string,
  lastError: string | null
): void {
  writer
    .insert(searchSources)
    .values({
      sourceId,
      originKey: container.originKey,
      lastOrdinal,
      containerPath: container.containerPath,
      lastIndexedAt: at,
      lastError,
    })
    .onConflictDoUpdate({
      target: [searchSources.sourceId, searchSources.originKey],
      set: {
        lastOrdinal: sql`excluded.last_ordinal`,
        containerPath: sql`excluded.container_path`,
        lastIndexedAt: sql`excluded.last_indexed_at`,
        lastError: sql`excluded.last_error`,
      },
    })
    .run();
}

/**
 * Record why a container produced nothing, leaving its watermark alone.
 *
 * The watermark is deliberately not advanced: the next pass must retry the same
 * rows, not skip them because an attempt was made.
 */
function recordFailure(
  db: Db,
  sourceId: string,
  container: RowContainer,
  state: ReadonlyMap<string, FrontierState>,
  at: string,
  message: string
): void {
  const watermark = state.get(container.originKey)?.watermark ?? 0;
  db.transaction((tx) => writeFrontier(tx, sourceId, container, watermark, at, message));
}
