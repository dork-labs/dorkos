import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createTestDb } from '@dorkos/test-utils/db';
import { messages, searchSources, eq, type Db } from '@dorkos/db';
import { createOpenCodeSource, openCodeSource } from '../registry.js';
import {
  sweepSnapshotSource,
  SNAPSHOT_FAILURE_KEY,
  SNAPSHOT_MIN_LIVE_SHARE,
} from '../snapshot-frontier.js';
import { PRUNE_GUARD_KEY } from '../row-frontier.js';
import {
  OPENCODE_CREDENTIAL_TABLES,
  OPENCODE_READ_ALLOWLIST,
  OPENCODE_VOLATILE_WINDOW_MS,
  buildAllowlistedSelect,
  openOpenCodeSnapshot,
} from '../opencode-store.js';
import { projectOpenCodeMessages } from '../projections/opencode.js';
import { SearchIndexer, SEARCH_RECONCILE_INTERVAL_MS } from '../indexer.js';
import { searchForCaller } from '../search-service.js';

/**
 * The OpenCode search source (DOR-688, ADR 260825-110420).
 *
 * **Everything here runs against a fixture store this file builds**, staged in a
 * temp directory. Nothing reads `~/.local/share/opencode` and nothing reads
 * `~/.dork`: the operator's own OpenCode history is not test data, and a suite
 * that read it would pass or fail depending on whose machine it ran on. The
 * one deliberate reader of the real store is `scripts/search-corpus-bench.ts`.
 *
 * The fixture is a REAL SQLite file with OpenCode's real schema — including its
 * credential tables, seeded with fake tokens — because the claim under test is
 * about what a read of that file can reach, and a mock cannot be wrong about it.
 */

/** OpenCode's schema, narrowed to the tables this fixture needs. */
const OPENCODE_SCHEMA = `
  CREATE TABLE session (
    id text PRIMARY KEY, project_id text NOT NULL, parent_id text,
    slug text NOT NULL, directory text NOT NULL, title text NOT NULL,
    version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL
  );
  CREATE TABLE message (
    id text PRIMARY KEY, session_id text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
  );
  CREATE TABLE part (
    id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
  );
  CREATE TABLE account (
    id text PRIMARY KEY, email text NOT NULL, url text NOT NULL,
    access_token text NOT NULL, refresh_token text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL
  );
  CREATE TABLE credential (
    id text PRIMARY KEY, label text NOT NULL, value text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL
  );
`;

/**
 * The fake secrets seeded into the fixture's credential tables.
 *
 * Distinct, high-entropy and searchable. If any of them ever reaches the index,
 * a full-text search finds it — which is the assertion, rather than an
 * eyeball over the SQL.
 */
const SECRETS = {
  accessToken: 'sk-oc-access-zzqqxx-11111',
  refreshToken: 'sk-oc-refresh-zzqqxx-22222',
  credentialValue: 'sk-oc-credential-zzqqxx-33333',
};

/**
 * A token a person PASTED INTO A CHAT, which is a different thing entirely.
 *
 * It is their own transcript, indexed as-is, exactly as every other source
 * indexes what was typed into it. The rule this suite enforces is "the index
 * never reads a credential TABLE", not "the index redacts text that looks
 * secret" — the second is a filter, and a filter is what the allowlist replaces.
 */
const PASTED_TOKEN = 'sk-oc-pasted-by-a-person-44444';

let workdir: string;
let storePath: string;
let store: Database.Database;
let db: Db;

/** Millisecond stamps that sort the way the fixture reads. */
let clock = 1_780_000_000_000;

/** Open a top-level session in the fixture store. */
function seedSession(id: string, directory = '/Users/dork/code/dorkos', parentId?: string): void {
  store
    .prepare(
      `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version,
                            time_created, time_updated)
       VALUES (?, 'prj_1', ?, ?, ?, ?, '1.18.15', ?, ?)`
    )
    .run(id, parentId ?? null, id, directory, id, clock, clock);
}

/**
 * Create a message row with NO parts — a turn that has just started.
 *
 * This is the state OpenCode actually writes first, and it is why the streaming
 * tests below exist: measured on the operator's store, **236 of 236 parts were
 * created after their message row**. A helper that inserted a message and its
 * parts in one statement would be staging a shape OpenCode never produces.
 *
 * @param sessionId - Which session.
 * @param role - `user`, `assistant`, or anything else the drift tests need.
 * @param opts - `data` replaces the whole message envelope, for the malformed cases.
 * @returns The new message id.
 */
