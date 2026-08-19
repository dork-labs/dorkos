/**
 * An `X-DorkOS-Agent` token the server cannot verify is refused by EVERY room
 * route, rather than read as the operator (DOR-1361).
 *
 * DOR-1357 fixed one route. Everywhere else `resolveCaller` treated a token it
 * could not resolve as "no agent presented", so a revoked or expired agent that
 * kept following the protocol fell through to branch 3 and resolved to the
 * install owner — attaching files, renaming authors and halting turns as the
 * person. Not an escalation on a single-identity install, since dropping the
 * header reaches the same place (the documented DOR-505 residual), but the
 * routes claimed an invariant they did not enforce, and every one of those acts
 * was recorded against the person.
 *
 * The refusal now lives in `resolveCaller` itself, so it is one answer for every
 * room route rather than one gate per route, and a route added tomorrow inherits
 * it. Driven through the REAL app mount, because the thing under test is the
 * seam between the identity middleware and the handler.
 *
 * Seeded defects, each run and each red before the fix:
 *
 * - Drop the refusal from `resolveCaller` -> every "unverifiable" row red: the
 *   attachment stores, the handle is renamed, the room halts, all as the owner.
 * - Keep the refusal but key it on `getRequestAgentIdentity` alone (the reader
 *   `resolveCaller` already had) -> every "unverifiable" row red again, because
 *   that reader is exactly what an unresolvable token leaves empty.
 * - Refuse whenever the header is present, resolved or not -> the "a valid token
 *   still acts as its agent" row red.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    has: vi.fn(() => true),
    listRuntimes: vi.fn(() => [fakeRuntime]),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

// `uploads` is answered for real so the attachment route's HAPPY path is
// reachable here: without it the un-headered upload would 500 on a missing
// config and could not stand as the posture this must keep green.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) =>
      key === 'uploads' ? { maxFileSize: 1024 * 1024, maxFiles: 5, allowedTypes: ['*/*'] } : null
    ),
    set: vi.fn(),
  },
}));

import { createApp, finalizeApp } from '../../app.js';
import {
  createRoomSubsystem,
  setRoomAttachmentStores,
  setRoomService,
} from '../../services/rooms/index.js';
import { LocalRoomAttachmentStore } from '../../services/rooms/attachments/local-room-attachment-store.js';
import { setReadCursorService } from '../../services/core/read-cursor-service.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';

const app = createApp();
finalizeApp(app);

const ANA_PATH = '/agents/ana';

/**
 * A token shaped like the real thing that resolves to nobody — what a revoked or
 * expired agent presents. The identity service is always live in these tests, so
 * this is a token the server looked up and could not place, never one it ignored.
 */
const UNVERIFIABLE = 'dork_agent_this-token-resolves-to-nothing';

/** The refusal every room route now gives that token. */
const REFUSAL_CODE = 'AGENT_IDENTITY_UNVERIFIED';

/** Register an agent so a room can resolve it by directory. */
function registerAgent(db: Db, name: string, projectPath: string): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: `ULID_${name.toUpperCase()}`,
      name,
      displayName: name[0].toUpperCase() + name.slice(1),
      runtime: 'claude-code',
      projectPath,
      behaviorJson: '{"responseMode":"always"}',
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

