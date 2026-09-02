/**
 * @vitest-environment node
 *
 * `GET /api/sessions/:id/attachments/:file` — the route the message part's URL
 * points at.
 *
 * Mounted on a bare Express app rather than the whole application: the handler
 * is the unit under test, and `createApp()` would drag in the entire service
 * graph to assert a `Content-Type` header.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sessionAttachmentHandler } from '../session-attachments-handler.js';
import {
  LocalSessionAttachmentStore,
  resetSessionAttachmentStore,
  setSessionAttachmentStore,
} from '../../services/session/attachments/index.js';

const SESSION = '11111111-2222-4333-8444-555555555555';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const app = express();
app.get('/api/sessions/:id/attachments/:file', sessionAttachmentHandler);

describe('GET /api/sessions/:id/attachments/:file', () => {
  let dorkHome: string;
  let store: LocalSessionAttachmentStore;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-attachment-route-'));
    store = new LocalSessionAttachmentStore(dorkHome);
    setSessionAttachmentStore(store);
  });

  afterEach(async () => {
    resetSessionAttachmentStore();
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('serves the bytes inline, typed by the stored suffix, with nosniff', async () => {
    const { url } = await store.put(SESSION, 'abc123', 'image/png', PNG);

    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(Buffer.from(res.body)).toEqual(PNG);
  });

  it('answers 304 to a matching If-None-Match, without re-reading the file', async () => {
    const { url } = await store.put(SESSION, 'abc123', 'image/png', PNG);
    const first = await request(app).get(url);

    const second = await request(app).get(url).set('If-None-Match', first.headers.etag);

    expect(second.status).toBe(304);
  });

  it('keeps the ETag stable across the touch that retention depends on', async () => {
    // These two mechanisms nearly cancelled each other out: the ETag was
    // size-plus-MTIME, and `touch` moves mtime by design, so every fetch
    // invalidated the cache entry the previous fetch had just created. The
    // validator is keyed on the attachment id instead — the file is written
    // once under a derived id and never rewritten with different bytes.
    const { url } = await store.put(SESSION, 'abc123', 'image/png', PNG);
    const first = await request(app).get(url);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await request(app).get(url);

    expect(second.headers.etag).toBe(first.headers.etag);
    const third = await request(app).get(url).set('If-None-Match', second.headers.etag);
    expect(third.status).toBe(304);
  });

  it('marks the image as in use when somebody fetches it', async () => {
    // Retention deletes by modification time, and every other path that meets
    // an existing image only `stat`s it — `peek` deliberately skips the write.
    // Without this touch an mtime never moves after the first write, and a
    // transcript somebody opens every day still loses its picture on day 90.
    const { url } = await store.put(SESSION, 'abc123', 'image/png', PNG);
    const dir = path.join(dorkHome, 'sessions', SESSION, 'attachments');
    const before = new Date(Date.now() - 60 * 60 * 1000);
    await utimes(path.join(dir, 'abc123.png'), before, before);

    await request(app).get(url);
    // `touch` is fire-and-forget so the response never waits on it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const after = await stat(path.join(dir, 'abc123.png'));
    expect(after.mtimeMs).toBeGreaterThan(before.getTime());
  });

  it('404s an id that is not there', async () => {
    const res = await request(app).get(`/api/sessions/${SESSION}/attachments/nothing.png`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ATTACHMENT_NOT_FOUND');
  });

  it('400s a malformed session id', async () => {
    const res = await request(app).get('/api/sessions/not-a-uuid/attachments/abc123.png');

    expect(res.status).toBe(400);
  });

  it('404s a traversal attempt rather than telling the prober it was recognized', async () => {
    const res = await request(app).get(
      `/api/sessions/${SESSION}/attachments/${encodeURIComponent('../../../etc/passwd')}`
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ATTACHMENT_NOT_FOUND');
  });

  it('refuses to serve an SVG even when one is sitting in the directory', async () => {
    // Nothing writes one — this proves the READ side refuses it too, so a file
    // that arrived by any other means still cannot execute on this origin.
    const dir = path.join(dorkHome, 'sessions', SESSION, 'attachments');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'evil.svg'), '<svg onload="alert(1)"/>');

    const res = await request(app).get(`/api/sessions/${SESSION}/attachments/evil.svg`);

    expect(res.status).toBe(404);
  });

  it('404s when no store is wired at all', async () => {
    const { url } = await store.put(SESSION, 'abc123', 'image/png', PNG);
    resetSessionAttachmentStore();

    const res = await request(app).get(url);

    expect(res.status).toBe(404);
  });
});