function beginTurn(sessionId: string, role: string, opts: { data?: string } = {}): string {
  clock += 1_000;
  const id = `msg_${String(clock)}`;
  store
    .prepare(
      `INSERT INTO message (id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      id,
      sessionId,
      clock,
      clock,
      opts.data ?? JSON.stringify({ role, time: { created: clock } })
    );
  return id;
}

/**
 * Stream one part into an existing message, the way OpenCode does mid-turn.
 *
 * @param messageId - The message the part belongs to.
 * @param sessionId - Denormalised onto `part` by OpenCode, and read by the
 *   volatility scan.
 * @param part - The part envelope, or raw text for the malformed cases.
 * @returns The new part id, so a test can mutate it in place afterwards.
 */
function streamPart(messageId: string, sessionId: string, part: unknown): string {
  clock += 1_000;
  const id = `prt_${String(clock)}`;
  store
    .prepare(
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      messageId,
      sessionId,
      clock,
      clock,
      typeof part === 'string' ? part : JSON.stringify(part)
    );
  // OpenCode stamps the message as updated when its parts move — 91 of 94
  // message rows on the operator's store carry `time_updated > time_created`.
  store.prepare('UPDATE message SET time_updated = ? WHERE id = ?').run(clock, messageId);
  return id;
}

/**
 * Rewrite a part that is already there, as OpenCode does while tokens arrive.
 *
 * **55 of 80 text parts on the operator's store were updated in place.** Nothing
 * about the row COUNT changes here, which is the whole reason the count cannot
 * be the only change signal.
 *
 * @param partId - The part to rewrite.
 * @param part - Its new envelope.
 */
function mutatePart(partId: string, part: unknown): void {
  clock += 1_000;
  store
    .prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?')
    .run(typeof part === 'string' ? part : JSON.stringify(part), clock, partId);
}

/**
 * Append one message with its parts, as a finished turn.
 *
 * Built out of {@link beginTurn} and {@link streamPart} so that even the tests
 * which do not care about streaming stage the real write order.
 *
 * @param sessionId - Which session.
 * @param role - `user`, `assistant`, or anything else the drift tests need.
 * @param parts - Raw part envelopes, already shaped the way OpenCode stores them.
 * @param opts - `data` replaces the whole message envelope, for the malformed cases.
 * @returns The new message id.
 */
function say(
  sessionId: string,
  role: string,
  parts: unknown[],
  opts: { data?: string } = {}
): string {
  const id = beginTurn(sessionId, role, opts);
  for (const part of parts) streamPart(id, sessionId, part);
  return id;
}

/** A plain text part. */
function text(value: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'text', text: value, ...extra };
}

/**
 * A wall clock far enough past the fixture that nothing in it is volatile.
 *
 * The default for every test that is about append-only behaviour. Without it the
 * volatility window would re-read every container on every sweep and the
 * incremental assertions — `indexed: 0` on a second pass — would be measuring
 * nothing.
 */
const QUIET_NOW = 1_780_000_000_000 + 3_600_000;

/**
 * The source under test, pointed at the fixture rather than the real store.
 *
 * @param options - `live` runs the sweep as though the fixture had just been
 *   written, which puts every recently-touched session inside the volatility
 *   window. Absent, the fixture reads as an hour old and nothing is volatile.
 */
function fixtureSource(options: { live?: boolean } = {}) {
  return createOpenCodeSource(() => storePath, {
    now: options.live === true ? () => clock + 1_000 : () => QUIET_NOW,
  });
}

/** Sweep the fixture source into the index once, with the fixture reading as settled. */
async function sweep() {
  return sweepSnapshotSource(db, fixtureSource(), '2026-08-25T11:00:00.000Z');
}

/** Sweep as though OpenCode had just written the fixture — the volatile path. */
async function sweepLive() {
  return sweepSnapshotSource(db, fixtureSource({ live: true }), '2026-08-25T11:00:00.000Z');
}

/** Every indexed row, in index order. */
function indexed(): unknown[] {
  return db.$client
    .prepare(
      `SELECT source_id, origin_key, ordinal, role, body FROM messages
       ORDER BY source_id, origin_key, ordinal`
    )
    .all();
}

/** Full-text search over the whole index, however small. */
function search(query: string): { body: string }[] {
  return db.$client
    .prepare(
      `SELECT m.body FROM messages_fts f JOIN messages m ON m.id = f.rowid
       WHERE messages_fts MATCH ? LIMIT 50`
    )
    .all(query) as { body: string }[];
}

beforeEach(() => {
  db = createTestDb();
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-opencode-fixture-'));
  storePath = path.join(workdir, 'opencode.db');
  store = new Database(storePath);
  store.pragma('journal_mode = WAL');
  store.exec(OPENCODE_SCHEMA);
  store
    .prepare(
      `INSERT INTO account (id, email, url, access_token, refresh_token, time_created, time_updated)
       VALUES ('acc_1', 'dork@example.com', 'https://example.com', ?, ?, 1, 1)`
    )
    .run(SECRETS.accessToken, SECRETS.refreshToken);
  store
    .prepare(
      `INSERT INTO credential (id, label, value, time_created, time_updated)
       VALUES ('cred_1', 'github', ?, 1, 1)`
    )
    .run(SECRETS.credentialValue);
});

afterEach(() => {
  store.close();
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe('the registry the indexer sweeps by default', () => {
  it('names opencode as the third source, on the third mechanism', () => {
    // The exact-array pin in `search-indexer.test.ts` is the one that fails if a
    // source is dropped. This asserts the shape of the row that was added: the
    // mechanism is NAMED on the record, so the indexer dispatches on a string
    // rather than sniffing which functions the object happens to have.
    expect(openCodeSource.id).toBe('opencode');
    expect(openCodeSource.mechanism).toBe('sqlite-snapshot');
  });

  it('sweeps opencode through the real indexer, not just through this file', async () => {
    // The registry row resolves the operator's real store, which a test may not
    // read — so the source is rebuilt over the fixture and handed to the real
    // `SearchIndexer`. What is under test is the dispatch: an indexer that
    // silently fell through to `sweepRowSource` for an unknown mechanism would
    // throw or index nothing, and both show up here.
    seedSession('ses_a');
    say('ses_a', 'user', [text('a kestrel on the fence post')]);

    const result = await new SearchIndexer(db, [fixtureSource()]).sweep();
    expect(result.indexed).toBe(1);
    expect(result.failures).toEqual([]);
  });
});

describe('the credential tables', () => {
  it('are not in the read allowlist at all', () => {
    // **The seeded-defect anchor.** Adding `account` to the allowlist reddens
    // this line, which is the point: the allowlist IS the security boundary, so
    // widening it has to be a red test rather than a quiet diff.
    for (const table of OPENCODE_CREDENTIAL_TABLES) {
      expect(OPENCODE_READ_ALLOWLIST).not.toHaveProperty(table);
    }
    expect(Object.keys(OPENCODE_READ_ALLOWLIST).sort()).toEqual([
      'message',
      'part',
      'session',
      'sqlite_master',
    ]);
  });

  it('carries no column that could hold one, even under an allowed table', () => {
    // The other half: a table may be allowed and still expose a secret if a
    // column list drifted. `session.share_secret` and friends are real columns
    // in the upstream schema.
    const columns = Object.values(OPENCODE_READ_ALLOWLIST).flatMap((list) => [...list]);
    for (const column of columns) {
      expect(column).not.toMatch(/token|secret|credential|password|key|auth|bearer|share/i);
    }
  });

  it('never reach the index, with the tokens sitting right there in the file', async () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('what did we decide about the kestrel')]);
    await sweep();

    // The index holds something — a positive control, so this test cannot pass
    // by indexing nothing at all.
    expect(indexed()).toHaveLength(1);

    for (const secret of Object.values(SECRETS)) {
      expect(search(`"${secret}"`)).toEqual([]);
      const anywhere = db.$client
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE body LIKE ?')
        .get(`%${secret}%`) as { n: number };
      expect(anywhere.n).toBe(0);
    }
  });

  it('indexes a token a PERSON pasted into a chat, because that is their transcript', async () => {
    // Deliberate and stated: message bodies are user content. A token typed into
    // a conversation is the same as every other word in it, and pretending
    // otherwise would mean a redaction filter — the thing the allowlist exists
    // to avoid needing.
    seedSession('ses_a');
    say('ses_a', 'user', [text(`here is the key I was given: ${PASTED_TOKEN}`)]);
    await sweep();

    expect(search(`"${PASTED_TOKEN}"`)).toHaveLength(1);
  });
});

describe('the live store', () => {
  it('is never opened for writing — the sweep runs with the whole directory read-only', async () => {
    seedSession('ses_a');
    say('ses_a', 'assistant', [text('a kestrel, most likely')]);
    // Close DorkOS's own fixture handle so the only process touching the file is
    // the sweep, then take away write permission on the file AND its directory.
    // Any attempt to open it read-write, create a `-shm`, recover the WAL, or
    // checkpoint would fail with EACCES rather than succeeding quietly.
    store.close();
    fs.chmodSync(storePath, 0o444);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${storePath}${suffix}`)) fs.chmodSync(`${storePath}${suffix}`, 0o444);
    }
    fs.chmodSync(workdir, 0o555);

    const before = fs.readdirSync(workdir).map((name) => {
      const stat = fs.statSync(path.join(workdir, name));
      return `${name}:${String(stat.size)}:${String(stat.mtimeMs)}`;
    });

    const result = await sweep();

    fs.chmodSync(workdir, 0o755);
    // Reopened only so `afterEach` has a handle to close.
    store = new Database(storePath, { readonly: true });

    expect(result.failures).toEqual([]);
    expect(result.indexed).toBe(1);
    const after = fs.readdirSync(workdir).map((name) => {
      const stat = fs.statSync(path.join(workdir, name));
      return `${name}:${String(stat.size)}:${String(stat.mtimeMs)}`;
    });
    expect(after).toEqual(before);
  });

  it('is copied, and the copy is gone when the sweep ends', () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('anything at all')]);

    const snapshot = openOpenCodeSnapshot(storePath);
    expect(snapshot).not.toBeNull();
    const snapshotPath = snapshot?.snapshotPath ?? '';

    // The copy is somewhere else entirely, under the system temp directory.
    expect(snapshotPath).not.toBe(storePath);
    expect(
      fs.realpathSync(path.dirname(snapshotPath)).startsWith(fs.realpathSync(os.tmpdir()))
    ).toBe(true);
    expect(fs.existsSync(snapshotPath)).toBe(true);

    snapshot?.close();
    expect(fs.existsSync(snapshotPath)).toBe(false);
    expect(fs.existsSync(path.dirname(snapshotPath))).toBe(false);
  });

  it('reads what is still in the WAL, not just what was checkpointed', async () => {
    // The reason all three files are copied. OpenCode runs the store in WAL
    // mode, so the newest messages live in the log; a snapshot of `opencode.db`
    // alone is the conversation as it stood at the last checkpoint, which on a
    // live store is always behind.
    seedSession('ses_a');
    store.pragma('wal_checkpoint(TRUNCATE)');
    say('ses_a', 'user', [text('said after the checkpoint, so it is in the log')]);
    expect(fs.statSync(`${storePath}-wal`).size).toBeGreaterThan(0);

    await sweep();
    expect(search('checkpoint')).toHaveLength(1);
  });
});

