/**
 * The parts of a sweep that have nothing to do with whether a container is a
 * table, a file, or a copy of somebody else's database — the writes every
 * mechanism makes, the failure it records when discovery itself fails, and the
 * turn it hands back to the event loop between containers.
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
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import {
  messages,
  searchSources,
  and,
  eq,
  isNull,
  like,
  notInArray,
  or,
  sql,
  type Db,
} from '@dorkos/db';
import { logger } from '../../lib/logger.js';
import type { ProjectedMessage } from './types.js';

/**
 * The `originKey` a failure carries when there is no container to blame —
 * discovery itself failed, so nothing was enumerated to attribute it to. Every
 * shape uses it: a discovery that rejected outright, one root of several that
 * could not be read, and a container list that would not read.
 *
 * It names no row and none is written: `search_sources` is keyed by container,
 * and inventing a container id to hold an error would put a row in the frontier
 * that discovery can never return, which the prune would then delete on the
 * first healthy sweep. That is a deliberate narrowing of spec Amendment 2's
 * "one `search_sources.last_error` and zero rows" for the per-root case — the
 * visibility it asks for is delivered through `SourceSweep.failures`, which the
 * reconciler logs, plus {@link stampSourceError} on the containers that really
 * do exist.
 */
export const DISCOVERY_FAILURE_KEY = '(discovery)';

/**
 * Hand the event loop a turn.
 *
 * Called between containers by every sweep, because `better-sqlite3` is
 * synchronous and a mechanism that never awaits real I/O holds the process for
 * its whole pass — 4,000 rooms measured at 36.6ms with zero turns, and a first
 * index over a real transcript corpus is far larger than that (DOR-702). An
 * `await` on an already-resolved promise does not help: microtasks drain
 * without ever reaching a timer or a socket, so the yield has to be a macrotask.
 *
 * `setImmediate` rather than `setTimeout(0)`: it resumes in the same loop
 * iteration's check phase instead of waiting on the timer clamp, so the sweep
 * pays one loop iteration per container rather than a millisecond. Taken from
 * `node:timers/promises` rather than the global, so a test with fake timers
 * installed does not have to advance them to let a sweep finish.
 */
export async function yieldToEventLoop(): Promise<void> {
  await yieldToLoop();
}

/**
 * Run a bookkeeping write that must never take the sweep down with it.
 *
 * The writes this wraps all describe a failure that has ALREADY happened, and
 * every one of them runs inside a `catch`. A `SQLITE_BUSY` there — five other
 * writers share this file and `busy_timeout` is five seconds, so losing that
 * race is ordinary — used to escape the catch, the container loop, and the
 * sweep, turning one container's bad day into a source that stopped indexing
 * (DOR-709). Degrading to a log line loses the durable record of ONE failure;
 * letting it throw loses the sweep.
 *
 * @param what - What the write was recording, for the log line.
 * @param write - The write. Anything it throws is logged and swallowed.
 */
