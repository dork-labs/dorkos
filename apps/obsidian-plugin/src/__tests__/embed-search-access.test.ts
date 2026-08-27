/**
 * The Obsidian embed searches the same index as the browser, and sees exactly
 * as much of it (message-search task 5.3 / DOR-691, re-running DOR-684's access
 * assertion through the other transport).
 *
 * **This file lives here because this package is the embed.** `apps/client` may
 * not import the server — that separation is the whole point of the `Transport`
 * port — and `apps/server` may not import the client. This plugin composes both,
 * in one process, exactly the way `CopilotView` does at runtime. So it is the
 * only place the two answers can be put beside each other and compared, which is
 * the only way to know they agree.
 *
 * ## What is actually being compared
 *
 * One database, seeded once. On one side, the real `GET /api/search` router,
 * driven over HTTP with no agent header, which is the person at the keyboard. On
 * the other, a real `DirectTransport` wired to the real embedded seam, which is
 * the person in Obsidian. Every vector is asked of both and the answers are
 * compared whole — not "both returned something", and not a spot-check on a
 * field.
 *
 * ## The fixture's shape is the assertion
 *
 * The operator joins `#open` and NOT `#closed`, and still sees `#closed` — that
 * is the rooms domain's rule for whoever owns the install (`searchScope` returns
 * `'all'`), and it is the rule most likely to be quietly re-derived differently
 * on a second surface. A `pelican` said only in the room they never joined is
 * the positive control: it proves the row is really there and really matches, so
 * "the embed found nothing" could never pass for agreement.
 *
 * @module obsidian-plugin/__tests__/embed-search-access
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, messages, roomEntries, roomMembers, rooms, searchSources, type Db } from '@dorkos/db';
import type { SearchQuery } from '@dorkos/shared/search-schemas';
import { DirectTransport, type DirectTransportServices } from '@dorkos/client/lib/direct-transport';
import { createSearchRouter } from '../../../server/src/routes/search.js';
import {
  createRoomSubsystem,
  setRoomService,
  type RoomSubsystem,
} from '../../../server/src/services/rooms/index.js';
import { SearchIndexer } from '../../../server/src/services/search/indexer.js';
import { createEmbeddedSearch } from '../../../server/src/services/search/embedded-search.js';
import { roomsSource } from '../../../server/src/services/search/registry.js';

/**
 * Who owns the install, for the vectors that need one.
 *
 * `readOwnerAccount` is the ONE thing the rooms domain asks to decide whether a
 * caller is the operator — `isOwnerAuthor`, `isOwnerRecord` and
 * `resolveOperatorAuthor` all route through it — so standing an owner up is what
 * turns the fixture from an unowned machine into an owned one. Default `null`,
 * which is a real install that nobody has registered on.
 */
const owner = vi.hoisted(() => ({ account: null as { id: string } | null }));

vi.mock('../../../server/src/services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readOwnerAccount: () => owner.account,
}));

const AT = '2026-08-25T09:00:00.000Z';

let db: Db;
let subsystem: RoomSubsystem;
let ownerId: string;
let transport: DirectTransport;

/** The browser's answer: the real router, called by the person at the keyboard. */
function overHttp(query: SearchQuery) {
  const app = express();
  app.use('/api/search', createSearchRouter({ db }));
  return request(app)
    .get('/api/search')
    .query(query as Record<string, unknown>);
}

function seedRoom(id: string): void {
  db.insert(rooms)
    .values({
      id,
      kind: 'channel',
      slug: id,
      title: `#${id}`,
      topic: null,
      createdAt: AT,
      lastActivityAt: AT,
    })
    .run();
}

function say(roomId: string, seq: number, text: string): void {
  db.insert(roomEntries)
    .values({
      id: `${roomId}-${seq}`,
      roomId,
      seq,
      kind: 'post',
      authorId: ownerId,
      body: JSON.stringify({ text }),
      createdAt: AT,
      cascadeRoot: `${roomId}-${seq}`,
      cascadeDepth: 0,
    })
    .run();
}

