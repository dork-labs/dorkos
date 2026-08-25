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
 *    no raw SQL in this module that names a table directly; {@link selectFrom}
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
 * **This is why `Session.time.updated` is not the change signal**, and the
 * caveat the spec insisted be written down before anyone polls is therefore
 * moot: OpenCode stamps that column at turn START, not on message write, so
 * `updated > lastSeen` misses the assistant half of every in-flight turn. A
 * count of rows cannot miss it — the assistant message either exists or it does
 * not, and when it appears the count goes up. Re-reading a message twice is a
 * no-op regardless: the index upserts on `(source, container, ordinal)`.
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
 * {@link selectFrom} refuses anything outside it at the point the statement is
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
  /** The messages themselves. `data` is the message envelope — role and time. */
  message: Object.freeze(['id', 'session_id', 'time_created', 'data'] as const),
  /** The text. `data` is the part envelope — type, text, `ignored`, `synthetic`. */
  part: Object.freeze(['id', 'message_id', 'data'] as const),
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
 * The only way this module produces SQL that names a table. It throws rather
 * than returning a narrowed statement, because a read that silently dropped a
 * column would produce rows with missing fields and look like a schema drift
 * somewhere else entirely.
 *
 * @param table - Must be a key of {@link OPENCODE_READ_ALLOWLIST}.
 * @param columns - Must all be listed for that table.
 * @param tail - Everything after the `FROM` clause: `WHERE`, `ORDER BY`, joins
 *   onto already-selected columns. It never names a table, because the caller
 *   would have to write one, and the two call sites that need a join build it
 *   from this helper twice instead.
 * @returns The statement text.
 */
function selectFrom(table: AllowedTable, columns: readonly string[], tail: string): string {
  const allowed: readonly string[] = OPENCODE_READ_ALLOWLIST[table];
  for (const column of columns) {
    if (!allowed.includes(column)) {
      throw new Error(
        `search/opencode: '${table}.${column}' is not in the read allowlist. ` +
          'Widening it is a security decision — see ADR 260825-110420.'
      );
    }
  }
  return `SELECT ${columns.join(', ')} FROM ${table} ${tail}`;
}

/** One row of `message`, as {@link selectFrom} returns it. */
interface MessageRow {
  id: string;
  time_created: number;
  data: string;
}

/** One row of `part`, as {@link selectFrom} returns it. */
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
      .prepare(selectFrom('sqlite_master', ['name'], "WHERE type = 'table'"))
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
    // why it is not (and need not be) expressible through `selectFrom`.
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
 * @returns A reader, or `null` when there is no store at that path — OpenCode
 *   may simply never have run on this machine, which is not a failure and must
 *   never be reported as one.
 * @throws When the store exists and cannot be copied, opened, or recognised. The
 *   sweep records that and prunes nothing.
 */
export function openOpenCodeSnapshot(storePath: string): OpenCodeSnapshot | null {
  if (!fs.existsSync(storePath)) return null;

  const { dir, dbPath } = copyStore(storePath);
  let db: SqliteDatabase;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // `readonly` already opened the file `SQLITE_OPEN_READONLY`; this refuses a
    // write at the statement layer too. Two independent refusals on a file that
    // is deleted minutes later is cheap insurance on the one property this whole
    // module is for.
    db.pragma('query_only = 1');
    assertSchema(db);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  let closed = false;
  return {
    snapshotPath: dbPath,

    listContainers(): RowContainer[] {
      // Two allowlisted selects rather than one joined statement, because a join
      // would have to name the second table in `tail` — outside `selectFrom`'s
      // check, which is the whole guarantee. Counting in JS costs one pass over
      // a corpus measured in tens of thousands of rows at the outside.
      const sessions = db
        .prepare(selectFrom('session', ['id', 'directory'], 'WHERE parent_id IS NULL ORDER BY id'))
        .all() as { id: string; directory: string | null }[];

      const counts = new Map<string, number>();
      for (const row of db.prepare(selectFrom('message', ['session_id'], '')).all() as {
        session_id: string;
      }[]) {
        counts.set(row.session_id, (counts.get(row.session_id) ?? 0) + 1);
      }

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
          selectFrom(
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
        selectFrom(
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