describe('an unverifiable agent token on a room route', () => {
  let db: Db;
  let dorkHome: string;

  beforeEach(async () => {
    fakeRuntime = new FakeAgentRuntime();
    vi.clearAllMocks();
    resetAgentIdentityService();
    db = createTestDb();
    registerAgent(db, 'ana', ANA_PATH);
    const rooms = createRoomSubsystem({ db });
    setRoomService(rooms.service);
    setReadCursorService(rooms.readCursors);
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-room-caller-agent-'));
    setRoomAttachmentStores({
      attachments: new LocalRoomAttachmentStore(dorkHome),
      rows: rooms.attachments,
    });
    // Live for every case, so an unresolved token is one the server tried.
    initAgentIdentityService(db);
  });

  afterEach(async () => {
    resetAgentIdentityService();
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** A channel with Ana in it, and the ids a caller needs to address it. */
  async function room(): Promise<{ id: string; ownerAuthorId: string; anaAuthorId: string }> {
    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title: 'Release train', agentPaths: [ANA_PATH] });
    expect(created.status).toBe(201);
    return {
      id: created.body.id,
      ownerAuthorId: created.body.viewerAuthorId,
      anaAuthorId: created.body.members.find(
        (m: { author: { displayName: string } }) => m.author.displayName === 'Ana'
      ).authorId,
    };
  }

  /** A token that really does resolve to Ana. */
  async function anaToken(): Promise<string> {
    return initAgentIdentityService(db).mint({ agentPath: ANA_PATH, displayName: 'Ana' });
  }

  describe('POST /:id/attachments', () => {
    it('refuses it, where the same upload with no header stores the file', async () => {
      const { id } = await room();

      const refused = await request(app)
        .post(`/api/rooms/${id}/attachments`)
        .set('X-DorkOS-Agent', UNVERIFIABLE)
        .attach('files', Buffer.from('notes'), 'notes.txt');

      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe(REFUSAL_CODE);
      expect(refused.body).not.toHaveProperty('attachments');

      // The header is the ONLY difference. Without this half the 401 above would
      // also pass for an upload that was broken for everybody.
      const allowed = await request(app)
        .post(`/api/rooms/${id}/attachments`)
        .attach('files', Buffer.from('notes'), 'notes.txt');
      expect(allowed.status).toBe(200);
      expect(allowed.body.attachments).toHaveLength(1);
    });

    it('still refuses a token that DOES resolve, in the words it always did', async () => {
      const { id } = await room();
      const token = await anaToken();

      const res = await request(app)
        .post(`/api/rooms/${id}/attachments`)
        .set('X-DorkOS-Agent', token)
        .attach('files', Buffer.from('notes'), 'notes.txt');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PEOPLE_ONLY');
    });
  });

  describe('PATCH /authors/:authorId/handle', () => {
    it('refuses it, where the same rename with no header succeeds', async () => {
      const { ownerAuthorId } = await room();

      const refused = await request(app)
        .patch(`/api/rooms/authors/${ownerAuthorId}/handle`)
        .set('X-DorkOS-Agent', UNVERIFIABLE)
        .send({ handle: 'stolen' });

      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe(REFUSAL_CODE);
      // The rename did not happen under another name either.
      expect(refused.body).not.toHaveProperty('handle');

      const allowed = await request(app)
        .patch(`/api/rooms/authors/${ownerAuthorId}/handle`)
        .send({ handle: 'dorian' });
      expect(allowed.status).toBe(200);
      expect(allowed.body.handle).toBe('dorian');
    });

    it('still refuses a token that DOES resolve, in the words it always did', async () => {
      const { ownerAuthorId } = await room();
      const token = await anaToken();

      const res = await request(app)
        .patch(`/api/rooms/authors/${ownerAuthorId}/handle`)
        .set('X-DorkOS-Agent', token)
        .send({ handle: 'stolen' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OPERATOR_ONLY');
    });
  });

  describe('POST /:id/halt', () => {
    it('refuses it, where the same stop with no header is accepted', async () => {
      const { id } = await room();

      const refused = await request(app)
        .post(`/api/rooms/${id}/halt`)
        .set('X-DorkOS-Agent', UNVERIFIABLE);

      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe(REFUSAL_CODE);
      expect(refused.body).not.toHaveProperty('stopped');

      const allowed = await request(app).post(`/api/rooms/${id}/halt`);
      expect(allowed.status).toBe(200);
      expect(allowed.body.stopped).toBe(0);
    });

    it('still refuses a token that DOES resolve, in the words it always did', async () => {
      // Ana is a member, so visibility passes and the refusal is honestly about
      // her being a machine — `PEOPLE_ONLY`, from `requirePersonAuthor`, not the
      // new 401. Without this the 401 above could not be told apart from a route
      // that had simply started refusing every agent the same way.
      const { id } = await room();
      const token = await anaToken();

      const res = await request(app).post(`/api/rooms/${id}/halt`).set('X-DorkOS-Agent', token);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PEOPLE_ONLY');
    });
  });

  describe('GET /:id/sessions', () => {
    it('refuses it before it looks the room up at all, keeping DOR-1357 true', async () => {
      // DOR-1357 already refused this shape, one route at a time, AFTER checking
      // the room was visible. The refusal has moved up to the caller seam, so the
      // answer is 401 rather than 403 and no room is read to produce it — which
      // is a strictly narrower disclosure, not a wider one.
      const { id } = await room();

      const refused = await request(app)
        .get(`/api/rooms/${id}/sessions`)
        .set('X-DorkOS-Agent', UNVERIFIABLE);

      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe(REFUSAL_CODE);
      expect(refused.body).not.toHaveProperty('bindings');

      // Still not the operator's read: a room nobody could see answers the same
      // 401, so a junk token cannot be used to learn which room ids exist.
      const unknownRoom = await request(app)
        .get('/api/rooms/01NOSUCHROOM/sessions')
        .set('X-DorkOS-Agent', UNVERIFIABLE);
      expect(unknownRoom.status).toBe(401);
      expect(unknownRoom.body.code).toBe(REFUSAL_CODE);

      // And the un-headered read still works, so the refusal is about the token.
      const allowed = await request(app).get(`/api/rooms/${id}/sessions`);
      expect(allowed.status).toBe(200);
      expect(allowed.body.bindings).toEqual([]);
    });
  });

  describe('the postures that were always allowed', () => {
    it('lets a token that resolves act as its own agent, not as the owner', async () => {
      // Branch 1 of `resolveCaller`, unchanged: this is the whole reason the
      // header exists, and a refusal keyed on the header alone would break it.
      const { id, ownerAuthorId, anaAuthorId } = await room();
      const token = await anaToken();

      const posted = await request(app)
        .post(`/api/rooms/${id}/entries`)
        .set('X-DorkOS-Agent', token)
        .send({ text: 'on it' });
      expect(posted.status).toBe(202);

      const entries = await request(app).get(`/api/rooms/${id}/entries`);
      const mine = entries.body.entries.find(
        (e: { id: string }) => e.id === posted.body.entryId
      ) as { authorId: string };
      expect(mine.authorId).toBe(anaAuthorId);
      expect(mine.authorId).not.toBe(ownerAuthorId);
    });

    it('lets a request with no header at all be the person, as it always was', async () => {
      const { id } = await room();

      const posted = await request(app)
        .post(`/api/rooms/${id}/entries`)
        .send({ text: 'from the keyboard' });

      expect(posted.status).toBe(202);
    });
  });

  describe('the read routes and the stream', () => {
    it('refuses an unverifiable token on a plain room read', async () => {
      const { id } = await room();

      const res = await request(app).get(`/api/rooms/${id}`).set('X-DorkOS-Agent', UNVERIFIABLE);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe(REFUSAL_CODE);
    });

    it('refuses one on the SSE stream, which is a read like any other', async () => {
      // The stream resolves the same caller and had the same hole: an expired
      // agent subscribed to every room the person is in.
      const { id } = await room();

      const res = await request(app)
        .get(`/api/rooms/${id}/events`)
        .set('X-DorkOS-Agent', UNVERIFIABLE);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe(REFUSAL_CODE);
    });

    it('refuses one on a read cursor, which is not a room route but shares the seam', async () => {
      const { id } = await room();

      const res = await request(app)
        .put(`/api/read-cursors/room/${id}`)
        .set('X-DorkOS-Agent', UNVERIFIABLE)
        .send({ lastReadSeq: 1 });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe(REFUSAL_CODE);
    });
  });
});
