/**
 * **M3** — reading OpenCode's SQLite store through a throwaway snapshot copy
 * (ADR 260825-110420, message-search spec §2.3 as amended).
 *
 * ## The one thing this module exists to guarantee
 *
 * `opencode.db` holds `account.access_token`, `account.refresh_token` and
 * `credential.value` in the same file as its messages. That is why ADR-0308 said
 * the store is "never read or written directly", and it is still the reason this
 * module is written the way it is rather than the reason it cannot exist: the
 * scoped read is safe **because of its structure, not because of a filter**.
 *
 * Three structural properties, each of which a reviewer can check without
 * reading any SQL:
 *
 * 1. **The live file is never opened.** Every sweep copies the store and its
 *    `-wal`/`-shm` siblings into a fresh temp directory and opens the COPY. The
 *    operator's file is touched by `copyFile` and by nothing else, so no
 *    connection DorkOS holds can write it, lock it, checkpoint it, or recover it
 *    — the WAL-mode reliability worries ADR-0308:37 records are answered by not
 *    being a participant.
 * 2. **The copy is opened read-only**, `readonly: true` plus `PRAGMA query_only`.
 *    Belt and braces on a file that is about to be deleted anyway.
 * 3. **Every statement is built from {@link OPENCODE_READ_ALLOWLIST}.** There is
 *    no raw SQL in this module that names a table directly; {@link buildAllowlistedSelect}
 *    throws on a table or column the allowlist does not carry, so reaching a
 *    credential column takes a deliberate edit to a frozen constant that a test
 *    pins by name. `SELECT *` cannot occur, because the column list is the
 *    allowlist.
 *
 * The snapshot is deleted when the sweep ends, in a `finally`.
 *
 * ## What it reads, and what an ordinal is here
 *
 * Sessions are containers; a session's messages, ordered `(time_created, id)`,
 * are its ordinals, numbered from 1. OpenCode's `message` table carries no
 * sequence column, so position IS the ordinal — which is exactly the shape M2's
 * watermark arithmetic already handles, including the case that makes positions
 * dangerous: a session that loses messages (an OpenCode revert) comes back with
 * a lower count, the index notices it holds ordinals the container no longer
 * has, and the container is re-read whole.
 *
 * **A count is the change signal, and a count alone is not enough.** OpenCode
 * does not write a turn once. It creates the assistant `message` row at turn
 * START and then streams `part` rows in underneath it, MUTATING them in place as
 * tokens arrive. Measured on the operator's store 2026-08-25: **236 of 236 parts
 * were created after their message row, 55 of 80 text parts were updated in
 * place after creation, 91 of 94 message rows were updated after creation, and
 * the last part of a turn landed up to 62 seconds after the message row.**
 *
 * So the count rises the moment a turn STARTS, and the content arrives for a
 * minute afterwards. A sweep landing in that window indexes a truncated body,
 * and — because the count never changes again — would serve that truncation
 * forever. Two more shapes have the same cause: a revert plus a new turn inside
 * one sweep interval leaves the count exactly where it was while the content is
 * different, and an in-place edit of a `part` changes no count at all.
 *
 * **The answer is {@link OPENCODE_VOLATILE_WINDOW_MS}: a session whose newest
 * `time_updated` is recent is re-read from ordinal 1, every sweep, until it goes
 * quiet.** Re-reading is free — the index upserts on
 * `(source, container, ordinal)`, so a re-read of unchanged content writes the
 * same rows — and the corpus is two orders of magnitude smaller than Claude
 * Code's. `Session.time.updated` is still not consulted: the spec's caveat about
 * it (stamped at turn start, so `updated > lastSeen` misses the assistant half)
 * is the reason this reads `message.time_updated` and `part.time_updated`
 * instead, which are stamped by the writes themselves.
 *
 * **Child sessions are not containers.** A session with a `parent_id` is a
 * subagent's own transcript — a conversation the human never had — and it is
 * excluded here for the same reason `claude-code-discovery.ts` walks past
 * `subagents/**`.
 *
 * @module server/services/search/opencode-store
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import { logger } from '../../lib/logger.js';
import { projectOpenCodeMessages, type OpenCodeMessageRow } from './projections/opencode.js';
import type { Projection, RowContainer } from './types.js';

/**
 * Every table this module may read, and every column it may read from each.
 *
 * **The security boundary is this constant.** It is not a denylist of credential
 * tables — a denylist is a list somebody has to remember to extend when upstream
 * adds `oauth_token_v2` — it is the complete set of what may be reached, and
 * {@link buildAllowlistedSelect} refuses anything outside it at the point the statement is
 * built rather than at review time.
 *
 * `sqlite_master` is here because schema detection has to read it, and it is
 * listed with the two columns that answer "does this table exist" and nothing
 * else. It carries DDL text in `sql`, which is not selected: an upstream
 * `CREATE TABLE account (... access_token ...)` string is not a token, but it is
 * also not something this index has any reason to hold.
 */
