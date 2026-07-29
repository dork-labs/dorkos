/**
 * **M2** — the mechanism that indexes rows above a monotonic watermark
 * (message-search spec §3, §5, §6.4).
 *
 * Written once for the mechanism, not once per source: discovery, change
 * detection, the incremental read, the upsert and the prune all live here, and
 * a source contributes only two functions and a projection.
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
import type { Projection, RowContainer, RowSource, SourceFailure } from './types.js';

/**
 * A database handle or a transaction on one.
 *
 * Every write below runs inside a transaction the caller opened, so the helpers
 * take the transaction handle rather than reaching back for the connection —
 * which happens to work under `better-sqlite3` and reads like a bug.
 */
type Writer = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * How many message rows go into one `INSERT`.
 *
 * SQLite caps a statement at 32,766 host parameters and each row here binds six,
 * so the hard ceiling is 5,461 rows and an unchunked insert of a large container
 * fails outright above it. 500 is a tenth of that rather than the ceiling itself,
 * and it is safe for any content: parameters are **bound**, never inlined into
 * the SQL text, so a chunk of 500 costs 3,000 parameters whether the bodies are
 * ten characters or ten thousand. Every chunk runs inside the container's one
 * transaction, so this does not weaken the one-transaction-per-container rule.
 */
const INSERT_CHUNK_ROWS = 500;

/** What one pass over one row-backed source did. */
export interface RowSourceSweep {
  /** Which source. */
  sourceId: string;

  /** Containers that exist right now. */
  containers: number;

  /**
   * Message rows written this pass.
   *
   * The number a no-op sweep has to report as `0`. Asserting an unchanged
   * `count(*)` instead would pass for a sweep that correctly did nothing AND for
   * a broken one that re-read and re-upserted every row.
   */
  indexed: number;

  /**
   * Rows the projection read, recognised as its own, and could not make a
   * message out of.
   *
   * The quiet half of the format-change problem. A projection that THROWS is
   * loud — it writes `last_error` and stops the container. A projection handed a
   * record whose shape has drifted underneath it does not throw; it returns fewer
   * rows, which is indistinguishable from a source with nothing to say. This is
   * the count that tells the two apart, and it is deliberately not an error: one
   * drifted row must not stop a whole container from indexing.
   */
  skipped: number;

  /** Containers that no longer exist and were dropped from the index. */
  pruned: number;

  /** Containers re-read whole because the index held rows they no longer have. */
  rebuilt: number;

  /** Containers whose read or projection threw. Each also wrote `last_error`. */
  failures: SourceFailure[];
}

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
export function sweepRowSource(db: Db, source: RowSource, at: string): RowSourceSweep {
  const sweep: RowSourceSweep = {
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

  sweep.pruned = pruneVanished(db, source.id, live, state);
  stampAttempt(db, source.id, at);
  return sweep;
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

  for (const row of db
    .select({ originKey: messages.originKey, indexedTo: sql<number>`MAX(${messages.ordinal})` })
    .from(messages)
    .where(eq(messages.sourceId, sourceId))
    .groupBy(messages.originKey)
    .all()) {
    const known = state.get(row.originKey);
    if (known) known.indexedTo = row.indexedTo;
    else state.set(row.originKey, { watermark: null, indexedTo: row.indexedTo });
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
    insertMessages(tx, source.id, projection);
    writeFrontier(tx, source.id, container, reached, at, null);
  });

  return { indexed: projection.messages.length, skipped: projection.skipped, rebuilt };
}

/** Write one container's projected messages, in chunks, inside the caller's transaction. */
function insertMessages(writer: Writer, sourceId: string, projection: Projection): void {
  const rows = projection.messages;
  for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
    const chunk = rows.slice(start, start + INSERT_CHUNK_ROWS).map((message) => ({
      sourceId,
      originKey: message.originKey,
      ordinal: message.ordinal,
      role: message.role,
      createdAt: message.createdAt,
      body: message.body,
    }));
    writer
      .insert(messages)
      .values(chunk)
      // NEVER a bare `INSERT OR REPLACE`: it skips the `messages_fts_ad` trigger
      // unless `recursive_triggers` is on, and both `PRAGMA integrity_check` and
      // FTS5's own integrity-check report `ok` while the index holds terms for
      // text that no longer exists anywhere (see `packages/db/src/index.ts`).
      //
      // The conflict clause is what makes re-reading a container idempotent. On
      // every path that ships today DO UPDATE and DO NOTHING are indistinguishable,
      // because a re-read replays identical text and nothing is ever actually
      // updated — measured, by swapping them. DO UPDATE is kept as the safer of
      // two equals: it is the branch that would matter if a projection's output
      // for an ordinal ever changed without the container being rebuilt. `excluded`
      // is the row being inserted; reading the chunk's first element here would
      // write one row's text onto every conflicting row in the chunk.
      .onConflictDoUpdate({
        target: [messages.sourceId, messages.originKey, messages.ordinal],
        set: {
          role: sql`excluded.role`,
          createdAt: sql`excluded.created_at`,
          body: sql`excluded.body`,
        },
      })
      .run();
  }
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
 * Stamp every one of this source's containers with the time of this attempt.
 *
 * One statement rather than one transaction per container, which is the whole
 * point of it being here: a source with 2,458 unchanged containers used to cost
 * 2,458 write transactions per tick just to record that nothing had happened.
 * `last_indexed_at` keeps the meaning its column documents — the last indexing
 * ATTEMPT, successful or not — because that is the one a person debugging "why
 * has my message not shown up" needs. "We looked at 12:05" answers it; "it last
 * changed at 09:00" does not.
 */
function stampAttempt(db: Db, sourceId: string, at: string): void {
  db.update(searchSources)
    .set({ lastIndexedAt: at })
    .where(eq(searchSources.sourceId, sourceId))
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

/**
 * Drop every indexed container of this source that no longer exists.
 *
 * This is the FIRST of the two things the single word "prune" hides (spec §6.4):
 * a container that is **gone**, whose rows would otherwise be served forever out
 * of a source nobody can open. The second — a container that is intact but whose
 * working directory has vanished — is NEVER pruned, and cannot arise for a
 * row-backed source at all, because such a source has no directory to lose.
 *
 * This is also, on its own, the entire answer to a room being retired underneath
 * the index: the room stops being discovered, so its rows and its frontier go
 * together, with no watermark reasoning involved.
 *
 * `messages` goes before the frontier row, and it goes at all: dropping only the
 * frontier resets the watermark but strands the indexed copies, since discovery
 * never returns a container that does not exist. The DELETE is a plain statement
 * so `messages_fts_ad` fires and retracts the text from FTS5 — an
 * external-content index keeps no copy of its own and cannot notice otherwise.
 */
function pruneVanished(
  db: Db,
  sourceId: string,
  live: ReadonlySet<string>,
  state: ReadonlyMap<string, FrontierState>
): number {
  let pruned = 0;
  for (const originKey of state.keys()) {
    if (live.has(originKey)) continue;
    db.transaction((tx) => {
      deleteContainerMessages(tx, sourceId, originKey);
      tx.delete(searchSources)
        .where(and(eq(searchSources.sourceId, sourceId), eq(searchSources.originKey, originKey)))
        .run();
    });
    pruned += 1;
  }
  return pruned;
}

/** Delete one container's message rows, letting the FTS5 delete trigger fire. */
function deleteContainerMessages(writer: Writer, sourceId: string, originKey: string): void {
  writer
    .delete(messages)
    .where(and(eq(messages.sourceId, sourceId), eq(messages.originKey, originKey)))
    .run();
}