export function tryWrite(what: string, write: () => void): void {
  try {
    write();
  } catch (err) {
    logger.warn('[Search] a bookkeeping write did not land, and was dropped rather than retried', {
      what,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * What marks a `last_error` as belonging to the SOURCE rather than to the one
 * container whose row it happens to sit on.
 *
 * Both kinds share a column, and without a mark the two are indistinguishable —
 * which matters at exactly one moment: the clear at the end of a healthy pass
 * must retire a whole-source stamp and must not touch a container's own error.
 * The difference is not cosmetic. A file that stalls on an unterminated line
 * records its failure and then deliberately advances its fingerprint, so it is
 * SKIPPED on every later sweep and never reports again; a blanket clear erased
 * that error on the very next tick and the file went quiet forever. Caught by
 * `jsonl-frontier.test.ts`'s stall test, which is why it is a mark rather than
 * an argument about which errors are self-healing.
 *
 * **It leads with a NUL so no real message can ever wear it.** A bracketed
 * prefix on an error string is an existing idiom here — `'[q3] …'` and friends —
 * so a plain `'[source] '` would eventually arrive as some projection's own
 * message and be silently clearable, which is precisely the bug the mark
 * exists to prevent. NUL is the one character a message cannot contain, and it
 * is the same reason `containerKey` in `search-service.ts` joins on one. Written
 * as an ESCAPE rather than pasted in as a byte: a raw NUL in the source makes
 * git treat the whole file as binary and stop diffing it (DOR-1561).
 *
 * The text is never read by a person: `sourceWarnings` tests the column for
 * NULL and answers with a fixed sentence naming the source and nothing inside
 * it. Nothing else in the repo reads the column at all, which is what makes a
 * private mark in it free.
 */
export const SOURCE_ERROR_MARK = '\u0000[source] ';

/**
 * Mark every container this source already has as unreadable.
 *
 * The whole source is dark, and somebody searching has to be told:
 * `sourceWarnings` (`search-service.ts`) builds its warnings from
 * `search_sources.last_error` and from nothing else, so a failure recorded only
 * on the sweep result is one only the server log knows about. The stamp goes
 * onto the containers that already exist, never onto an invented one, so the
 * prune has nothing new to delete — and a source with no indexed containers yet
 * therefore has nowhere to record this at all.
 *
 * **It never overwrites a container's own error**, only a NULL or an older
 * source-level stamp. The specific message is the more useful one and the row is
 * non-null either way, so the warning is raised regardless — and leaving it
 * alone is what lets the clear at the end of a healthy pass tell the two apart.
 *
 * `last_indexed_at` advances with it, matching {@link stampAttempt}: the column
 * means the last ATTEMPT, and a discovery that failed is an attempt that was
 * made. Every mechanism's discovery failure goes through here, so all of them
 * answer "when did you last look" the same way.
 *
 * @param db - The database holding the index.
 * @param sourceId - Which source went dark.
 * @param message - What went wrong, as `search_sources.last_error` will carry it,
 *   behind {@link SOURCE_ERROR_MARK}.
 * @param at - The ISO-8601 timestamp of this attempt.
 */
export function stampSourceError(db: Db, sourceId: string, message: string, at: string): void {
  db.update(searchSources)
    .set({ lastError: `${SOURCE_ERROR_MARK}${message}`, lastIndexedAt: at })
    .where(
      and(
        eq(searchSources.sourceId, sourceId),
        or(isNull(searchSources.lastError), like(searchSources.lastError, `${SOURCE_ERROR_MARK}%`))
      )
    )
    .run();
}

/**
 * Retire this source's whole-source error stamp, because the source is readable
 * again.
 *
 * What it exists for is the containers a pass does not touch. A container that
 * indexes clears its own `last_error` in the same transaction that writes its
 * frontier row, but an unchanged container writes nothing at all — so after a
 * stamp from {@link stampSourceError}, one quiet container would carry a warning
 * for a fault that ended, every five minutes, forever.
 *
 * **It clears marked rows only** ({@link SOURCE_ERROR_MARK}), which is what keeps
 * it from erasing an error that belongs to a container rather than to the source.
 *
 * **`except` closes the remaining gap**, and it is a list of the containers that
 * failed THIS pass rather than a promise about the next one. An earlier version
 * cleared unconditionally and argued that a still-broken container would
 * re-stamp itself before anyone looked; that argument has a hole, because the
 * re-stamp is best effort ({@link tryWrite}) and a `SQLITE_BUSY` there left a
 * broken container reading `last_error = NULL` for a full sweep interval. Naming
 * the failures makes it true by construction rather than by argument.
 *
 * @param db - The database holding the index.
 * @param sourceId - Which source recovered.
 * @param except - Containers that failed this pass, whose rows are left exactly
 *   as they are.
 */
export function clearSourceError(db: Db, sourceId: string, except: readonly string[] = []): void {
  db.update(searchSources)
    .set({ lastError: null })
    .where(
      and(
        eq(searchSources.sourceId, sourceId),
        like(searchSources.lastError, `${SOURCE_ERROR_MARK}%`),
        except.length === 0 ? undefined : notInArray(searchSources.originKey, [...except])
      )
    )
    .run();
}

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
