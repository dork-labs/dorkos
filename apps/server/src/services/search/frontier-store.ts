/**
 * The writes both mechanisms make — the parts of keeping a frontier that have
 * nothing to do with whether a container is a table or a file.
 *
 * M1 and M2 differ in exactly two places: how they detect change (a byte offset
 * against `(size, mtime)`, versus a monotonic column against a watermark) and
 * which frontier columns they fill. Everything else — the chunked upsert, the
 * per-container delete, the attempt stamp, the prune, and reading back what the
 * index actually holds — is one implementation used by both. Duplicating it per
 * mechanism is how the two would drift on the `ON CONFLICT` clause that keeps
 * FTS5 in sync, which is the one place a copy would be silently wrong.
 *
 * @module server/services/search/frontier-store
 */
import { messages, searchSources, and, eq, sql, type Db } from '@dorkos/db';
import type { ProjectedMessage } from './types.js';

/**
 * A database handle or a transaction on one.
 *
 * Every write below runs inside a transaction the caller opened, so the helpers
 * take the transaction handle rather than reaching back for the connection —
 * which happens to work under `better-sqlite3` and reads like a bug.
 */
export type Writer = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

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

/**
 * Write projected messages for one source, in chunks, inside the caller's
 * transaction.
 *
 * @param writer - The open transaction.
 * @param sourceId - Stamped onto every row, from the registry rather than from
 *   the projection, so a projection cannot get its own source's name wrong.
 * @param rows - The messages, in ordinal order.
 */
export function insertMessages(
  writer: Writer,
  sourceId: string,
  rows: readonly ProjectedMessage[]
): void {
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

/**
 * Delete one container's message rows, letting the FTS5 delete trigger fire.
 *
 * @param writer - The open transaction.
 * @param sourceId - Which source.
 * @param originKey - Which container within it.
 */
export function deleteContainerMessages(writer: Writer, sourceId: string, originKey: string): void {
  writer
    .delete(messages)
    .where(and(eq(messages.sourceId, sourceId), eq(messages.originKey, originKey)))
    .run();
}

/**
 * The highest ordinal the index ACTUALLY holds, per container of one source.
 *
 * This is what makes a frontier row non-authoritative. `messages` is the half of
 * the index anyone would think to throw away, and a resume position trusted on
 * its own turns an emptied `messages` into a permanently empty index that
 * reports success every five minutes.
 *
 * `MAX(ordinal)` grouped by container rides the leading columns of
 * `messages_source_id_origin_key_ordinal_unique`, so it is an index-only read of
 * this source's own slice.
 *
 * @param db - The database to read.
 * @param sourceId - Which source.
 * @returns One entry per container that holds at least one row.
 */
export function readIndexedOrdinals(db: Db, sourceId: string): Map<string, number> {
  const indexed = new Map<string, number>();
  for (const row of db
    .select({ originKey: messages.originKey, indexedTo: sql<number>`MAX(${messages.ordinal})` })
    .from(messages)
    .where(eq(messages.sourceId, sourceId))
    .groupBy(messages.originKey)
    .all()) {
    indexed.set(row.originKey, row.indexedTo);
  }
  return indexed;
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
 *
 * @param db - The database to write.
 * @param sourceId - Which source.
 * @param at - The ISO-8601 timestamp of this attempt.
 */
export function stampAttempt(db: Db, sourceId: string, at: string): void {
  db.update(searchSources)
    .set({ lastIndexedAt: at })
    .where(eq(searchSources.sourceId, sourceId))
    .run();
}

/**
 * Drop every indexed container of this source that no longer exists.
 *
 * This is the FIRST of the two things the single word "prune" hides (spec §6.4):
 * a container that is **gone**, whose rows would otherwise be served forever out
 * of a source nobody can open. The second — a container that is intact but whose
 * working directory has vanished — is NEVER pruned. That asymmetry is the one a
 * well-meaning cleanup gets wrong: the conversation happened, the transcript is
 * still on disk, and "what did we decide in that worktree" is exactly the
 * question search exists to answer. What changes is the result, not the row —
 * `search_sources.container_path` is what lets the hit say the directory is gone.
 *
 * `messages` goes before the frontier row, and it goes at all: dropping only the
 * frontier resets the resume position but strands the indexed copies, since
 * discovery never returns a container that does not exist. The DELETE is a plain
 * statement so `messages_fts_ad` fires and retracts the text from FTS5 — an
 * external-content index keeps no copy of its own and cannot notice otherwise.
 *
 * @param db - The database to write.
 * @param sourceId - Which source.
 * @param live - Containers discovery just reported. Everything else goes.
 * @param known - Every container the index has any trace of — frontier rows and
 *   message rows alike, because either can outlive the other.
 * @returns How many containers were dropped.
 */
export function pruneVanished(
  db: Db,
  sourceId: string,
  live: ReadonlySet<string>,
  known: Iterable<string>
): number {
  let pruned = 0;
  for (const originKey of new Set(known)) {
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
