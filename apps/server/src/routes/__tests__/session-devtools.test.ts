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

  it('rejects a non-UUID session id with 400', async () => {
    const res = await request(app)
      .post('/api/sessions/not-a-uuid/devtools/ingest')
      .send({ seq: 1, console: [], network: [] });
    expect(res.status).toBe(400);
  });
});