beforeEach(async () => {
  owner.account = null;
  vi.restoreAllMocks();
  db = createTestDb();
  subsystem = createRoomSubsystem({ db });
  // The router reaches the rooms domain through the singleton, exactly as the
  // real server does; the embed reaches the same instance through its seam.
  setRoomService(subsystem.service);
  ownerId = subsystem.authors.localHuman().id;

  seedRoom('open');
  say('open', 1, 'we agreed to rewrite the scheduler');
  seedRoom('closed');
  say('closed', 1, 'the scheduler rewrite, in a room nobody joined');
  say('closed', 2, 'a pelican, said where the roster does not reach');
  db.insert(roomMembers)
    .values({
      roomId: 'open',
      authorId: ownerId,
      responseMode: 'engaged',
      joinedAt: AT,
      joinedSeq: 0,
      lastReadSeq: 0,
    })
    .run();

  db.insert(messages)
    .values({
      sourceId: 'claude-code',
      originKey: 'session-a',
      ordinal: 1,
      role: 'assistant',
      createdAt: AT,
      body: 'the scheduler, as discussed in a session',
    })
    .run();
  db.insert(searchSources)
    .values({
      sourceId: 'claude-code',
      originKey: 'session-a',
      lastOrdinal: 1,
      containerPath: '/Users/dork/code/dorkos',
      lastIndexedAt: AT,
    })
    .run();

  await new SearchIndexer(db, [roomsSource]).sweep();

  // The embed, wired the way `CopilotView` wires it: the server's seam behind
  // `DirectTransport`, and nothing else in between.
  const embedded = createEmbeddedSearch({ db, rooms: subsystem.service });
  transport = new DirectTransport({
    search: { search: (query: SearchQuery) => embedded.search(query) },
  } as unknown as DirectTransportServices);
});

afterEach(() => {
  db.$client.close();
});

describe('what the embed may see', () => {
  it.each([
    ['a word said in rooms and in a session', { q: 'scheduler' }],
    ['a word said only where the operator never joined', { q: 'pelican' }],
    ['a word nobody said', { q: 'narwhal' }],
    ['one source by name', { q: 'scheduler', source: 'claude-code' }],
    ['the rooms source by name', { q: 'scheduler', source: 'rooms' }],
    ['a limit the caller chose', { q: 'scheduler', limit: 1 }],
    ['a limit far past the ceiling', { q: 'scheduler', limit: 5000 }],
  ])('answers %s exactly as the route does', async (_label, query) => {
    const browser = await overHttp(query as SearchQuery);
    const embed = await transport.search(query as SearchQuery);

    expect(browser.status).toBe(200);
    expect(embed).toEqual(browser.body);
  });

  it('really does have the row it is being trusted to find', async () => {
    // The positive control for the whole file. Every equality above would hold
    // just as loudly if the index were empty and both sides answered nothing.
    const embed = await transport.search({ q: 'pelican' });

    expect(embed.results).toHaveLength(1);
    expect(embed.results[0]).toMatchObject({ source: 'rooms', container: 'closed' });
  });

  it('is answered identically for a room off the roster and for words nobody said, once neither is there', async () => {
    // DOR-684's pair, moved onto the axis the embed actually has. There is no
    // second identity in an Obsidian window, so the pair that matters here is
    // "nothing matched" against "nothing matched": both must be the SAME empty
    // body, and the same one the route sends, so no shape leaks a difference.
    const unsaid = await transport.search({ q: 'narwhal' });
    const alsoUnsaid = await transport.search({ q: 'wombat' });

    expect(unsaid).toEqual(alsoUnsaid);
    expect(unsaid).toEqual({ results: [], warnings: [] });
    expect(unsaid).toEqual((await overHttp({ q: 'narwhal' })).body);
  });

  it('carries a degraded source through as a warning, not as a failure', async () => {
    // Only the transcript source is broken; the rooms are fine. Breaking both
    // would make "one warning naming the failed source" unfalsifiable.
    db.update(searchSources)
      .set({ lastError: 'ENOENT: the transcript moved' })
      .where(eq(searchSources.sourceId, 'claude-code'))
      .run();

    const browser = await overHttp({ q: 'scheduler' });
    const embed = await transport.search({ q: 'scheduler' });

    expect(embed).toEqual(browser.body);
    expect(embed.warnings).toEqual([{ source: 'claude-code', message: expect.any(String) }]);
  });
});

