/**
 * The access model: who may find what, and what a caller who may not find
 * something is told (message-search spec §7, §9.5).
 *
 * These are security tests, so they are written the only way security tests can
 * be trusted: **every negative is paired with a positive over the same seeded
 * rows.** `expect(results).toHaveLength(0)` passes for a working filter, for an
 * empty index and for a broken query alike, so each "cannot see it" case is
 * accompanied by an owner-path assertion proving the row is really there and
 * really matches the words asked for.
 *
 * The scope comes from the REAL `RoomService` over real `room_members` rows, and
 * the room half of the index is built by the REAL indexer over real
 * `room_entries`. A fixture scope would only prove this file agrees with itself,
 * and the scope is the half worth proving.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  authors,
  messages,
  roomEntries,
  roomMembers,
  rooms,
  searchSources,
  and,
  eq,
  type Db,
} from '@dorkos/db';
import { createRoomSubsystem, type RoomSubsystem } from '../../rooms/index.js';
import { SearchIndexer } from '../indexer.js';
import { roomsSource } from '../registry.js';
import { searchForCaller, type SearchScope } from '../search-service.js';

let db: Db;
let subsystem: RoomSubsystem;
let ownerId: string;
let agentId: string;

const AT = '2026-07-29T09:00:00.000Z';

/** Open a room. */
function seedRoom(id: string): void {
  db.insert(rooms)
    .values({
      id,
      kind: 'channel',
      slug: id,
      title: `#${id}`,
      topic: null,
      workspaceId: null,
      createdAt: AT,
      lastActivityAt: AT,
    })
    .run();
}

/** Say something in a room, at an explicit seq. */
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

/** Put somebody on a room's roster, from `joinedSeq` up. */
function join(roomId: string, authorId: string, joinedSeq: number): void {
  db.insert(roomMembers)
    .values({
      roomId,
      authorId,
      responseMode: 'engaged',
      joinedAt: AT,
      joinedSeq,
      lastReadSeq: 0,
    })
    .run();
}

/**
 * A session transcript row, as a runtime's projection would write it.
 *
 * The source id is a parameter because the access rule is about the CATEGORY,
 * not about `claude-code`: every registered source except `rooms` is session
 * history, and a caller that presented an agent identity reaches none of them.
 * A helper hardcoding one runtime would let the next one arrive unguarded.
 */
function transcribe(
  sessionId: string,
  ordinal: number,
  text: string,
  sourceId = 'claude-code'
): void {
  db.insert(messages)
    .values({
      sourceId,
      originKey: sessionId,
      ordinal,
      role: 'user',
      createdAt: AT,
      body: text,
    })
    .run();
  db.insert(searchSources)
    .values({
      sourceId,
      originKey: sessionId,
      lastOrdinal: ordinal,
      containerPath: '/Users/dork/code/dorkos',
      lastIndexedAt: AT,
    })
    .onConflictDoUpdate({
      target: [searchSources.sourceId, searchSources.originKey],
      set: { lastOrdinal: ordinal },
    })
    .run();
}

/** What this caller may search, as the route composes it. */
function scopeFor(authorId: string, sessions: boolean): SearchScope {
  return { rooms: subsystem.service.searchScope(authorId), sessions };
}

/** Search as somebody, with the same defaults the route uses. */
function search(scope: SearchScope, query: string, source?: string) {
  return searchForCaller(db, scope, { query, limit: 20, ...(source !== undefined && { source }) });
}

