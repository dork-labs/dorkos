/**
 * The six session-canvas routes, driven through the REAL app mount (spec
 * `canvas-agent-seat` §1.6).
 *
 * What only a route test can reach: the gate as the identity middleware really
 * resolves it, the status each refusal becomes, and the fact that the router is
 * mounted under `/api/sessions/:id` at all — a router nobody registered
 * type-checks perfectly and 404s on every path.
 *
 * The claim worth being exact about is that **a session's canvas is the
 * person's own**. It has no members to check, so the gate is one question with
 * three answers: an id that is not a session id (400), an agent this machine
 * cannot verify (401) and one it can (403). The fourth refusal is the process
 * itself having no canvas (503), which an embedded host really is.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
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

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { createApp, finalizeApp } from '../../app.js';
import { createRoomSubsystem, setRoomService } from '../../services/rooms/index.js';
import { setCanvasService } from '../../services/canvas/index.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';

const app = createApp();
finalizeApp(app);
const testServer = listeningServer(app);

/** A real session id — the routes refuse anything that is not a UUID. */
const SESSION = '0e7270c6-5555-4666-8777-888888888888';
const GHOST = '11111111-2222-4333-8444-555555555555';

/** A URL document — content with a natural identity, so opens dedupe. */
const urlContent = (url: string) => ({ type: 'url' as const, url });

/** Put a document on this session's canvas as the person at the keyboard. */
const open = (url: string, sessionId = SESSION) =>
  request(testServer)
    .post(`/api/sessions/${sessionId}/canvas`)
    .send({ content: urlContent(url) });

