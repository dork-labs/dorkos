/**
 * `/api/documents/comments` (DOR-2983) behind the real `/api` chain: every
 * route 404s while the `docs.enabled` experiment is off; with it on, a thread
 * is opened, answered, resolved, edited and re-anchored on a doc inside the
 * boundary, and a doc outside it is refused.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { initBoundary } from '../../lib/boundary.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createDocCommentRoutes } from '../docs-comments.js';
import { isOwnerInPerson } from '../doc-comment-caller.js';
import { honoRequestFacts } from '../../http/request-facts.js';
import { RoomError } from '../../services/rooms/index.js';
import { resolveDocLocation } from '../../services/docs/comments/index.js';
import {
  ANCHOR,
  createCommentHarness,
} from '../../services/docs/comments/__tests__/comment-harness.js';

// The routes are served through the `/api` chain, whose host guard and session
// gate read the login setting: off, as on a fresh install.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));
vi.mock('../../services/core/auth/index.js', () => ({ readOwnerAccount: () => null }));

let space: string;
let enabled: boolean;
let h: ReturnType<typeof createCommentHarness>;
const listener = swappableServer();

function app() {
  return listener.mount(
    honoGroupListener({
      path: '/api/documents/comments',
      routes: createDocCommentRoutes({
        enabled: () => enabled,
        service: () => h.service,
        // The real person bar over the real request; the author is the owner,
        // as `resolveCaller` answers a login-off request with no agent header.
        writer: (c) => {
          if (c.req.header('x-dorkos-agent')) {
            throw new RoomError(
              'AGENT_IDENTITY_UNVERIFIED',
              'That agent identity could not be verified.'
            );
          }
          return { author: h.owner, inPerson: isOwnerInPerson(honoRequestFacts(c)) };
        },
        locate: resolveDocLocation,
      }),
    })
  );
}

beforeEach(async () => {
  space = realpathSync(mkdtempSync(path.join(tmpdir(), 'docs-comments-route-')));
  writeFileSync(path.join(space, 'plan.md'), 'Ship on Friday.\n');
  await initBoundary(space);
  enabled = true;
  h = createCommentHarness();
});

afterEach(() => {
  rmSync(space, { recursive: true, force: true });
});

describe('/api/documents/comments', () => {
  it('answers 404 on every route while the experiment is off', async () => {
    enabled = false;
    const doc = { cwd: space, path: 'plan.md' };
    await request(app()).get('/api/documents/comments').query(doc).expect(404);
    await request(app()).get('/api/documents/comments/mentionable').expect(404);
    await request(app())
      .post('/api/documents/comments/threads')
      .send({ ...doc, anchor: ANCHOR, body: 'Hi' })
      .expect(404);
    await request(app())
      .put('/api/documents/comments/anchors')
      .send({ ...doc, updates: [] })
      .expect(404);
    expect(h.store.listThreads((await resolveDocLocation(space, 'plan.md')).key)).toEqual([]);
  });

  it('opens, answers, resolves, edits and re-anchors a thread', async () => {
    const doc = { cwd: space, path: './plan.md' };
    const created = await request(app())
      .post('/api/documents/comments/threads')
      .set('X-Client-Id', 'tab-1')
      .send({ ...doc, anchor: ANCHOR, body: 'Ask @scout' })
      .expect(200);
    expect(created.body.unreached).toEqual([]);
    expect(created.body.thread).toMatchObject({ path: 'plan.md', resolved: false });
    const threadId = created.body.thread.id as string;

    const replied = await request(app())
      .post(`/api/documents/comments/threads/${threadId}/replies`)
      .send({ ...doc, body: 'And then?' })
      .expect(200);
    expect(replied.body.thread.comments).toHaveLength(2);

    await request(app())
      .patch(`/api/documents/comments/threads/${threadId}`)
      .send({ ...doc, resolved: true })
      .expect(200)
      .expect((res) => expect(res.body.thread.resolved).toBe(true));

    const commentId = replied.body.thread.comments[1].id as string;
    await request(app())
      .patch(`/api/documents/comments/threads/${threadId}/comments/${commentId}`)
      .send({ ...doc, body: 'And then what?' })
      .expect(200)
      .expect((res) => expect(res.body.thread.comments[1].body).toBe('And then what?'));

    await request(app())
      .put('/api/documents/comments/anchors')
      .send({ ...doc, updates: [{ id: threadId, anchor: { ...ANCHOR, start: 1 } }] })
      .expect(200, { updated: 1 });

    const listed = await request(app())
      .get('/api/documents/comments')
      .query({ cwd: space, path: 'plan.md' })
      .expect(200);
    expect(listed.body.threads).toHaveLength(1);
    expect(listed.body.threads[0].anchor.start).toBe(1);
  });

  it('counts the owner’s words as a request only from the app, in person', async () => {
    const body = { cwd: space, path: 'plan.md', anchor: ANCHOR, body: '@scout check this' };
    await request(app())
      .post('/api/documents/comments/threads')
      .set('X-Client-Id', 'tab-1')
      .send(body)
      .expect(200);
    expect(h.dispatched[0]!.permissionCeiling).toBeUndefined();

    await request(app()).post('/api/documents/comments/threads').send(body).expect(200);
    expect(h.dispatched[1]!.permissionCeiling).toBe('runtime-default');
  });

  it('refuses an unverifiable agent token on every route, reads included', async () => {
    const doc = { cwd: space, path: 'plan.md' };
    const agent = { 'X-DorkOS-Agent': 'revoked' };
    await request(app()).get('/api/documents/comments').set(agent).query(doc).expect(401);
    await request(app()).get('/api/documents/comments/mentionable').set(agent).expect(401);
    await request(app())
      .put('/api/documents/comments/anchors')
      .set(agent)
      .send({ ...doc, updates: [] })
      .expect(401);
  });

  it('refuses a doc that is not a markdown file', async () => {
    await request(app())
      .get('/api/documents/comments')
      .query({ cwd: space, path: 'notes.txt' })
      .expect(400);
  });

  it('lists who a comment can mention', async () => {
    const res = await request(app()).get('/api/documents/comments/mentionable').expect(200);
    expect(res.body.people.map((p: { handle: string }) => p.handle)).toEqual(['quill', 'scout']);
  });

  it('refuses a doc outside the boundary and a malformed path', async () => {
    await request(app())
      .get('/api/documents/comments')
      .query({ cwd: tmpdir(), path: 'plan.md' })
      .expect(403);
    await request(app())
      .get('/api/documents/comments')
      .query({ cwd: space, path: '../escape.md' })
      .expect(400);
  });

  it('answers 404 for a thread on another doc, and 400 for a bad body', async () => {
    await request(app())
      .post('/api/documents/comments/threads/missing/replies')
      .send({ cwd: space, path: 'plan.md', body: 'x' })
      .expect(404);
    await request(app())
      .post('/api/documents/comments/threads')
      .send({ cwd: space, path: 'plan.md', anchor: ANCHOR, body: '   ' })
      .expect(400);
  });
});