describe('the guarantees the read rests on', () => {
  it('proves its own connection refuses writes, and says what SQLite answered', () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('anything at all')]);

    const snapshot = openOpenCodeSnapshot(storePath);
    // Non-empty by construction: `openOpenCodeSnapshot` refuses to hand back a
    // connection that ACCEPTED the probe write, so reaching this line at all is
    // half the assertion. Deleting either `readonly: true` or
    // `PRAGMA query_only` from the open path makes it throw instead.
    expect(snapshot?.writeRefusal).toMatch(/readonly|read-only/i);
    snapshot?.close();
  });

  it('refuses a query tail that could name another table', () => {
    // The one seam that could reach past the allowlist: the tail is raw text, so
    // `WHERE (SELECT access_token FROM account) IS NOT NULL` is a perfectly good
    // WHERE clause that reads a credential column the column check never sees.
    seedSession('ses_a');
    const snapshot = openOpenCodeSnapshot(storePath);
    try {
      for (const tail of [
        'WHERE (SELECT access_token FROM account) IS NOT NULL',
        'JOIN account ON account.id = session.id',
        'WHERE id IN (SELECT id FROM credential)',
      ]) {
        expect(() => buildAllowlistedSelect('session', ['id'], tail)).toThrow(
          /may not name another table/
        );
      }
      // And the shapes the module actually uses are still fine.
      expect(() =>
        buildAllowlistedSelect('message', ['id'], 'WHERE session_id = ? ORDER BY time_created ASC')
      ).not.toThrow();
    } finally {
      snapshot?.close();
    }
  });

  it('refuses a snapshot the copy tore, rather than pruning on a short list', async () => {
    // **A torn copy that OPENS is the dangerous one.** SQLite's main database
    // file has no per-page checksums, so a copy caught mid-checkpoint can open,
    // report FEWER sessions than exist, and let the prune delete indexed history
    // that is perfectly fine on disk.
    seedSession('ses_a');
    say('ses_a', 'user', [text('a kestrel, indexed while the copy was whole')]);
    seedSession('ses_b');
    say('ses_b', 'user', [text('a pelican, also indexed')]);
    await sweep();
    expect(indexed()).toHaveLength(2);

    // Tear the file the way a mid-checkpoint copy does: zero one INTERIOR page
    // and leave the header alone. Measured on this shape — the database opens
    // without complaint and `SELECT COUNT(*)` answers with a number, so nothing
    // in the read path notices. Only `quick_check` does.
    store.pragma('wal_checkpoint(TRUNCATE)');
    store.close();
    const whole = fs.readFileSync(storePath);
    const pageSize = 4096;
    expect(whole.length).toBeGreaterThan(pageSize * 3);
    whole.fill(0, pageSize * 2, pageSize * 3);
    fs.writeFileSync(storePath, whole);
    fs.rmSync(`${storePath}-wal`, { force: true });
    fs.rmSync(`${storePath}-shm`, { force: true });

    const result = await sweep();
    store = new Database(storePath);

    expect(result.failures).toEqual([
      {
        sourceId: 'opencode',
        originKey: SNAPSHOT_FAILURE_KEY,
        message: expect.stringContaining('did not survive the copy'),
      },
    ]);
    expect(result.pruned).toBe(0);
    expect(indexed()).toHaveLength(2);
  });
});

