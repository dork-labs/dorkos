import { describe, it, expect, afterEach, vi } from 'vitest';

// Config/tunnel are stubbed so createApp builds without a live server, and the
// session gate is a pass-through (auth disabled) — the ingest route relies on the
// app-wide gate exactly as the other /api/sessions routes do.
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { devtoolsCaptureStore } from '../../services/session/index.js';

const app = createApp();

function ingest(body: unknown, id = crypto.randomUUID()) {
  return request(app).post(`/api/sessions/${id}/devtools/ingest`).send(body);
}

afterEach(() => devtoolsCaptureStore.clear());

describe('POST /api/sessions/:id/devtools/ingest', () => {
  it('accepts a valid batch (204) and appends it to the session buffer', async () => {
    const id = crypto.randomUUID();
    const res = await ingest(
      {
        seq: 1,
        console: [{ level: 'error', text: 'boom', timestamp: Date.now() }],
        network: [
          {
            method: 'GET',
            url: '/x',
            status: 404,
            ok: false,
            durationMs: 3,
            timestamp: Date.now(),
          },
        ],
      },
      id
    );
    expect(res.status).toBe(204);
    const buf = devtoolsCaptureStore.read(id);
    expect(buf?.console[0].text).toBe('boom');
    expect(buf?.network[0].status).toBe(404);
  });

  it('accepts a well-formed id with NO session-existence check (deliberate posture)', async () => {
    // Mirrors the durable event stream's posture (session-events-handler.ts,
    // DOR-74): hasSession() is in-memory only, so a restarted server or a
    // historical session reopened from disk is "unknown" exactly when the
    // rehydrated preview's page-load captures arrive. A 404 here would silently
    // drop the page-load errors Phase 2's browser_read_console exists to
    // surface. Containment lives in the store (byte budget + session LRU cap),
    // which is what makes this permissive posture safe.
    const id = crypto.randomUUID(); // never seen by any runtime
    const res = await ingest(
      { seq: 1, console: [{ level: 'error', text: 'page-load error', timestamp: 1 }], network: [] },
      id
    );
    expect(res.status).toBe(204);
    expect(devtoolsCaptureStore.read(id)?.console[0].text).toBe('page-load error');
  });

  it('rejects a malformed batch with 400', async () => {
    const res = await ingest({ seq: 'not-a-number', console: [], network: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an over-cap batch with 413 (distinct from a malformed 400)', async () => {
    const console = Array.from({ length: 501 }, () => ({
      level: 'log' as const,
      text: 'x',
      timestamp: Date.now(),
    }));
    const res = await ingest({ seq: 1, console, network: [] });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('BATCH_TOO_LARGE');
  });

  it('rejects an entry whose serialized args exceed the size cap with 413', async () => {
    // 50 args of ~1 KB each ≈ 50 KB serialized — over DEVTOOLS_ARGS_MAX_CHARS.
    // Each element passes the shape checks; only the size refine catches it.
    const id = crypto.randomUUID();
    const res = await ingest(
      {
        seq: 1,
        console: [
          {
            level: 'log',
            text: 'crafted',
            args: Array.from({ length: 50 }, () => 'z'.repeat(1024)),
            timestamp: Date.now(),
          },
        ],
        network: [],
      },
      id
    );
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('BATCH_TOO_LARGE');
    // Nothing lands in the buffer for a rejected batch.
    expect(devtoolsCaptureStore.read(id)).toBeUndefined();
  });

  it('rejects a non-UUID session id with 400', async () => {
    const res = await request(app)
      .post('/api/sessions/not-a-uuid/devtools/ingest')
      .send({ seq: 1, console: [], network: [] });
    expect(res.status).toBe(400);
  });
});