beforeEach(async () => {
  db = createTestDb();
  subsystem = createRoomSubsystem({ db });
  // No accounts on this install, so the unbound local human IS the operator —
  // the same rule `isOwnerRecord` applies, reached through the real registry.
  ownerId = subsystem.authors.localHuman().id;
  agentId = subsystem.authors.resolveAgent('/agents/ana', 'Ana').id;

  // `open` is a room they are both in. `closed` is one the agent is not in at
  // all. `late` is one the agent joined part-way through.
  seedRoom('open');
  say('open', 1, 'the kestrel we saw on the walk');
  seedRoom('closed');
  say('closed', 1, 'a pelican, in a room Ana is not in');
  say('closed', 2, 'another kestrel, also out of reach');
  seedRoom('late');
  say('late', 1, 'kestrel talk before Ana arrived');
  say('late', 2, 'more kestrel before Ana arrived');
  say('late', 3, 'kestrel after Ana arrived');

  join('open', ownerId, 0);
  join('open', agentId, 0);
  join('late', ownerId, 0);
  join('late', agentId, 2);
  join('closed', ownerId, 0);
  // A room the operator is not in and never was. Two agents opened it between
  // themselves; the owner has no `room_members` row for it.
  seedRoom('agents-only');
  say('agents-only', 1, 'a buzzard, discussed by agents with nobody watching');
  say('agents-only', 2, 'a kestrel, in the same agents-only room');
  join('agents-only', agentId, 0);

  transcribe('session-a', 1, 'a pelican I mentioned to Claude Code');
  transcribe('session-b', 4, 'kestrel notes from a session');
  // A session whose opaque container id is EXACTLY a room Ana is in. Container
  // ids are composed per source and unique only within one, so this is the
  // collision that a visibility clause scoped on `origin_key` alone would let
  // through — and the only way the session assertions below can catch it.
  transcribe('open', 9, 'kestrel, said in a session that shares a room’s id');
  // A Codex rollout, which is session history under a source id `buildScopes`
  // has never been told about. That is the point: it must be out of an agent's
  // reach on the day it lands rather than on the day somebody remembers.
  transcribe('codex-thread-1', 2, 'a kestrel I mentioned to Codex', 'codex');

  await new SearchIndexer(db, [roomsSource]).sweep();
});

describe('the owner', () => {
  it('finds every room they are on the roster of', () => {
    const hits = search(scopeFor(ownerId, true), 'kestrel').results;
    const containers = hits.filter((hit) => hit.source === 'rooms').map((hit) => hit.container);
    expect(new Set(containers)).toEqual(new Set(['open', 'closed', 'late', 'agents-only']));
  });

  it('finds a room they were never a member of at all', () => {
    // The deliberate divergence from `readHistory`, driven rather than described
    // (see `RoomService.searchScope`): that path requires a member row even of the
    // owner, and this one does not. `agents-only` is a room two agents opened
    // between themselves — the operator has NO `room_members` row in it — and it
    // is searchable by them anyway, because spec §7 gives them every room on the
    // machine. A future decision to narrow this has to start by reddening here.
    expect(
      subsystem.store.listMembersForRooms(['agents-only']).map((member) => member.authorId)
    ).not.toContain(ownerId);

    const hits = search(scopeFor(ownerId, true), 'buzzard').results;
    expect(hits).toEqual([
      expect.objectContaining({ source: 'rooms', container: 'agents-only', ordinal: 1 }),
    ]);
  });

  it('reads a room from its first message, floor or no floor', () => {
    // The owner is not scoped by `joinedSeq` at all — their clause is absent
    // rather than filtered — so `late:1` is theirs even though the agent's floor
    // in that room is 2.
    const hits = search(scopeFor(ownerId, true), 'kestrel').results;
    expect(hits).toContainEqual(
      expect.objectContaining({ source: 'rooms', container: 'late', ordinal: 1 })
    );
  });

  it('finds session transcripts', () => {
    const hits = search(scopeFor(ownerId, true), 'kestrel').results;
    const sessions = hits
      .filter((hit) => hit.source === 'claude-code')
      .map((hit) => hit.container)
      .sort();
    expect(sessions).toEqual(['open', 'session-b']);
  });

  it('carries the working directory a session hit opens in', () => {
    const hit = search(scopeFor(ownerId, true), 'kestrel').results.find(
      (candidate) => candidate.source === 'claude-code'
    );
    expect(hit?.containerPath).toBe('/Users/dork/code/dorkos');
  });

  it('carries no working directory for a room, because a room is not a directory', () => {
    const hit = search(scopeFor(ownerId, true), 'kestrel').results.find(
      (candidate) => candidate.source === 'rooms'
    );
    expect(hit?.containerPath).toBeNull();
  });
});

