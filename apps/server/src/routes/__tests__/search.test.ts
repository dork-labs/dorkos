/**
 * `GET /api/search` over HTTP — the envelope, the contract it refuses, and the
 * one thing that must never be true of it: that a machine reaches the operator's
 * session history (message-search spec §6.1, §7).
 *
 * Driven through supertest against the real router, the real `RoomService` and a
 * real index, because the subject is a seam: what the identity middleware leaves
 * on `res.locals`, who `resolveCaller` makes of that, and what the rooms domain
 * then says that caller may see.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import { messages, roomEntries, roomMembers, rooms, searchSources, type Db } from '@dorkos/db';
import {
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_QUERY_LENGTH,
  SearchResponseSchema,
} from '@dorkos/shared/search-schemas';
import type { AgentIdentity } from '../../services/core/agent-identity/agent-identity-service.js';
import {
  createRoomSubsystem,
  setRoomService,
  type RoomSubsystem,
} from '../../services/rooms/index.js';
import { SearchIndexer } from '../../services/search/index.js';
import { roomsSource } from '../../services/search/registry.js';
import { createSearchRouter } from '../search.js';

const AT = '2026-07-29T09:00:00.000Z';
const ANA: AgentIdentity = { agentPath: '/agents/ana', displayName: 'Ana' } as AgentIdentity;

let db: Db;
let subsystem: RoomSubsystem;
let ownerId: string;
let agentId: string;

/**
 * An app in `app.ts`'s middleware order, with the identity the middleware would
 * have resolved already on `res.locals`.
 *
 * @param identity - The agent this request resolved to, if any.
 * @param presentsHeader - Whether the raw `X-DorkOS-Agent` header is there at
 *   all. Separate from the identity on purpose: a token that did NOT resolve
 *   still says a machine is calling.
 */
function buildApp(identity?: AgentIdentity, presentsHeader = identity !== undefined) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (identity) res.locals.agentIdentity = identity;
    if (presentsHeader && req.headers['x-dorkos-agent'] === undefined) {
      req.headers['x-dorkos-agent'] = 'token-for-ana';
    }
    next();
  });
  app.use('/api/search', createSearchRouter({ db }));
  return app;
}

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

function join(roomId: string, authorId: string, joinedSeq: number): void {
  db.insert(roomMembers)
    .values({ roomId, authorId, responseMode: 'engaged', joinedAt: AT, joinedSeq, lastReadSeq: 0 })
    .run();
}

beforeEach(async () => {
  db = createTestDb();
  subsystem = createRoomSubsystem({ db });
  setRoomService(subsystem.service);
  ownerId = subsystem.authors.localHuman().id;
  agentId = subsystem.authors.resolveAgent(ANA.agentPath, ANA.displayName).id;

  seedRoom('open');
  say('open', 1, 'we agreed to rewrite the scheduler');
  seedRoom('closed');
  say('closed', 1, 'the scheduler rewrite, in a room Ana is not in');
  join('open', ownerId, 0);
  join('open', agentId, 0);
  join('closed', ownerId, 0);

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
});

describe('GET /api/search', () => {
  it('answers with the envelope, ranked, with the match marked', async () => {
    const res = await request(buildApp()).get('/api/search').query({ q: 'scheduler' });

    expect(res.status).toBe(200);
    expect(SearchResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);
    for (const hit of res.body.results) {
      expect(hit.excerpt).toContain('<mark>scheduler</mark>');
    }
  });

  it('carries what a hit needs to be opened', async () => {
    const res = await request(buildApp()).get('/api/search').query({ q: 'scheduler' });
    const session = res.body.results.find(
      (hit: { source: string }) => hit.source === 'claude-code'
    );

    expect(session).toEqual({
      source: 'claude-code',
      container: 'session-a',
      containerPath: '/Users/dork/code/dorkos',
      ordinal: 1,
      role: 'assistant',
      createdAt: AT,
      excerpt: expect.stringContaining('<mark>scheduler</mark>'),
    });
  });

  it('sends warnings as an empty array rather than leaving it out', async () => {
    const res = await request(buildApp()).get('/api/search').query({ q: 'scheduler' });
    expect(res.body.warnings).toEqual([]);
  });

  it('names a source that could not be fully read', async () => {
    db.update(searchSources).set({ lastError: 'ENOENT: the transcript moved' }).run();
    const res = await request(buildApp()).get('/api/search').query({ q: 'scheduler' });

    expect(res.status).toBe(200);
    expect(res.body.warnings.map((warning: { source: string }) => warning.source)).toContain(
      'claude-code'
    );
    expect(res.body.results.length).toBeGreaterThan(0);
  });
});