export const OPENCODE_READ_ALLOWLIST = Object.freeze({
  /** Containers: which conversations exist, where they ran, and which are children. */
  session: Object.freeze(['id', 'directory', 'parent_id'] as const),
  /**
   * The messages themselves. `data` is the message envelope — role and time.
   *
   * `time_updated` is here because OpenCode mutates a turn after creating it, so
   * it is the only honest signal that a message the index already holds may have
   * changed underneath it. It is a timestamp, not content.
   */
  message: Object.freeze(['id', 'session_id', 'time_created', 'time_updated', 'data'] as const),
  /**
   * The text. `data` is the part envelope — type, text, `ignored`, `synthetic`.
   *
   * `session_id` is denormalised onto `part` by OpenCode, which is what lets the
   * volatility scan read one table instead of joining two. `time_updated` is the
   * signal that matters most here: parts are where in-place mutation actually
   * happens.
   */
  part: Object.freeze(['id', 'message_id', 'session_id', 'time_updated', 'data'] as const),
  /** Schema detection only. Never a source of message content. */
  sqlite_master: Object.freeze(['type', 'name'] as const),
});

/**
 * The tables in `opencode.db` that hold secrets, named so a test can assert they
 * are absent from {@link OPENCODE_READ_ALLOWLIST}.
 *
 * Documentation with a test behind it, never a runtime filter. Nothing in this
 * module consults it — a filter that had to be *applied* would be one somebody
 * could forget to apply, which is the failure mode the allowlist replaces.
 */
export const OPENCODE_CREDENTIAL_TABLES = Object.freeze([
  'account',
  'account_state',
  'control_account',
  'credential',
  'session_share',
] as const);

/**
 * How many message ids go into one `IN (...)` when parts are fetched.
 *
 * SQLite caps a statement at 32,766 host parameters. 400 is far below that and
 * keeps the per-chunk result set small on a session whose messages carry many
 * parts.
 */
const PART_LOOKUP_CHUNK = 400;

/**
 * How recently a session must have been touched to be re-read from the start.
 *
 * Fifteen minutes — three times the reconciler's five-minute cadence. The margin
 * is what makes the guarantee hold rather than nearly hold: a mutation at time
 * `T` is first seen by a sweep somewhere in `T … T+5min`, and a window of two
 * intervals would put the sweep AFTER that one exactly on the boundary. Three
 * intervals means at least two sweeps observe every mutation, the second of them
 * strictly after the turn that caused it has finished streaming (the longest
 * observed stream on the operator's store was 62 seconds).
 *
 * `__tests__/opencode-source.test.ts` asserts this against
 * `SEARCH_RECONCILE_INTERVAL_MS`, so shortening either without the other is a red
 * test rather than a silent hole.
 *
 * **The cost is bounded by how much OpenCode you used in the last quarter hour**,
 * not by corpus size: quiet sessions are still resumed at their watermark and
 * cost nothing.
 */
export const OPENCODE_VOLATILE_WINDOW_MS = 900_000;

/**
 * SQL that must never appear in a {@link buildAllowlistedSelect} tail.
 *
 * The tail is raw text, which is the one seam in this module that could reach
 * past the allowlist: `WHERE (SELECT access_token FROM account) IS NOT NULL` is a
 * perfectly good `WHERE` clause and reads a credential column. Rejecting the
 * keywords that can introduce another table makes the module doc's claim — no
 * statement here names a table outside the allowlist — true rather than
 * conventional. Every shipped tail is a `WHERE`/`ORDER BY`/`LIMIT` over columns
 * already selected, so nothing legitimate is excluded.
 */