describe('the session canvas routes', () => {
  let db: Db;

  beforeEach(async () => {
    db = createTestDb();
    runtimeRegistry.setDb(db);
    const subsystem = createRoomSubsystem({ db });
    setRoomService(subsystem.service);
    setCanvasService(subsystem.canvas);
    // The session exists as far as this server is concerned: it has taken a
    // turn, so the runtime registry holds its binding. That is what the POST
    // asks before it mints a scope.
    await runtimeRegistry.persistSessionRuntime(SESSION, 'claude-code');
  });

  afterEach(() => {
    resetAgentIdentityService();
    vi.restoreAllMocks();
  });

  it('opens a document and lists it back', async () => {
    const created = await open('https://example.test/a');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      scope: `session:${SESSION}`,
      // A session's rows carry NO room id — that is the invariant that keeps an
      // unrelated room deletion from taking somebody's canvas with it.
      roomId: null,
      contentType: 'url',
      authorId: 'owner',
      pinned: false,
    });

    const listed = await request(testServer).get(`/api/sessions/${SESSION}/canvas`);
    expect(listed.status).toBe(200);
    expect(listed.body.documents).toHaveLength(1);
    expect(listed.body.documents[0].id).toBe(created.body.id);
  });

  it('reads one document back by id, content included', async () => {
    const created = await open('https://example.test/a');
    const read = await request(testServer).get(
      `/api/sessions/${SESSION}/canvas/${created.body.id}`
    );
    expect(read.status).toBe(200);
    expect(read.body.content).toEqual({ type: 'url', url: 'https://example.test/a' });
  });

  it('404s a document this session does not hold', async () => {
    const read = await request(testServer).get(`/api/sessions/${SESSION}/canvas/no-such-document`);
    expect(read.status).toBe(404);
    expect(read.body.code).toBe('CANVAS_DOCUMENT_NOT_FOUND');
  });

  it('changes content, pin and order in one PATCH', async () => {
    const created = await open('https://example.test/a');
    const patched = await request(testServer)
      .patch(`/api/sessions/${SESSION}/canvas/${created.body.id}`)
      .send({ content: urlContent('https://example.test/b'), pinned: true, activate: true });
    expect(patched.status).toBe(200);
    expect(patched.body.content.url).toBe('https://example.test/b');
    expect(patched.body.pinned).toBe(true);
  });

  it('closes a document, and says nothing more about it', async () => {
    const created = await open('https://example.test/a');
    const closed = await request(testServer).delete(
      `/api/sessions/${SESSION}/canvas/${created.body.id}`
    );
    expect(closed.status).toBe(204);
    const read = await request(testServer).get(
      `/api/sessions/${SESSION}/canvas/${created.body.id}`
    );
    expect(read.status).toBe(404);
  });

  it('takes and releases the edit lock', async () => {
    const created = await open('https://example.test/a');
    const held = await request(testServer)
      .post(`/api/sessions/${SESSION}/canvas/${created.body.id}/editing`)
      .send({ editing: true });
    expect(held.status).toBe(200);
    expect(held.body.editingBy).not.toBeNull();
    expect(typeof held.body.expiresAt).toBe('string');

    const released = await request(testServer)
      .post(`/api/sessions/${SESSION}/canvas/${created.body.id}/editing`)
      .send({ editing: false });
    expect(released.body).toEqual({ editingBy: null, expiresAt: null });
  });

  describe('what it refuses', () => {
    it('400s an id that is not a session id, on every route', async () => {
      const listed = await request(testServer).get('/api/sessions/not-a-uuid/canvas');
      const read = await request(testServer).get('/api/sessions/not-a-uuid/canvas/doc-1');
      const opened = await open('https://example.test/a', 'not-a-uuid');
      const patched = await request(testServer)
        .patch('/api/sessions/not-a-uuid/canvas/doc-1')
        .send({ pinned: true });
      const deleted = await request(testServer).delete('/api/sessions/not-a-uuid/canvas/doc-1');
      const editing = await request(testServer)
        .post('/api/sessions/not-a-uuid/canvas/doc-1/editing')
        .send({ editing: true });

      for (const [name, res] of Object.entries({
        listed,
        read,
        opened,
        patched,
        deleted,
        editing,
      })) {
        expect(res.status, `${name} accepted a non-session id`).toBe(400);
        expect(res.body.code).toBe('INVALID_SESSION_ID');
      }
    });

    it('403s a verified agent — a session belongs to one person', async () => {
      const created = await open('https://example.test/private');
      const now = new Date().toISOString();
      db.insert(agents)
        .values({
          id: 'ULID_ANA',
          name: 'ana',
          displayName: 'Ana',
          runtime: 'claude-code',
          projectPath: '/agents/ana',
          behaviorJson: '{"responseMode":"silent"}',
          registeredAt: now,
          updatedAt: now,
        })
        .run();
      const identity = initAgentIdentityService(db);
      const token = await identity.mint({ agentPath: '/agents/ana', displayName: 'Ana' });

      const listed = await request(testServer)
        .get(`/api/sessions/${SESSION}/canvas`)
        .set('X-DorkOS-Agent', token);
      const read = await request(testServer)
        .get(`/api/sessions/${SESSION}/canvas/${created.body.id}`)
        .set('X-DorkOS-Agent', token);
      const opened = await request(testServer)
        .post(`/api/sessions/${SESSION}/canvas`)
        .set('X-DorkOS-Agent', token)
        .send({ content: urlContent('https://example.test/theirs') });

      for (const [name, res] of Object.entries({ listed, read, opened })) {
        expect(res.status, `${name} answered an agent`).toBe(403);
        expect(res.body.code).toBe('PEOPLE_ONLY');
        expect(JSON.stringify(res.body), `${name} leaked the document`).not.toContain(
          'example.test/private'
        );
      }
      // …and nothing it sent landed.
      const listedAsPerson = await request(testServer).get(`/api/sessions/${SESSION}/canvas`);
      expect(listedAsPerson.body.documents).toHaveLength(1);
    });

    it('401s an agent token this machine cannot verify', async () => {
      // A DIFFERENT refusal from the 403 above, and the difference is the point:
      // an unverifiable token is not a caller to be told who may read this, it
      // is a caller who has not been identified at all.
      initAgentIdentityService(db);
      const listed = await request(testServer)
        .get(`/api/sessions/${SESSION}/canvas`)
        .set('X-DorkOS-Agent', 'not-a-real-token');

      expect(listed.status).toBe(401);
      expect(listed.body.code).toBe('AGENT_IDENTITY_UNVERIFIED');
    });

    it('404s a POST to an id that names no session', async () => {
      // A write is the only verb that can MINT a scope, and a scope minted under
      // an id that never was a session is never reclaimed: the orphan sweep only
      // deletes what `onSessionRemoved` marked.
      const opened = await open('https://example.test/ghost', GHOST);
      expect(opened.status).toBe(404);
      expect(opened.body.code).toBe('SESSION_NOT_FOUND');

      const listed = await request(testServer).get(`/api/sessions/${GHOST}/canvas`);
      // The READ is not refused — an empty table is the honest answer and it
      // leaves nothing behind — but it proves nothing was written.
      expect(listed.status).toBe(200);
      expect(listed.body.documents).toEqual([]);
    });

    it('503s when this process stood no canvas up', async () => {
      // The Obsidian embed, and a server mid-boot. An honest refusal rather
      // than a fabricated empty table.
      const { peekCanvasService } = await import('../../services/canvas/index.js');
      expect(peekCanvasService()).toBeDefined();
      vi.spyOn(await import('../../services/canvas/index.js'), 'peekCanvasService').mockReturnValue(
        undefined
      );

      const listed = await request(testServer).get(`/api/sessions/${SESSION}/canvas`);
      expect(listed.status).toBe(503);
      expect(listed.body.code).toBe('CANVAS_UNAVAILABLE');
    });
  });
});