describe('the calling contract', () => {
  it('refuses a query shorter than the minimum', async () => {
    const res = await request(buildApp())
      .get('/api/search')
      .query({ q: 'x'.repeat(SEARCH_MIN_QUERY_LENGTH - 1) });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_SEARCH_QUERY');
  });

  it('refuses a request with no query at all', async () => {
    const res = await request(buildApp()).get('/api/search');
    expect(res.status).toBe(400);
  });

  it('accepts a query exactly at the minimum', async () => {
    // The floor is a floor, not a fence: the shortest allowed search still runs.
    const res = await request(buildApp())
      .get('/api/search')
      .query({ q: 'x'.repeat(SEARCH_MIN_QUERY_LENGTH) });
    expect(res.status).toBe(200);
  });

  it('clamps an absurd limit instead of refusing it', async () => {
    for (let seq = 2; seq <= SEARCH_MAX_LIMIT + 10; seq += 1) {
      say('open', seq, `scheduler talk number ${seq}`);
    }
    await new SearchIndexer(db, [roomsSource]).sweep();

    const res = await request(buildApp()).get('/api/search').query({ q: 'scheduler', limit: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(SEARCH_MAX_LIMIT);
  });

  it('returns what was asked for when the limit is sensible', async () => {
    const res = await request(buildApp()).get('/api/search').query({ q: 'scheduler', limit: 1 });
    expect(res.body.results).toHaveLength(1);
  });

  it('refuses a source that does not exist', async () => {
    const res = await request(buildApp())
      .get('/api/search')
      .query({ q: 'scheduler', source: 'opencode' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_SEARCH_SOURCE');
  });
});

describe('who is asking', () => {
  it('gives the operator every room and every session', async () => {
    const res = await request(buildApp()).get('/api/search').query({ q: 'scheduler' });
    const sources = new Set(res.body.results.map((hit: { source: string }) => hit.source));
    const containers = new Set(res.body.results.map((hit: { container: string }) => hit.container));

    expect(sources).toEqual(new Set(['rooms', 'claude-code']));
    expect(containers).toEqual(new Set(['open', 'closed', 'session-a']));
  });

  it('gives an agent its own rooms and no session at all', async () => {
    const res = await request(buildApp(ANA)).get('/api/search').query({ q: 'scheduler' });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([
      expect.objectContaining({ source: 'rooms', container: 'open' }),
    ]);
  });

  it('gives an agent asking for sessions by name exactly nothing', async () => {
    const res = await request(buildApp(ANA))
      .get('/api/search')
      .query({ q: 'scheduler', source: 'claude-code' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [], warnings: [] });
  });

  it('refuses a caller whose agent token this machine could not verify', async () => {
    // The header is there and nothing resolved it — a revoked or expired agent.
    // It is refused rather than quietly treated as the person at the keyboard,
    // which is what would otherwise hand it the whole install.
    const res = await request(buildApp(undefined, true))
      .get('/api/search')
      .query({ q: 'scheduler' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AGENT_IDENTITY_UNVERIFIED');
  });

  it('is answered identically for a hidden room and for words nobody said', async () => {
    // A room id is not a capability, and neither is a query string: `closed`
    // holds the only mention of "pelican", and Ana's answer for it must be the
    // same body as her answer for a word that appears nowhere.
    say('closed', 2, 'a pelican, said where Ana cannot see it');
    await new SearchIndexer(db, [roomsSource]).sweep();

    const hidden = await request(buildApp(ANA)).get('/api/search').query({ q: 'pelican' });
    const unsaid = await request(buildApp(ANA)).get('/api/search').query({ q: 'narwhal' });

    expect(hidden.status).toBe(unsaid.status);
    expect(hidden.body).toEqual(unsaid.body);
    expect(hidden.body).toEqual({ results: [], warnings: [] });

    // The positive control: the row is really there and really matches.
    const owner = await request(buildApp()).get('/api/search').query({ q: 'pelican' });
    expect(owner.body.results).toHaveLength(1);
  });
});