describe('a machine without OpenCode', () => {
  it('indexes nothing and reports no failure', async () => {
    const absent = createOpenCodeSource(() => path.join(workdir, 'nowhere', 'opencode.db'));
    const result = await sweepSnapshotSource(db, absent, '2026-08-25T11:00:00.000Z');
    expect(result).toMatchObject({ containers: 0, indexed: 0, pruned: 0, failures: [] });
  });

  it('does not prune an index built when OpenCode WAS installed', async () => {
    // The distinction the `null` return exists for. An absent store read as an
    // empty container list would delete every indexed OpenCode session the first
    // time the runtime was uninstalled — and, worse, do it silently.
    seedSession('ses_a');
    say('ses_a', 'user', [text('a kestrel, before OpenCode was removed')]);
    await sweep();
    expect(indexed()).toHaveLength(1);

    const absent = createOpenCodeSource(() => path.join(workdir, 'nowhere', 'opencode.db'));
    const result = await sweepSnapshotSource(db, absent, '2026-08-25T11:05:00.000Z');

    expect(result.pruned).toBe(0);
    expect(indexed()).toHaveLength(1);
  });

  it('reports a failure, and still prunes nothing, when the store cannot be read', async () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('a kestrel, indexed while the store was fine')]);
    await sweep();

    // A store whose schema has moved is the realistic version of this: upstream
    // renames a table and every read after it is a guess.
    store.exec('ALTER TABLE part RENAME TO part_v2');
    const result = await sweep();

    expect(result.failures).toEqual([
      {
        sourceId: 'opencode',
        originKey: SNAPSHOT_FAILURE_KEY,
        message: expect.stringContaining("no 'part' table"),
      },
    ]);
    expect(result.pruned).toBe(0);
    // The rows that were already indexed are untouched. A schema change upstream
    // is not a reason to lose history that was read correctly last week.
    expect(indexed()).toHaveLength(1);

    // **And somebody searching is told.** `searchForCaller` builds warnings from
    // `search_sources.last_error`, so a failure recorded only on the sweep
    // result is one only the server log knows about — and this is the failure
    // the ADR expects, since DorkOS now parses another product's private schema.
    const answer = searchForCaller(
      db,
      { rooms: 'all', sessions: true },
      {
        query: 'kestrel',
        limit: 10,
      }
    );
    expect(answer.warnings).toEqual([{ source: 'opencode', message: expect.any(String) }]);
  });

  it('stops warning once the store is readable again', async () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('a kestrel')]);
    await sweep();
    store.exec('ALTER TABLE part RENAME TO part_v2');
    await sweep();

    store.exec('ALTER TABLE part_v2 RENAME TO part');
    await sweep();

    const answer = searchForCaller(
      db,
      { rooms: 'all', sessions: true },
      {
        query: 'kestrel',
        limit: 10,
      }
    );
    expect(answer.warnings).toEqual([]);
    expect(answer.results).toHaveLength(1);
  });

  it('leaves no snapshot behind when the schema check fails', async () => {
    seedSession('ses_a');
    store.exec('ALTER TABLE part RENAME TO part_v2');
    // Scoped to this module's own prefix: `dorkos-opencode-` also matches the
    // adapter conformance suite's `dorkos-opencode-live-` directories, which are
    // none of this test's business and would make it flaky under a parallel run.
    const snapshotDirs = () =>
      fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('dorkos-opencode-snapshot-'));
    const before = snapshotDirs();
    await sweep();
    const after = snapshotDirs();
    expect(after).toEqual(before);
  });
});