const FORBIDDEN_IN_TAIL = /\b(from|join|select|union|attach|pragma|with)\b/i;

/** A table name the allowlist carries. */
type AllowedTable = keyof typeof OPENCODE_READ_ALLOWLIST;

/**
 * An open, read-only view of one snapshot of OpenCode's store.
 *
 * Handed to the sweep for the length of one pass and closed in a `finally`.
 * Closing deletes the snapshot directory, so a reader is single-use.
 */
export interface OpenCodeSnapshot {
  /** Where the copy lives. Always under {@link os.tmpdir}, never the live store. */
  readonly snapshotPath: string;

  /**
   * What SQLite said when this connection was asked to write, at open time.
   *
   * Non-empty by construction — {@link assertReadOnly} refuses to hand back a
   * connection that accepted the probe — so this is evidence rather than a flag.
   * A test reads it, and the seeded-defect protocol for this module is to delete
   * `readonly: true` or `PRAGMA query_only` and watch the open throw.
   */
  readonly writeRefusal: string;

  /** Every top-level session, with its message count as the high-water ordinal. */
  listContainers(): RowContainer[];

  /**
   * One session's messages above `afterOrdinal`, already projected.
   *
   * @param originKey - The OpenCode session id.
   * @param afterOrdinal - Read messages at positions above this. `0` reads all.
   */
  readSince(originKey: string, afterOrdinal: number): Projection;

  /** Close the connection and remove the snapshot from disk. Idempotent. */
  close(): void;
}

/**
 * A `SELECT` over allowlisted columns of an allowlisted table.
 *
 * The only way this module produces SQL that names a table, and therefore the
 * security primitive the whole design rests on — which is why it is exported:
 * a boundary nobody can call directly is a boundary nobody can test directly.
 *
 * It throws rather than returning a narrowed statement, because a read that
 * silently dropped a column would produce rows with missing fields and look like
 * a schema drift somewhere else entirely.
 *
 * @param table - Must be a key of {@link OPENCODE_READ_ALLOWLIST}.
 * @param columns - Must all be listed for that table.
 * @param tail - `WHERE`, `ORDER BY` and `LIMIT` over columns already selected.
 *   It may not name a table: {@link FORBIDDEN_IN_TAIL} rejects the keywords that
 *   could introduce one, so a subquery cannot smuggle a credential column in
 *   through a clause the column check never looks at. The call sites that need a
 *   second table run this helper twice and join in JavaScript.
 * @returns The statement text.
 */
export function buildAllowlistedSelect(
  table: AllowedTable,
  columns: readonly string[],
  tail: string
): string {
  const allowed: readonly string[] = OPENCODE_READ_ALLOWLIST[table];
  for (const column of columns) {
    if (!allowed.includes(column)) {
      throw new Error(
        `search/opencode: '${table}.${column}' is not in the read allowlist. ` +
          'Widening it is a security decision — see ADR 260825-110420.'
      );
    }
  }
  if (FORBIDDEN_IN_TAIL.test(tail)) {
    throw new Error(
      `search/opencode: a query tail may not name another table (got: ${tail.trim()}). ` +
        'Read the second table with a second call and join in JavaScript — ' +
        'see ADR 260825-110420.'
    );
  }
  return `SELECT ${columns.join(', ')} FROM ${table} ${tail}`;
}

/** One row of `message`, as {@link buildAllowlistedSelect} returns it. */
interface MessageRow {
  id: string;
  time_created: number;
  data: string;
}

/** One row of `part`, as {@link buildAllowlistedSelect} returns it. */
interface PartRow {
  message_id: string;
  data: string;
}

/**
 * Copy the store and its WAL siblings into a fresh temp directory.
 *
 * All three files, and the `-wal` matters most: OpenCode runs the store in WAL
 * mode, so the newest messages are in the log rather than the main file, and a
 * copy of `opencode.db` alone is a copy of the conversation as it stood at the
 * last checkpoint. The `-shm` is copied so the read-only connection can replay
 * the log without needing to create shared memory beside a file it may not
 * write.
 *
 * A missing sibling is normal (a checkpointed store has none) and is skipped.
 *
 * @param storePath - The live store. Read, never opened.
 * @returns The directory holding the copy, and the copy's own path.
 */
