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
 * A helper hardcoding one runtime would let the next one arrive unguarded — and
 * two have since, so the seam has paid for itself twice.
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
function scopeFor(authorId: string, sessions: SearchScope['sessions']): SearchScope {
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
  // A Codex rollout and an OpenCode conversation, both session history under
  // source ids `buildScopes` has never been told about. That is the point: each
  // must be out of an agent's reach on the day it lands rather than on the day
  // somebody remembers.
  transcribe('codex-thread-1', 2, 'a kestrel I mentioned to Codex', 'codex');
  transcribe('ses_oc', 1, 'a kestrel, said to OpenCode', 'opencode');

  await new SearchIndexer(db, [roomsSource]).sweep();
});

describe('the owner', () => {
  it('finds every room they are on the roster of', () => {
    const hits = search(scopeFor(ownerId, true), 'kestrel').results;
    const containers = hits.filter((hit) => hit.source === 'rooms').map((hit) => hit.container);
    expect(new Set(containers)).toEqual(new Set(['open', 'closed', 'late', 'agents-only']));
  });

  it('finds session transcripts', () => {
    const hits = search(scopeFor(ownerId, true), 'kestrel').results;
    const sessions = hits
      .filter((hit) => hit.source === 'claude-code')
      .map((hit) => hit.container)
      .sort();
    expect(sessions).toEqual(['open', 'session-b']);
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
});

describe('session history over an MCP-shaped caller', () => {
  it('returns no session row, whatever the words are', () => {
    // The required negative: transcripts hold both search terms, and an agent
    // reaches none of the three runtimes that keep them.
    for (const term of ['kestrel', 'pelican']) {
      const hits = search(scopeFor(agentId, false), term).results;
      expect(hits.filter((hit) => hit.source !== 'rooms')).toEqual([]);
    }
  });

  it('returns no session row even when the caller asks for that source by name', () => {
    for (const source of ['claude-code', 'codex', 'opencode']) {
      expect(search(scopeFor(agentId, false), 'kestrel', source)).toEqual({
        results: [],
        warnings: [],
      });
    }
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
});

describe('an agent with a session filter (spec `audit-trail` §3.4)', () => {
  /** `session-b` is agent work (a scheduled run); every other session is a person's own. */
  const agentWork: SearchScope['sessions'] = {
    readable: (ids) => new Set(ids.filter((id) => id === 'session-b')),
  };

  it('finds a phrase from an agent work session', () => {
    const hits = search(scopeFor(agentId, agentWork), 'kestrel').results;
    expect(hits.filter((hit) => hit.source !== 'rooms').map((hit) => hit.sessionId)).toEqual([
      'session-b',
    ]);
  });

  it("finds nothing from a person's own chat, which the owner does find", () => {
    const agentHits = search(scopeFor(agentId, agentWork), 'pelican').results;
    expect(agentHits.filter((hit) => hit.source !== 'rooms')).toEqual([]);
    const ownerHits = search(scopeFor(ownerId, true), 'pelican').results;
    expect(
      ownerHits.filter((hit) => hit.source === 'claude-code').map((hit) => hit.sessionId)
    ).toEqual(['session-a']);
  });

  it('asks the filter only about sessions, so a session sharing a room id stays private', () => {
    const hits = search(scopeFor(agentId, agentWork), 'kestrel', 'claude-code').results;
    expect(hits.map((hit) => hit.container)).toEqual(['session-b']);
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
});