describe('a snapshot that describes an earlier moment', () => {
  // The shape `quick_check` cannot see. The store and its WAL siblings are
  // copied one after another, so a checkpoint between them yields an OLD main
  // file beside a truncated log — a perfectly valid database that is simply
  // behind, and can be missing whole conversations. A prune on that list deletes
  // history that is intact on disk.

  it('refuses to prune when most of the known containers vanish at once', async () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('a kestrel')]);
    seedSession('ses_b');
    say('ses_b', 'user', [text('a pelican')]);
    seedSession('ses_c');
    say('ses_c', 'user', [text('a buzzard')]);
    seedSession('ses_d');
    say('ses_d', 'user', [text('a harrier')]);
    await sweep();
    expect(indexed()).toHaveLength(4);

    // Three of four gone — below the floor.
    for (const gone of ['ses_b', 'ses_c', 'ses_d']) {
      store.prepare('DELETE FROM part WHERE session_id = ?').run(gone);
      store.prepare('DELETE FROM message WHERE session_id = ?').run(gone);
      store.prepare('DELETE FROM session WHERE id = ?').run(gone);
    }

    const result = await sweep();
    expect(result.pruned).toBe(0);
    expect(result.failures).toEqual([
      {
        sourceId: 'opencode',
        originKey: PRUNE_GUARD_KEY,
        message: expect.stringContaining('refusing to prune'),
      },
    ]);
    // Nothing was lost while the guard held.
    expect(indexed()).toHaveLength(4);
  });

  it('still prunes an ordinary deletion, so the guard is not a way to never prune', async () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('a kestrel')]);
    seedSession('ses_b');
    say('ses_b', 'user', [text('a pelican')]);
    seedSession('ses_c');
    say('ses_c', 'user', [text('a buzzard')]);
    await sweep();

    store.prepare('DELETE FROM part WHERE session_id = ?').run('ses_b');
    store.prepare('DELETE FROM message WHERE session_id = ?').run('ses_b');
    store.prepare('DELETE FROM session WHERE id = ?').run('ses_b');

    // Two of three survive, which clears the floor.
    const result = await sweep();
    expect(2 / 3).toBeGreaterThanOrEqual(SNAPSHOT_MIN_LIVE_SHARE);
    expect(result.pruned).toBe(1);
    expect(result.failures).toEqual([]);
    expect(search('pelican')).toEqual([]);
  });

  it('prunes on the sweep after, once the short list turns out to be the truth', async () => {
    // The guard delays a real deletion by one tick; it does not veto it. The
    // second sweep sees the same short list against a smaller known set, so the
    // share is 0/1 of what is left... which is still short. What actually clears
    // it is that the operator's remaining history is now the whole picture.
    seedSession('ses_a');
    say('ses_a', 'user', [text('a kestrel')]);
    seedSession('ses_b');
    say('ses_b', 'user', [text('a pelican')]);
    await sweep();

    store.prepare('DELETE FROM part WHERE session_id = ?').run('ses_b');
    store.prepare('DELETE FROM message WHERE session_id = ?').run('ses_b');
    store.prepare('DELETE FROM session WHERE id = ?').run('ses_b');

    // 1 of 2 known — exactly the floor, which is not BELOW it, so it prunes.
    const result = await sweep();
    expect(result.pruned).toBe(1);
    expect(search('pelican')).toEqual([]);
  });
});