function copyStore(storePath: string): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-opencode-snapshot-'));
  const dbPath = path.join(dir, 'opencode.db');
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.copyFileSync(`${storePath}${suffix}`, `${dbPath}${suffix}`);
      } catch (err) {
        // The main file not being there is fatal and is re-thrown; a sibling not
        // being there is the ordinary state of a checkpointed store.
        if (suffix === '') throw err;
      }
    }
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return { dir, dbPath };
}

/**
 * Prove the connection cannot write, and return SQLite's own refusal.
 *
 * Two independent guarantees, checked independently because each catches a
 * different edit. `db.readonly` reports the open flag, so deleting
 * `readonly: true` reds here even though `PRAGMA query_only` would still refuse
 * the write. The probe catches the case where BOTH are gone, which is the state
 * that actually lets DorkOS modify a database.
 *
 * The probe is a `CREATE TABLE` of a DorkOS-named table rather than an `UPDATE`
 * of an OpenCode one: it touches nothing that exists, so on the impossible path
 * where it succeeds the damage is a stray table in a temp file that is deleted
 * seconds later — and we throw immediately rather than reading through a
 * connection that has just proven it is writable.
 *
 * @param db - The freshly opened snapshot connection.
 * @returns The message SQLite raised when refusing the write.
 * @throws When the connection is writable by either measure.
 */