describe('what the embed refuses', () => {
  it.each([
    ['a query with no long-enough word', { q: 'a' }, 'INVALID_SEARCH_QUERY'],
    ['a limit of zero', { q: 'scheduler', limit: 0 }, 'INVALID_SEARCH_QUERY'],
    [
      'a source nothing is called',
      { q: 'scheduler', source: 'not-a-source' },
      'UNKNOWN_SEARCH_SOURCE',
    ],
  ])("refuses %s with the route's own sentence", async (_label, query, code) => {
    const browser = await overHttp(query as SearchQuery);
    const thrown = await transport
      .search(query as SearchQuery)
      .then(() => null)
      .catch((err: unknown) => err as Error & { code?: string; status?: number });

    expect(browser.status).toBe(400);
    expect(thrown).toBeInstanceOf(Error);
    // The message, the code and the status all match, because the box above the
    // transport renders whichever one it is handed and never asks which window
    // it is in.
    expect({
      message: thrown?.message,
      code: thrown?.code,
      status: thrown?.status,
    }).toEqual({ message: browser.body.error, code, status: 400 });
  });
});

describe('what the embed may see once the rooms domain narrows', () => {
  // ── The gap this closes ────────────────────────────────────────────────────
  // Every vector above runs on an install nobody owns, where the local human IS
  // the operator: `searchScope` answers `'all'` and the session check answers
  // `true`. So they agree with a seam that DERIVES its scope and equally with
  // one that hard-codes `{ rooms: 'all', sessions: true }` — the widest possible
  // answer, which is the one thing an embed must never quietly be. The seam's
  // own documentation makes a promise those vectors cannot test: "if the rooms
  // domain ever narrows what an operator may search, this narrows with it on the
  // same commit."
  //
  // So this is that day, arranged. The install is OWNED, and the author the
  // operator resolves to is not the owner row. Two things are stood up for it —
  // an owner account, and a registry that hands back the unbound local human —
  // and NOTHING ELSE IS MOCKED. `searchScope` runs for real and builds its map
  // out of the membership rows the fixture actually seeded, and the session
  // check runs for real against the owner id. A hard-coded widening fails here
  // and passes everywhere else in the file.
  beforeEach(() => {
    owner.account = { id: 'owner-x' };
    // An operator author that is not the owner. `peekOperator` normally looks up
    // the owner's own natural key, and a row under that key IS the owner by
    // definition — which would put the fixture back where it started.
    vi.spyOn(subsystem.authors, 'peekOperator').mockReturnValue(subsystem.authors.localHuman());
  });

  it('sees only the rooms the operator is actually on the roster of', async () => {
    const answer = await transport.search({ q: 'scheduler' });

    // `#open` is the one room the fixture put them in. `#closed` says the same
    // word and is not theirs; the Claude Code session says it too and is
    // owner-only. The unnarrowed answer to this query is three hits.
    expect(answer.results.map((hit) => `${hit.source}:${hit.container}`)).toEqual(['rooms:open']);
  });

  it('cannot reach a room off the roster, even one that matches', async () => {
    // `pelican` is said only in `#closed`. The owner finds it (asserted above,
    // as the positive control for the whole file); this caller must not.
    const answer = await transport.search({ q: 'pelican' });

    expect(answer.results).toEqual([]);
  });

  it('is the same rows the route would give the same caller', async () => {
    // The route resolves ITS caller from the request and this seam resolves its
    // own, so the two cannot be driven to the same identity over HTTP — that is
    // the one thing this file's other vectors cover and this one cannot. What is
    // asserted instead is the half that is shared: both hand the same scope to
    // the same index. Reading it directly through the rooms domain proves the
    // narrowing came from there rather than from anything in the seam.
    const caller = subsystem.authors.localHuman();
    const scope = subsystem.service.searchScope(caller.id);

    expect(scope).toBeInstanceOf(Map);
    expect([...(scope as Map<string, number>).keys()]).toEqual(['open']);
  });
});