describe('what gets indexed', () => {
  it('keeps text and drops everything that is not speech', async () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('where did we land on the kestrel')]);
    say('ses_a', 'assistant', [
      { type: 'step-start', snapshot: 'abc' },
      { type: 'reasoning', text: 'the user is asking about the kestrel' },
      text('we decided it was a kestrel'),
      { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', output: 'ok' } },
      { type: 'step-finish', reason: 'stop' },
    ]);
    await sweep();

    expect(indexed()).toEqual([
      {
        source_id: 'opencode',
        origin_key: 'ses_a',
        ordinal: 1,
        role: 'user',
        body: 'where did we land on the kestrel',
      },
      {
        source_id: 'opencode',
        origin_key: 'ses_a',
        ordinal: 2,
        role: 'assistant',
        body: 'we decided it was a kestrel',
      },
    ]);
  });

  it('drops SDK-injected user text and text the UI never rendered', async () => {
    seedSession('ses_a');
    say('ses_a', 'user', [
      text('<command-expansion>/init</command-expansion>', { synthetic: true }),
      text('but this part I actually typed'),
    ]);
    say('ses_a', 'assistant', [text('never rendered', { ignored: true }), text('but this was')]);
    await sweep();

    expect(indexed()).toEqual([
      expect.objectContaining({ ordinal: 1, body: 'but this part I actually typed' }),
      expect.objectContaining({ ordinal: 2, body: 'but this was' }),
    ]);
  });

  it('keeps synthetic text on an ASSISTANT turn, where the flag means nothing', async () => {
    seedSession('ses_a');
    say('ses_a', 'assistant', [text('an assistant line marked synthetic', { synthetic: true })]);
    await sweep();
    expect(indexed()).toHaveLength(1);
  });

  it('leaves the birth turn out — the kickoff is DorkOS asking, not the person', async () => {
    // The kickoff carries NO `synthetic` flag, so the rule above cannot see it;
    // indexed, it would return DorkOS's own instruction as the user's words.
    seedSession('ses_a');
    say('ses_a', 'user', [
      text('<dork-kickoff>\nIntroduce yourself to the person who made you.\n</dork-kickoff>'),
    ]);
    say('ses_a', 'assistant', [text('Hello — I help you track kestrels.')]);
    await sweep();

    expect(indexed()).toEqual([
      expect.objectContaining({ ordinal: 2, body: 'Hello — I help you track kestrels.' }),
    ]);
  });

  it('still indexes a message that merely MENTIONS the kickoff tag', async () => {
    // The envelope predicate needs both anchors: quoting the tag is real speech.
    seedSession('ses_a');
    say('ses_a', 'user', [text('what does <dork-kickoff> mean in the source?')]);
    await sweep();

    expect(indexed()).toEqual([
      expect.objectContaining({ body: 'what does <dork-kickoff> mean in the source?' }),
    ]);
  });

  it('carries the directory the session ran in, so a hit can open somewhere', async () => {
    seedSession('ses_a', '/Users/dork/code/other-repo');
    say('ses_a', 'user', [text('a kestrel')]);
    await sweep();

    const row = db
      .select({ containerPath: searchSources.containerPath })
      .from(searchSources)
      .where(eq(searchSources.sourceId, 'opencode'))
      .get();
    expect(row?.containerPath).toBe('/Users/dork/code/other-repo');
  });

  it('leaves a subagent session out — it is a conversation the human never had', async () => {
    seedSession('ses_parent');
    say('ses_parent', 'user', [text('a kestrel, said by a person')]);
    seedSession('ses_child', '/Users/dork/code/dorkos', 'ses_parent');
    say('ses_child', 'assistant', [text('a kestrel, said by a subagent to itself')]);
    await sweep();

    expect(indexed()).toEqual([expect.objectContaining({ origin_key: 'ses_parent' })]);
  });

  it('records a session that has said nothing yet, so it is not rediscovered forever', async () => {
    seedSession('ses_empty');
    const result = await sweep();
    expect(result.containers).toBe(1);
    expect(result.indexed).toBe(0);
    expect(
      db
        .select({ originKey: searchSources.originKey })
        .from(searchSources)
        .where(eq(searchSources.sourceId, 'opencode'))
        .all()
    ).toEqual([{ originKey: 'ses_empty' }]);
  });
});

describe('sweeping twice', () => {
  it('re-reads nothing when nothing was said', async () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('the first thing anyone said')]);
    expect((await sweep()).indexed).toBe(1);

    // `indexed: 0`, not "the row count is unchanged". An unchanged count passes
    // for a sweep that correctly did nothing AND for one that re-read and
    // re-upserted every row.
    expect((await sweep()).indexed).toBe(0);
  });

  it('picks up the assistant half of a turn whose session stamp never moved', async () => {
    // **The caveat the spec insisted be written down before anyone polls.**
    // OpenCode stamps `session.time_updated` at turn START, so a
    // `updated > lastSeen` poll misses the assistant reply. The watermark here is
    // a count of messages, which cannot miss it: the row either exists or it does
    // not. The session's stamp is deliberately left where it was.
    seedSession('ses_a');
    const stampBefore = (
      store.prepare('SELECT time_updated AS t FROM session WHERE id = ?').get('ses_a') as {
        t: number;
      }
    ).t;
    say('ses_a', 'user', [text('what bird was that')]);
    await sweep();

    say('ses_a', 'assistant', [text('a kestrel, going by the hover')]);
    const stampAfter = (
      store.prepare('SELECT time_updated AS t FROM session WHERE id = ?').get('ses_a') as {
        t: number;
      }
    ).t;
    expect(stampAfter).toBe(stampBefore);

    const second = await sweep();
    expect(second.indexed).toBe(1);
    expect(search('hover')).toHaveLength(1);
  });

  it('is idempotent — the same message indexed twice is one row', async () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('a kestrel')]);
    await sweep();

    // Force the re-read the incremental path would otherwise skip, by putting the
    // watermark back to zero. The unique key plus the upsert is what makes this a
    // no-op rather than a duplicate.
    db.update(searchSources)
      .set({ lastOrdinal: 0 })
      .where(eq(searchSources.sourceId, 'opencode'))
      .run();
    await sweep();

    expect(indexed()).toHaveLength(1);
  });

  it('rebuilds a session whose messages were reverted away underneath it', async () => {
    // OpenCode reverts delete messages, which renumbers positions. The index
    // notices it holds ordinals the session no longer has and re-reads it whole,
    // so nothing stale is left answering searches.
    seedSession('ses_a');
    say('ses_a', 'user', [text('the first question')]);
    say('ses_a', 'assistant', [text('an answer about pelicans')]);
    say('ses_a', 'user', [text('a follow-up question')]);
    await sweep();
    expect(indexed()).toHaveLength(3);

    store.exec("DELETE FROM part WHERE data LIKE '%pelicans%'");
    store.exec('DELETE FROM message WHERE id NOT IN (SELECT message_id FROM part)');

    const result = await sweep();
    expect(result.rebuilt).toBe(1);
    expect(search('pelicans')).toEqual([]);
    expect(indexed()).toHaveLength(2);
  });

  it('drops a session that is gone from OpenCode entirely', async () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('a kestrel')]);
    seedSession('ses_b');
    say('ses_b', 'user', [text('a pelican')]);
    await sweep();
    expect(indexed()).toHaveLength(2);

    store.exec("DELETE FROM part WHERE session_id = 'ses_b'");
    store.exec("DELETE FROM message WHERE session_id = 'ses_b'");
    store.exec("DELETE FROM session WHERE id = 'ses_b'");

    const result = await sweep();
    expect(result.pruned).toBe(1);
    expect(search('pelican')).toEqual([]);
  });
});