function assertReadOnly(db: SqliteDatabase): string {
  if (!db.readonly) {
    throw new Error('the OpenCode snapshot was not opened read-only — refusing to read through it');
  }
  try {
    db.prepare('CREATE TABLE dorkos_write_probe (x)').run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error(
    'the OpenCode snapshot connection accepted a write — refusing to read through it'
  );
}

/**
 * Fail unless the copy is structurally intact — and fail HERE, where the sweep
 * can attribute it.
 *
 * **This does not exist to catch a torn copy that lies.** An earlier version of
 * this comment said it did, and that was measured and found false: four tear
 * shapes were probed against a valid database — two zeroed interior pages, a
 * truncation to 60%, and a page of garbage — and **every one of them threw
 * `SQLITE_CORRUPT` on the first real `SELECT`.** None opened cleanly and returned
 * a short session list. (A bare `SELECT COUNT(*)` can still answer from a page
 * that survived, which is what made the earlier claim look true; the statement
 * this source actually runs does not.)
 *
 * **What it exists for is WHERE that throw lands.** {@link OpenCodeSnapshot.listContainers}
 * is called at the top of `sweepContainers`, and a corrupt copy raises there
 * rather than against any one container. Since DOR-709 that is caught and
 * attributed — the sweep records a `(discovery)` failure for this source, prunes
 * nothing, and carries on — so this check is no longer what stands between a bad
 * copy and a process-wide abort. What it still buys is the honest attribution:
 * a copy that will not open is `(snapshot)`, reported before a reader exists,
 * rather than a schema complaint arriving one layer later.
 *
 * `quick_check` is the cheap half of `integrity_check` — page structure, no
 * index-vs-table cross-check — and costs single-digit milliseconds on a 1.4 MB
 * store.
 *
 * **The shape it does NOT defend against is staleness, not corruption**: the
 * three files are copied one after another, so a checkpoint landing between them
 * yields an old main file beside a truncated WAL. That copy is perfectly valid
 * and simply describes an earlier moment — `quick_check` passes it, and it can
 * carry a SHORT session list. `SNAPSHOT_MIN_LIVE_SHARE` (`snapshot-frontier.ts`)
 * is what stands between that and a prune.
 */
function assertIntact(db: SqliteDatabase): void {
  // It reports corruption BOTH ways, which is why this catches as well as
  // compares: a page SQLite cannot even parse raises `SQLITE_CORRUPT` out of the
  // pragma, while a structure it can parse and disagrees with comes back as a
  // row of complaints. Measured: zeroing one interior page of a valid database
  // throws "database disk image is malformed" — and `SELECT COUNT(*)` over that
  // same file still answers, with a number, cheerfully. That is the exact shape
  // this guard exists for.
  let verdict: string;
  try {
    const result = db.pragma('quick_check') as { quick_check: string }[];
    verdict = result[0]?.quick_check ?? 'no answer';
  } catch (err) {
    verdict = err instanceof Error ? err.message : String(err);
  }
  if (verdict !== 'ok') {
    throw new Error(
      `the OpenCode store snapshot did not survive the copy (quick_check: ${verdict})`
    );
  }
}

/**
 * Fail unless the snapshot has the tables and columns this module reads.
 *
 * Checked once per sweep rather than defended at every read, because the two
 * failures are different: a store whose schema has moved underneath us should
 * stop and say so (one recorded failure, nothing pruned, the existing index left
 * intact), while a single unreadable ROW should be skipped and counted. Guessing
 * per-row at a table that is not there would turn the first into hundreds of the
 * second.
 *
 * `sqlite_master` is excluded from the check — reading it IS the check.
 */
function assertSchema(db: SqliteDatabase): void {
  const tables = new Set(
    db
      .prepare(buildAllowlistedSelect('sqlite_master', ['name'], "WHERE type = 'table'"))
      .all()
      .map((row) => (row as { name: string }).name)
  );

  for (const [table, columns] of Object.entries(OPENCODE_READ_ALLOWLIST)) {
    if (table === 'sqlite_master') continue;
    if (!tables.has(table)) {
      throw new Error(`the OpenCode store has no '${table}' table — its schema has changed`);
    }
    // `PRAGMA table_info` is schema metadata, not data: it names columns and
    // returns no row of any table. It cannot reach a credential value, which is
    // why it is not (and need not be) expressible through `buildAllowlistedSelect`.
    const columnInfo = db.pragma(`table_info(${table})`) as { name: string }[];
    const present = new Set(columnInfo.map((row) => row.name));
    for (const column of columns) {
      if (!present.has(column)) {
        throw new Error(
          `the OpenCode store's '${table}' table has no '${column}' column — its schema has changed`
        );
      }
    }
  }
}

/**
 * Snapshot OpenCode's store and open the copy for reading.
 *
 * @param storePath - The live store's path, from
 *   `resolveOpenCodeStorePath()`. Never opened by this function.
 * @param options - Test seams, both about the volatility window. `now` replaces
 *   the wall clock so a fixture can stage a session as streaming or as long
 *   finished; `volatileWindowMs` shortens the window. Production passes neither.
 * @returns A reader, or `null` when there is no store at that path — OpenCode
 *   may simply never have run on this machine, which is not a failure and must
 *   never be reported as one.
 * @throws When the store exists and cannot be copied, opened, recognised, or
 *   proven read-only and intact. The sweep records that and prunes nothing.
 */
export function openOpenCodeSnapshot(
  storePath: string,
  options: { now?: () => number; volatileWindowMs?: number } = {}
): OpenCodeSnapshot | null {
  if (!fs.existsSync(storePath)) return null;
  const now = options.now ?? Date.now;
  const volatileWindowMs = options.volatileWindowMs ?? OPENCODE_VOLATILE_WINDOW_MS;

  const { dir, dbPath } = copyStore(storePath);
  let db: SqliteDatabase;
  let writeRefusal: string;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // `readonly` already opened the file `SQLITE_OPEN_READONLY`; this refuses a
    // write at the statement layer too. Two independent refusals on a file that
    // is deleted minutes later is cheap insurance on the one property this whole
    // module is for — and neither is taken on trust: `assertReadOnly` makes the
    // connection prove it.
    db.pragma('query_only = 1');
    writeRefusal = assertReadOnly(db);
    assertIntact(db);
    assertSchema(db);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  let closed = false;
  return {
    snapshotPath: dbPath,
    writeRefusal,

    listContainers(): RowContainer[] {
      // Three allowlisted selects rather than one joined statement, because a
      // join would have to name the second table in `tail` — which the allowlist
      // now refuses outright, and which was the whole guarantee even before it
      // did. Counting and max-ing in JavaScript costs one pass over a corpus two
      // orders of magnitude smaller than Claude Code's, inside a sweep that has
      // already copied the entire file.
      const sessions = db
        .prepare(
          buildAllowlistedSelect(
            'session',
            ['id', 'directory'],
            'WHERE parent_id IS NULL ORDER BY id'
          )
        )
        .all() as { id: string; directory: string | null }[];

      const counts = new Map<string, number>();
      const touched = new Map<string, number>();
      const touch = (sessionId: string, at: unknown): void => {
        if (typeof at !== 'number' || !Number.isFinite(at)) return;
        const seen = touched.get(sessionId);
        if (seen === undefined || at > seen) touched.set(sessionId, at);
      };

      for (const row of db
        .prepare(buildAllowlistedSelect('message', ['session_id', 'time_updated'], ''))
        .all() as { session_id: string; time_updated: number }[]) {
        counts.set(row.session_id, (counts.get(row.session_id) ?? 0) + 1);
        touch(row.session_id, row.time_updated);
      }

      // Parts carry `session_id` themselves, so the mutation signal that matters
      // most — a `part` rewritten in place while a turn streams — is one scan
      // rather than a join back through `message`.
      for (const row of db
        .prepare(buildAllowlistedSelect('part', ['session_id', 'time_updated'], ''))
        .all() as { session_id: string; time_updated: number }[]) {
        touch(row.session_id, row.time_updated);
      }

      const cutoff = now() - volatileWindowMs;
      return sessions.map((session) => ({
        originKey: session.id,
        // OpenCode records the directory a session ran in, so unlike a room, an
        // OpenCode hit HAS somewhere to open. An empty string is not a
        // directory and becomes `null` rather than a path that resolves to cwd.
        containerPath:
          typeof session.directory === 'string' && session.directory !== ''
            ? session.directory
            : null,
        maxOrdinal: counts.get(session.id) ?? 0,
        // The count says how many messages exist; it says nothing about whether
        // the ones already indexed still say what they said. For a session
        // OpenCode has touched recently, the honest answer is "assume not" —
        // see the module doc's measurements.
        rereadWhole: (touched.get(session.id) ?? 0) >= cutoff,
      }));
    },

    readSince(originKey: string, afterOrdinal: number): Projection {
      // `LIMIT -1 OFFSET n` is SQLite's spelling of "everything after the first
      // n rows". The ordering matches `message_session_time_created_id_idx`, so
      // the skip is an index walk rather than a sort, and it is stated in full
      // rather than inherited from that index — a contract that holds only
      // because of the shape of somebody else's index is one nobody can safely
      // change.
      const rows = db
        .prepare(
          buildAllowlistedSelect(
            'message',
            ['id', 'time_created', 'data'],
            'WHERE session_id = ? ORDER BY time_created ASC, id ASC LIMIT -1 OFFSET ?'
          )
        )
        .all(originKey, Math.max(0, afterOrdinal)) as MessageRow[];

      const parts = readParts(
        db,
        rows.map((row) => row.id)
      );

      const messages: OpenCodeMessageRow[] = rows.map((row, index) => ({
        // Position IS the ordinal, numbered from 1 and continuing past the
        // offset the caller resumed at.
        ordinal: Math.max(0, afterOrdinal) + index + 1,
        id: row.id,
        timeCreated: row.time_created,
        data: row.data,
        parts: parts.get(row.id) ?? [],
      }));

      return projectOpenCodeMessages(originKey, messages);
    },

    close(): void {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch (err) {
        // A close that fails still has to be followed by the delete, or the
        // snapshot leaks. Logged rather than thrown for the same reason.
        logger.warn('[Search] the OpenCode snapshot would not close', err);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Every part belonging to the given messages, keyed by message id and in part
 * order.
 *
 * @param db - The open snapshot.
 * @param messageIds - The messages just read, in file order.
 * @returns One entry per message that has at least one part.
 */
function readParts(db: SqliteDatabase, messageIds: readonly string[]): Map<string, string[]> {
  const byMessage = new Map<string, string[]>();
  for (let start = 0; start < messageIds.length; start += PART_LOOKUP_CHUNK) {
    const chunk = messageIds.slice(start, start + PART_LOOKUP_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(
        buildAllowlistedSelect(
          'part',
          ['message_id', 'data'],
          `WHERE message_id IN (${placeholders}) ORDER BY message_id ASC, id ASC`
        )
      )
      .all(...chunk) as PartRow[];
    for (const row of rows) {
      const existing = byMessage.get(row.message_id);
      if (existing) existing.push(row.data);
      else byMessage.set(row.message_id, [row.data]);
    }
  }
  return byMessage;
}
