import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createTestDb } from '@dorkos/test-utils/db';
import { messages, type Db } from '@dorkos/db';
import { createOpenCodeSource } from '../registry.js';
import { sweepSnapshotSource } from '../snapshot-frontier.js';
import { PRUNE_GUARD_KEY } from '../row-frontier.js';
import { SEARCH_RECONCILE_INTERVAL_MS } from '../indexer.js';
import {
  OPENCODE_CREDENTIAL_TABLES,
  OPENCODE_READ_ALLOWLIST,
  OPENCODE_VOLATILE_WINDOW_MS,
  buildAllowlistedSelect,
  openOpenCodeSnapshot,
} from '../opencode-store.js';

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
});

it('gives the window room for at least two sweeps per mutation', () => {
  // The margin IS the guarantee: a mutation is first seen somewhere inside one
  // interval, and a window of exactly two would put the next sweep on the
  // boundary. Shortening either constant without the other reds here.
  expect(OPENCODE_VOLATILE_WINDOW_MS).toBeGreaterThanOrEqual(2 * SEARCH_RECONCILE_INTERVAL_MS);
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