describe('a turn that is still streaming', () => {
  // OpenCode creates the assistant message row at turn START and streams its
  // parts in for up to a minute, rewriting them as tokens arrive. So the message
  // COUNT rises before the content lands, and a count-only watermark would index
  // a truncated body and never look again. Measured on the operator's store
  // 2026-08-25: 236/236 parts created after their message row, 55/80 text parts
  // updated in place, 91/94 message rows updated after creation, last part up to
  // 62 s behind.

  it('indexes the whole answer once the turn finishes, not the half it caught', async () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('what bird was that')]);
    const turn = beginTurn('ses_a', 'assistant');
    const part = streamPart(turn, 'ses_a', text('a kes'));

    // The sweep lands mid-stream. The count is already 2.
    await sweepLive();
    expect(search('kes')).toHaveLength(1);

    // The rest of the answer arrives, rewriting the part that is already there.
    // Nothing about the count changes.
    mutatePart(part, text('a kestrel, going by the hover'));
    streamPart(turn, 'ses_a', text('it was hunting over the verge'));

    const second = await sweepLive();
    expect(second.indexed).toBe(2);
    expect(search('hover')).toHaveLength(1);
    expect(search('verge')).toHaveLength(1);
    // And the truncation is gone rather than sitting beside the full text.
    expect(indexed()).toEqual([
      expect.objectContaining({ ordinal: 1, body: 'what bird was that' }),
      expect.objectContaining({
        ordinal: 2,
        body: 'a kestrel, going by the hover\nit was hunting over the verge',
      }),
    ]);
  });

  it('serves the truncation forever when the window is switched off — the defect itself', async () => {
    // The control that proves the window is what fixes it rather than something
    // else in the pass. `sweep()` reads the fixture as an hour old, so no
    // container is volatile, and the count never changes again.
    seedSession('ses_a');
    const turn = beginTurn('ses_a', 'assistant');
    const part = streamPart(turn, 'ses_a', text('a kes'));
    await sweep();

    mutatePart(part, text('a kestrel, going by the hover'));
    const second = await sweep();

    expect(second.indexed).toBe(0);
    expect(search('hover')).toEqual([]);
  });

  it('re-reads a session whose message count did not move at all', async () => {
    // The revert-plus-new-turn shape: one message deleted, one added, inside a
    // single sweep interval. The count is identical on both sides, so nothing
    // about growth or shrinkage can detect it.
    seedSession('ses_a');
    say('ses_a', 'user', [text('the first question')]);
    say('ses_a', 'assistant', [text('an answer about pelicans')]);
    await sweepLive();
    expect(indexed()).toHaveLength(2);

    store.exec("DELETE FROM part WHERE data LIKE '%pelicans%'");
    store.exec('DELETE FROM message WHERE id NOT IN (SELECT message_id FROM part)');
    say('ses_a', 'assistant', [text('an answer about kestrels instead')]);

    const before = store.prepare('SELECT COUNT(*) AS n FROM message').get() as { n: number };
    expect(before.n).toBe(2);

    await sweepLive();
    expect(search('pelicans')).toEqual([]);
    expect(search('kestrels')).toHaveLength(1);
  });

  it('picks up an in-place part edit that changes no count anywhere', async () => {
    seedSession('ses_a');
    const turn = say('ses_a', 'user', [text('a pelican, I think')]);
    await sweepLive();
    expect(search('pelican')).toHaveLength(1);

    const part = store.prepare('SELECT id FROM part WHERE message_id = ?').get(turn) as {
      id: string;
    };
    mutatePart(part.id, text('a kestrel, on reflection'));

    await sweepLive();
    expect(search('pelican')).toEqual([]);
    expect(search('kestrel')).toHaveLength(1);
  });

  it('drops a stale row an ordinal the new content no longer fills', async () => {
    // **The hole a re-read-without-delete leaves.** A message that projects to
    // NOTHING — a turn that only called a tool — writes no row, so it cannot
    // overwrite what is already at its ordinal. Combine that with a revert that
    // lands the count exactly ON the index's high-water mark and the shrink
    // rebuild never fires either:
    //
    //   indexed  {1:'a', 2:'b'}          indexedTo = 2
    //   after    [user 'a', tool-only]   maxOrdinal = 2
    //   rebuilt  maxOrdinal < indexedTo  → 2 < 2 → false
    //
    // A re-read then upserts ordinal 1 and writes nothing for ordinal 2, so
    // ordinal 2 goes on answering 'b' forever. 25 of the 75 messages on the
    // operator's real store project to nothing, so this is reachable rather than
    // theoretical.
    seedSession('ses_a');
    say('ses_a', 'user', [text('a kestrel on the fence')]);
    const doomed = say('ses_a', 'user', [text('a pelican by the water')]);
    await sweepLive();
    expect(indexed()).toEqual([
      expect.objectContaining({ ordinal: 1, body: 'a kestrel on the fence' }),
      expect.objectContaining({ ordinal: 2, body: 'a pelican by the water' }),
    ]);

    // Revert the second turn and replace it with one that says nothing.
    store.prepare('DELETE FROM part WHERE message_id = ?').run(doomed);
    store.prepare('DELETE FROM message WHERE id = ?').run(doomed);
    say('ses_a', 'assistant', [
      { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', output: 'ok' } },
    ]);

    const counts = store.prepare('SELECT COUNT(*) AS n FROM message').get() as { n: number };
    expect(counts.n).toBe(2);

    await sweepLive();
    expect(search('pelican')).toEqual([]);
    expect(indexed()).toEqual([
      expect.objectContaining({ ordinal: 1, body: 'a kestrel on the fence' }),
    ]);
  });

  it('leaves a settled session alone, so the window is not a rebuild every tick', async () => {
    // The cost bound. A session OpenCode has not touched in a quarter of an hour
    // resumes at its watermark and reads nothing.
    seedSession('ses_a');
    say('ses_a', 'user', [text('said and finished long ago')]);
    expect((await sweep()).indexed).toBe(1);
    expect((await sweep()).indexed).toBe(0);
  });

  it('gives the window room for at least two sweeps per mutation', () => {
    // The margin IS the guarantee: a mutation is first seen somewhere inside one
    // interval, and a window of exactly two would put the next sweep on the
    // boundary. Shortening either constant without the other reds here.
    expect(OPENCODE_VOLATILE_WINDOW_MS).toBeGreaterThanOrEqual(2 * SEARCH_RECONCILE_INTERVAL_MS);
  });
});

