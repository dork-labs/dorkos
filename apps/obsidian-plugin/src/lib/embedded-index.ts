/**
 * The message index, opened from inside Obsidian (DOR-1563, message-search task
 * 5.3).
 *
 * `createEmbeddedSearch` has always said what a host must provide — an open
 * database and the rooms domain over it. This is the plugin providing them. It
 * is the only thing standing between `DirectTransport.search` and the same rows
 * `GET /api/search` reads, and it decides one question: whether this machine has
 * an index worth offering a search box for.
 *
 * ## A reader, and only a reader
 *
 * `~/.dork/dork.db` belongs to whoever installed DorkOS, and DorkOS may be
 * running right now. So this opens it **read-only**: it creates nothing,
 * migrates nothing, and indexes nothing. Search here answers out of whatever the
 * DorkOS app has already indexed (ADR 260825-194924).
 *
 * **That is a smaller promise than the server makes, and it is deliberate.** A
 * sweep is not a cheap read — it walks every transcript on the machine and
 * writes rows — and `better-sqlite3` is synchronous, so in Obsidian's renderer
 * that work happens on the thread painting the vault. A cold first sweep over a
 * large history would freeze the window. Making the embed a second writer to a
 * live database would also mean two programs on different DorkOS versions
 * writing the same index. Neither is worth carrying to read your own history,
 * so the embed's staleness is stated in the search box instead of engineered
 * away.
 *
 * **A reader still sees the newest rows.** SQLite's WAL is read by readers too,
 * so a message DorkOS indexed a second ago is visible here without a
 * checkpoint — what is missing is only what nothing has indexed yet.
 *
 * @module obsidian-plugin/lib/embedded-index
 */
import path from 'path';
import { openReadOnlyDb, type Db } from '@dorkos/db';
import { attachAccountReader, detachAccountReader } from '@dorkos/server/services/core/auth';
import { createRoomSubsystem } from '@dorkos/server/services/rooms';
import { createEmbeddedSearch, type EmbeddedSearch } from '@dorkos/server/services/search';

/**
 * The tables a search needs to be able to answer at all.
 *
 * Checked instead of a migration version, because a version is a claim about
 * what ran and this is a question about what is there. A database from a DorkOS
 * old enough to predate message search has the rooms and none of the index, and
 * would fail on the first query with a SQL error rather than a sentence.
 */
const REQUIRED_TABLES = [
  'messages',
  'messages_fts',
  'search_sources',
  'rooms',
  'room_entries',
  'room_members',
  'authors',
] as const;

/** An open index, and the way to let go of it. */
export interface EmbeddedIndex {
  /** The seam `DirectTransport` is handed. */
  search: EmbeddedSearch;
  /** Close the database and release the account reader. Safe to call twice. */
  close(): void;
}

/**
 * Open this machine's message index, or decide there is nothing to open.
 *
 * **Every failure returns `null`, and the whole open is inside one guard.** The
 * plugin's other half — sessions, the composer, the file context — has nothing
 * to do with search, so nothing here may take the panel down with it. That is
 * not a claim about which line can throw: it covers opening the database,
 * reading its table list, standing up the rooms domain and building the seam,
 * because a host that guarded only the line somebody thought was risky is how
 * this contract gets broken. It was broken exactly that way once — an
 * unguarded `unref()` on a timer, in a renderer whose `setInterval` is not
 * Node's, blanked the entire panel on every machine that had a database.
 *
 * @param dorkHome - The resolved DorkOS data directory, from
 *   `resolvePluginDorkHome()`.
 * @returns The seam and its teardown, or `null` when this machine has no index.
 */
export function openEmbeddedIndex(dorkHome: string): EmbeddedIndex | null {
  const dbPath = path.join(dorkHome, 'dork.db');
  let db: Db | undefined;

  try {
    // `openReadOnlyDb` refuses a path that is not already a database rather than
    // creating one, so "is there an index here" is answered by opening it — with
    // no `existsSync` in front, which would be a check with a gap after it.
    db = openReadOnlyDb(dbPath);

    const missing = missingTables(db);
    if (missing.length > 0) {
      db.$client.close();
      console.warn(
        `[DorkOS] The DorkOS database is older than message search (missing ${missing.join(', ')}) — ` +
          'search is off until DorkOS itself has run and brought it up to date.'
      );
      return null;
    }

    // Who owns this install, read from the database rather than assumed. Without
    // this the embed reads as the owner of every install, including one with
    // Require login turned on that it has not signed in to.
    attachAccountReader(db);
    const rooms = createRoomSubsystem({ db, readOnly: true });
    const search = createEmbeddedSearch({ db, rooms: rooms.service });

    let closed = false;
    const handle = db;
    return {
      search,
      close(): void {
        if (closed) return;
        closed = true;
        // Order matters: the account reader holds this exact handle, and a
        // reader left pointing at a closed database throws on the next question
        // anybody asks it.
        detachAccountReader();
        handle.$client.close();
      },
    };
  } catch (err) {
    db?.$client.close();
    detachAccountReader();
    console.warn(
      `[DorkOS] Could not open the message index at ${dbPath} — searching your history is off. ` +
        'Everything else in this panel works. ' +
        String(err)
    );
    return null;
  }
}

/**
 * Which of {@link REQUIRED_TABLES} this database does not have.
 *
 * @param db - The open database.
 * @returns The missing names, empty when the index is present.
 */
function missingTables(db: Db): string[] {
  const present = new Set(
    (
      db.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((row) => row.name)
  );
  return REQUIRED_TABLES.filter((table) => !present.has(table));
}
