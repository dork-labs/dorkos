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

import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createApp } from '../../app.js';
import { devtoolsCaptureStore } from '../../services/session/index.js';

const app = createApp();
const testServer = listeningServer(app);

function ingest(body: unknown, id = crypto.randomUUID()) {
  return request(testServer).post(`/api/sessions/${id}/devtools/ingest`).send(body);
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
    const res = await request(testServer)
      .post('/api/sessions/not-a-uuid/devtools/ingest')
      .send({ seq: 1, console: [], network: [] });
    expect(res.status).toBe(400);
  });

  it('accepts a screenshot result (204) and stores it in the buffer slot', async () => {
    const id = crypto.randomUUID();
    const res = await ingest(
      {
        seq: 1,
        console: [],
        network: [],
        screenshot: { requestId: 'r1', dataUrl: 'data:image/png;base64,AAAA' },
      },
      id
    );
    expect(res.status).toBe(204);
    expect(devtoolsCaptureStore.read(id)?.screenshot?.requestId).toBe('r1');
  });

  it('rejects an oversized screenshot data URL with 413 — a hostile page cannot park megabytes', async () => {
    const id = crypto.randomUUID();
    const res = await ingest(
      {
        seq: 1,
        console: [],
        network: [],
        // One char over DEVTOOLS_SCREENSHOT_MAX_CHARS (900_000).
        screenshot: { requestId: 'r1', dataUrl: 'x'.repeat(900_001) },
      },
      id
    );
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('BATCH_TOO_LARGE');
    expect(devtoolsCaptureStore.read(id)).toBeUndefined();
  });
});

describe('the driver seat rides the ingest route', () => {
  it('keeps one claim per window, read off X-Client-Id', async () => {
    const id = crypto.randomUUID();
    await request(testServer)
      .post(`/api/sessions/${id}/devtools/ingest`)
      .set('X-Client-Id', 'window-a')
      .send({ documentId: 'doc-a', seq: 1, console: [], network: [], active: true });
    await request(testServer)
      .post(`/api/sessions/${id}/devtools/ingest`)
      .set('X-Client-Id', 'window-b')
      .send({
        documentId: 'doc-b',
        seq: 1,
        console: [],
        network: [],
        active: true,
        instrumented: true,
      });

    // The seat is the later claim, and the earlier one is still addressable by
    // its own page id.
    expect(devtoolsCaptureStore.resolveDriver(id)).toMatchObject({
      clientId: 'window-b',
      documentId: 'doc-b',
      instrumented: true,
    });
    expect(devtoolsCaptureStore.resolveDriver(id, 'doc-a')).toMatchObject({
      clientId: 'window-a',
    });
  });

  it('refuses a seat to a caller that sent no client id, in both directions', async () => {
    const id = crypto.randomUUID();
    await request(testServer)
      .post(`/api/sessions/${id}/devtools/ingest`)
      .set('X-Client-Id', 'window-a')
      .send({ documentId: 'doc-a', seq: 1, console: [], network: [], active: true });

    // TAKING is the direction that matters: a header-less claim used to be given
    // a per-request UUID, which is by definition the most recent claim — so it
    // took the seat from the window really showing the page, and every verb
    // afterwards addressed a client that does not exist and timed out.
    const claimed = await request(testServer)
      .post(`/api/sessions/${id}/devtools/ingest`)
      .send({ documentId: 'doc-b', seq: 1, console: [], network: [], active: true });
    expect(claimed.status).toBe(204);
    expect(devtoolsCaptureStore.resolveDriver(id)).toMatchObject({ clientId: 'window-a' });
    expect(devtoolsCaptureStore.resolveDriver(id, 'doc-b')).toBeUndefined();

    // And releasing: it cannot drop a seat it never held either.
    await request(testServer)
      .post(`/api/sessions/${id}/devtools/ingest`)
      .send({ documentId: 'doc-a', seq: 1, console: [], network: [], active: false });
    expect(devtoolsCaptureStore.resolveDriver(id)).toMatchObject({ clientId: 'window-a' });
  });

  it('still takes the captures of a caller that sent no client id', async () => {
    // The refusal is about the SEAT, never about the relay: a preview whose
    // window has no id still reports its console to the agent.
    const id = crypto.randomUUID();
    const res = await request(testServer)
      .post(`/api/sessions/${id}/devtools/ingest`)
      .send({
        documentId: 'doc-a',
        seq: 1,
        console: [{ level: 'error', text: 'boom', timestamp: Date.now() }],
        network: [],
      });
    expect(res.status).toBe(204);
    expect(devtoolsCaptureStore.read(id)?.console[0].text).toBe('boom');
  });
});

describe('POST /api/sessions/:id/devtools/action', () => {
  function postAction(body: unknown, id = crypto.randomUUID()) {
    return request(testServer).post(`/api/sessions/${id}/devtools/action`).send(body);
  }

  it('accepts a result (204) and resolves the tool call awaiting it', async () => {
    const pending = devtoolsCaptureStore.awaitAction('req-route-1', 2_000);
    const res = await postAction({
      requestId: 'req-route-1',
      ok: true,
      did: 'Clicked button "Pay $42.00".',
      matched: 1,
      page: { title: 'Checkout', url: 'https://preview/checkout', focused: null },
    });
    expect(res.status).toBe(204);
    await expect(pending).resolves.toMatchObject({ ok: true, matched: 1 });
  });

  it('accepts a result nobody is awaiting, because the tool may have timed out', async () => {
    const res = await postAction({ requestId: 'nobody-waits', ok: true });
    expect(res.status).toBe(204);
  });

  it('rejects a malformed result (400)', async () => {
    const res = await postAction({ requestId: 'req-2' });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed session id (400)', async () => {
    const res = await request(testServer)
      .post('/api/sessions/not a session/devtools/action')
      .send({ requestId: 'req-3', ok: true });
    expect(res.status).toBe(400);
  });
});