describe('a non-member', () => {
  it('is told exactly what somebody searching for words nobody said is told', () => {
    // The oracle §9.5 forbids, closed: `pelican` appears ONLY in a room Ana is
    // not in, so her answer for it must be indistinguishable from her answer for
    // a word that was never said anywhere — not merely also-empty.
    const forSomethingHidden = search(scopeFor(agentId, false), 'pelican');
    const forSomethingUnsaid = search(scopeFor(agentId, false), 'narwhal');

    expect(forSomethingHidden).toEqual(forSomethingUnsaid);
    expect(forSomethingHidden).toEqual({ results: [], warnings: [] });
  });

  it('does not hide the row from the owner — the positive control', () => {
    // Without this, the assertion above passes just as loudly against an empty
    // index or a query that matches nothing at all.
    const owned = search(scopeFor(ownerId, true), 'pelican').results;
    expect(owned.some((hit) => hit.source === 'rooms' && hit.container === 'closed')).toBe(true);
  });
});

describe('a member', () => {
  it('finds their own rooms and not the ones they are out of', () => {
    const containers = search(scopeFor(agentId, false), 'kestrel')
      .results.map((hit) => hit.container)
      .sort();
    // `agents-only` is Ana's too — she is on its roster and the owner is not,
    // which is the pair that makes the owner case above a real divergence rather
    // than a coincidence. `closed` is the one she is out of.
    expect(containers).toEqual(['agents-only', 'late', 'open']);
  });

  it('never sees what a room said before they joined it', () => {
    const hits = search(scopeFor(agentId, false), 'kestrel').results;
    const late = hits.filter((hit) => hit.container === 'late').map((hit) => hit.ordinal);
    expect(late).toEqual([3]);
  });

  it('still sees the oldest message of a room they were in from the start', () => {
    // The other direction of the same floor, and the one a single global floor
    // gets wrong: Ana's highest floor is 2, and `open:1` is below it.
    const hits = search(scopeFor(agentId, false), 'kestrel').results;
    expect(hits).toContainEqual(expect.objectContaining({ container: 'open', ordinal: 1 }));
  });

  it('would have seen the pre-join messages if they were the owner’s', () => {
    const owned = search(scopeFor(ownerId, true), 'kestrel').results;
    const late = owned
      .filter((hit) => hit.container === 'late')
      .map((hit) => hit.ordinal)
      .sort();
    expect(late).toEqual([1, 2, 3]);
  });

  it('is in no rooms at all when nobody put them anywhere', () => {
    const stranger = subsystem.authors.resolveAgent('/agents/nobody', 'Nobody').id;
    expect(search(scopeFor(stranger, false), 'kestrel')).toEqual({ results: [], warnings: [] });
  });
});

describe('session history over an MCP-shaped caller', () => {
  it('returns no session row, whatever the words are', () => {
    // The required negative: transcripts hold both search terms, and an agent
    // reaches neither.
    for (const term of ['kestrel', 'pelican']) {
      const hits = search(scopeFor(agentId, false), term).results;
      expect(hits.filter((hit) => hit.source === 'claude-code')).toEqual([]);
    }
  });

  it('returns no session row even when the caller asks for that source by name', () => {
    expect(search(scopeFor(agentId, false), 'kestrel', 'claude-code')).toEqual({
      results: [],
      warnings: [],
    });
  });

  it('returns those very rows to the owner — the positive control', () => {
    for (const term of ['kestrel', 'pelican']) {
      const hits = search(scopeFor(ownerId, true), term).results;
      expect(hits.filter((hit) => hit.source === 'claude-code').length).toBeGreaterThanOrEqual(1);
    }
  });

  it('returns no CODEX row either — the default closes a source it was never told about', () => {
    // `buildScopes` knows one source by name, `rooms`, and treats every other
    // REGISTERED source as session history. This is the test that the claim
    // survived a new runtime arriving: nothing in `search-service.ts` was
    // edited for Codex, and the assertion would have to be edited to let a
    // widening through.
    expect(search(scopeFor(agentId, false), 'kestrel', 'codex')).toEqual({
      results: [],
      warnings: [],
    });
    const hits = search(scopeFor(agentId, false), 'kestrel').results;
    expect(hits.filter((hit) => hit.source === 'codex')).toEqual([]);
  });

  it('returns the codex row to the owner — the positive control for it', () => {
    const hits = search(scopeFor(ownerId, true), 'kestrel').results;
    expect(hits.filter((hit) => hit.source === 'codex').map((hit) => hit.container)).toEqual([
      'codex-thread-1',
    ]);
  });
});