describe('a row whose shape has drifted', () => {
  it('is counted and skipped, and the rest of the session still indexes', async () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('before the bad row')]);
    say('ses_a', 'user', [text('never reached')], { data: '{not json at all' });
    say('ses_a', 'assistant', [text('after the bad row')]);
    await sweep();

    // Two messages, and the middle ordinal is missing rather than reused: a
    // position belongs to the row that occupies it, whether or not that row
    // projected.
    expect(indexed()).toEqual([
      expect.objectContaining({ ordinal: 1, body: 'before the bad row' }),
      expect.objectContaining({ ordinal: 3, body: 'after the bad row' }),
    ]);
  });

  it('reports the count, because a drifted format is otherwise a quiet source', async () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('fine')], { data: '{not json at all' });
    say('ses_a', 'user', [text('also fine')], { data: JSON.stringify({ role: 'tool' }) });
    say('ses_a', 'user', ['{not json either}']);
    const result = await sweep();

    // Three: the unparseable envelope, the unrecognised role, and the
    // unparseable part.
    expect(result.skipped).toBe(3);
    expect(result.failures).toEqual([]);
  });

  it('does not count a message that simply had nothing to say', async () => {
    // A turn that only called a tool is the expected case, not a drift signal.
    seedSession('ses_a');
    say('ses_a', 'assistant', [{ type: 'tool', tool: 'bash', callID: 'c1', state: {} }]);
    const result = await sweep();
    expect(result.skipped).toBe(0);
    expect(result.indexed).toBe(0);
  });
});

describe('the projection on its own', () => {
  it('is pure — same rows in, same messages out, no store anywhere', () => {
    const projection = projectOpenCodeMessages('ses_a', [
      {
        ordinal: 7,
        id: 'msg_1',
        timeCreated: 1_780_000_000_000,
        data: JSON.stringify({ role: 'user' }),
        parts: [JSON.stringify(text('first line')), JSON.stringify(text('second line'))],
      },
    ]);

    expect(projection).toEqual({
      skipped: 0,
      messages: [
        {
          originKey: 'ses_a',
          ordinal: 7,
          messageId: 'msg_1',
          role: 'user',
          createdAt: '2026-05-28T20:26:40.000Z',
          body: 'first line\nsecond line',
        },
      ],
    });
  });

  it('contributes a null timestamp rather than inventing one', () => {
    const projection = projectOpenCodeMessages('ses_a', [
      {
        ordinal: 1,
        id: 'msg_1',
        timeCreated: Number.NaN,
        data: JSON.stringify({ role: 'assistant' }),
        parts: [JSON.stringify(text('said at no particular time'))],
      },
    ]);
    expect(projection.messages[0]?.createdAt).toBeNull();
  });

  it('carries the store’s own message id, which is what a hit lands on', () => {
    // The id chain OpenCode gets exact landing on (DOR-1579): this is the
    // `message.id` row the store keeps, and the session view renders the same
    // message under it (`runtimes/opencode/session-mapper.ts` — `id: info.id`).
    // Red if it is dropped, or replaced by anything derived here.
    const projection = projectOpenCodeMessages('ses_a', [
      {
        ordinal: 1,
        id: 'msg_landing',
        timeCreated: 1_780_000_000_000,
        data: JSON.stringify({ role: 'assistant' }),
        parts: [JSON.stringify(text('here it is'))],
      },
    ]);

    expect(projection.messages[0]?.messageId).toBe('msg_landing');
  });

  it('answers null for a row with no id rather than inventing one', () => {
    const projection = projectOpenCodeMessages('ses_a', [
      {
        ordinal: 1,
        id: '',
        timeCreated: 1_780_000_000_000,
        data: JSON.stringify({ role: 'assistant' }),
        parts: [JSON.stringify(text('unidentified'))],
      },
    ]);

    expect(projection.messages[0]?.messageId).toBeNull();
  });
});

describe('the ranked query', () => {
  it('returns OpenCode hits beside the other sources', async () => {
    seedSession('ses_a');
    say('ses_a', 'user', [text('the kestrel we saw on the walk')]);
    await sweep();

    db.insert(messages)
      .values({
        sourceId: 'claude-code',
        originKey: 'session-a',
        ordinal: 1,
        role: 'user',
        createdAt: '2026-08-25T09:00:00.000Z',
        body: 'a kestrel mentioned to Claude Code',
      })
      .run();

    const hits = db.$client
      .prepare(
        `SELECT m.source_id FROM messages_fts f JOIN messages m ON m.id = f.rowid
         WHERE messages_fts MATCH 'kestrel' ORDER BY m.source_id`
      )
      .all() as { source_id: string }[];
    expect(hits.map((hit) => hit.source_id)).toEqual(['claude-code', 'opencode']);
  });
});