describe('narrowing to one source', () => {
  it('leaves out everything else', () => {
    const hits = search(scopeFor(ownerId, true), 'kestrel', 'rooms').results;
    // Five room rows say "kestrel" — `open:1`, `closed:2`, `late:1..3` — and none
    // of the two session rows that also say it may come back. A length-agnostic
    // `every()` passes for a filter that dropped four of the five as well.
    expect(hits.map((hit) => `${hit.container}:${hit.ordinal}`).sort()).toEqual([
      'agents-only:2',
      'closed:2',
      'late:1',
      'late:2',
      'late:3',
      'open:1',
    ]);
  });
});

describe('a source that is behind', () => {
  beforeEach(() => {
    db.update(searchSources)
      .set({ lastError: 'ENOENT: the transcript moved' })
      .where(
        and(eq(searchSources.sourceId, 'claude-code'), eq(searchSources.originKey, 'session-a'))
      )
      .run();
  });

  it('still answers, with the healthy sources’ hits and one warning naming it', () => {
    const answer = search(scopeFor(ownerId, true), 'kestrel');
    expect(answer.warnings).toEqual([{ source: 'claude-code', message: expect.any(String) }]);
    expect(answer.results.some((hit) => hit.source === 'rooms')).toBe(true);
  });

  it('names one warning for the source, not one per container that failed', () => {
    db.update(searchSources)
      .set({ lastError: 'ENOENT: this one too' })
      .where(
        and(eq(searchSources.sourceId, 'claude-code'), eq(searchSources.originKey, 'session-b'))
      )
      .run();
    expect(search(scopeFor(ownerId, true), 'kestrel').warnings).toHaveLength(1);
  });

  it('says nothing to a member about a room they are not in', () => {
    // `closed` is a room Ana cannot search. Its frontier being broken is not her
    // problem, and telling her about it would be a statement about a room she
    // cannot see — on every query, forever. The rooms she IS in are fine, so her
    // answer carries no warning at all.
    db.update(searchSources)
      .set({ lastError: 'the projection threw' })
      .where(and(eq(searchSources.sourceId, 'rooms'), eq(searchSources.originKey, 'closed')))
      .run();

    expect(search(scopeFor(agentId, false), 'kestrel').warnings).toEqual([]);
    // The positive control over the same row: the owner, whose scope includes
    // that room, IS told.
    expect(search(scopeFor(ownerId, true), 'kestrel').warnings).toContainEqual(
      expect.objectContaining({ source: 'rooms' })
    );
  });

  it('does warn a member about a room they ARE in', () => {
    // The pair to the case above: the filter is by scope, not by silence.
    db.update(searchSources)
      .set({ lastError: 'the projection threw' })
      .where(and(eq(searchSources.sourceId, 'rooms'), eq(searchSources.originKey, 'open')))
      .run();

    expect(search(scopeFor(agentId, false), 'kestrel').warnings).toEqual([
      { source: 'rooms', message: expect.any(String) },
    ]);
  });

  it('says nothing about a source a caller cannot reach anyway', () => {
    // Ana never searches transcripts, so a broken transcript is not news she can
    // act on — and a warning naming a source she has no access to would be one
    // more thing the envelope says about a world she cannot see.
    expect(search(scopeFor(agentId, false), 'kestrel').warnings).toEqual([]);
  });

  it('warns about nothing while every source is caught up', () => {
    db.update(searchSources).set({ lastError: null }).run();
    expect(search(scopeFor(ownerId, true), 'kestrel').warnings).toEqual([]);
  });
});

describe('the author registry', () => {
  it('really did give the owner and the agent different identities', () => {
    // Guards every assertion above: if these collapsed onto one author row, the
    // "member" cases would be the owner cases and every one of them would pass.
    expect(agentId).not.toBe(ownerId);
    expect(db.select().from(authors).all().length).toBeGreaterThanOrEqual(2);
  });
});
