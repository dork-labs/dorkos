import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
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

const app = createApp({ admission: new MainRequestAdmission() });
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

  it('accepts a requested screenshot result (204) and stores it in the buffer slot', async () => {
    const id = crypto.randomUUID();
    void devtoolsCaptureStore.awaitScreenshot('r1', 5000);
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

it('rejects wrong binding atomically through the real HTTP ingest and keeps the exact issued response usable', async () => {
  const id = crypto.randomUUID();
  const binding = { clientId: 'host', documentId: 'doc', bridgeGeneration: 'generation' };
  const base = { ...binding, seq: 1, logicalUrl: 'original', console: [], network: [] };
  await request(testServer)
    .post(`/api/sessions/${id}/devtools/ingest`)
    .set('X-Client-Id', 'host')
    .send({ ...base, active: true, instrumented: true });
  const original = devtoolsCaptureStore.read(id);
  const pending = devtoolsCaptureStore.awaitScreenshot('known', 5000, binding);
  const hostile = {
    ...base,
    reset: true,
    logicalUrl: 'forged',
    console: [{ level: 'error', text: 'forged', timestamp: 1 }],
    screenshot: { requestId: 'known', dataUrl: 'data:image/png;base64,AAAA' },
  };
  for (const [clientId, override] of [
    ['other', {}],
    ['host', { bridgeGeneration: undefined }],
    ['host', { documentId: 'wrong' }],
  ] as const) {
    expect(
      (
        await request(testServer)
          .post(`/api/sessions/${id}/devtools/ingest`)
          .set('X-Client-Id', clientId)
          .send({ ...hostile, ...override })
      ).status
    ).toBe(204);
    expect(devtoolsCaptureStore.read(id)).toEqual(original);
  }
  await request(testServer)
    .post(`/api/sessions/${id}/devtools/ingest`)
    .set('X-Client-Id', 'host')
    .send({ ...base, screenshot: hostile.screenshot });
  expect(await pending).toMatchObject({ ok: true });
  const accepted = devtoolsCaptureStore.read(id);
  await request(testServer)
    .post(`/api/sessions/${id}/devtools/ingest`)
    .set('X-Client-Id', 'host')
    .send(hostile);
  expect(devtoolsCaptureStore.read(id)).toEqual(accepted);
});

it('matches action HTTP by pinned client/document/generation and never infers legacy from a missing response generation', async () => {
  const id = crypto.randomUUID();
  const pending = devtoolsCaptureStore.awaitAction('known', 5000, {
    clientId: 'host',
    documentId: 'doc',
    bridgeGeneration: 'generation',
  });
  const post = (body: object, clientId = 'host') =>
    request(testServer)
      .post(`/api/sessions/${id}/devtools/action`)
      .set('X-Client-Id', clientId)
      .send(body);
  await post({ requestId: 'known', documentId: 'doc', ok: false });
  await post(
    { requestId: 'known', documentId: 'doc', bridgeGeneration: 'generation', ok: false },
    'other'
  );
  await post({ requestId: 'known', documentId: 'doc', bridgeGeneration: 'generation', ok: true });
  expect(await pending).toMatchObject({ ok: true });
});

it('delivers pinned responses exactly once through canonical HTTP after old-generation release and rekey', async () => {
  const temporary = crypto.randomUUID();
  const canonical = crypto.randomUUID();
  const binding = { clientId: 'host', documentId: 'doc', bridgeGeneration: 'accepted-generation' };
  const base = { ...binding, logicalUrl: 'accepted-page', seq: 1, console: [], network: [] };
  const post = (id: string, suffix: string, body: object) =>
    request(testServer)
      .post(`/api/sessions/${id}/devtools/${suffix}`)
      .set('X-Client-Id', 'host')
      .send(body);
  await post(temporary, 'ingest', { ...base, active: true, instrumented: true });
  const screenshot = devtoolsCaptureStore.awaitScreenshot('deferred-capture', 5000, binding);
  const action = devtoolsCaptureStore.awaitAction('deferred-action', 5000, binding);
  // These are immutable host-accepted envelopes. HTTP has not reached the route yet.
  const acceptedCapture = {
    ...base,
    hostOutcome: 'page-reported',
    screenshot: { requestId: 'deferred-capture', dataUrl: 'data:image/png;base64,AAAA' },
  };
  const acceptedAction = {
    ...binding,
    requestId: 'deferred-action',
    hostOutcome: 'page-reported',
    ok: true,
  };
  await post(temporary, 'ingest', { ...base, active: false });
  devtoolsCaptureStore.rekeySession(temporary, canonical);
  await post(canonical, 'ingest', {
    ...base,
    bridgeGeneration: 'replacement',
    active: true,
    instrumented: true,
  });
  expect((await post(canonical, 'ingest', acceptedCapture)).status).toBe(204);
  expect((await post(canonical, 'action', acceptedAction)).status).toBe(204);
  expect(await screenshot).toMatchObject({ ok: true });
  expect(await action).toMatchObject({ ok: true, bridgeGeneration: 'accepted-generation' });
  const after = devtoolsCaptureStore.read(canonical);
  await post(canonical, 'ingest', {
    ...acceptedCapture,
    reset: true,
    logicalUrl: 'duplicate',
    console: [{ level: 'log', text: 'duplicate', timestamp: 1 }],
  });
  await post(canonical, 'action', { ...acceptedAction, ok: false, error: 'duplicate' });
  await post(canonical, 'ingest', {
    ...base,
    reset: true,
    console: [{ level: 'log', text: 'retired unsolicited', timestamp: 1 }],
  });
  expect(devtoolsCaptureStore.read(canonical)).toEqual(after);
});

it('parses standalone host recording admission and rejects mixed outcomes before any store mutation', async () => {
  const id = crypto.randomUUID();
  const binding = { clientId: 'recording-host', documentId: 'doc', bridgeGeneration: 'gen' };
  devtoolsCaptureStore.ingest(
    id,
    { seq: 0, console: [], network: [], ...binding, active: true, instrumented: true },
    binding.clientId
  );
  devtoolsCaptureStore.startRecording(id, { id: 'film', ...binding });
  const wait = devtoolsCaptureStore.awaitRecordingStart('start-request', {
    recordingId: 'film',
    phase: 'reserved',
    binding,
    timeoutMs: 1000,
  });
  const payload = {
    hostOutcome: 'host',
    documentId: 'doc',
    bridgeGeneration: 'gen',
    seq: 0,
    console: [],
    network: [],
    recordingStart: {
      requestId: 'start-request',
      recordingId: 'film',
      phase: 'reserved',
      ok: true,
    },
  };
  const post = (body: unknown) =>
    request(testServer)
      .post(`/api/sessions/${id}/devtools/ingest`)
      .set('X-Client-Id', binding.clientId)
      .send(body);
  const before = devtoolsCaptureStore.read(id);
  expect(
    (await post({ ...payload, reset: true, logicalUrl: 'forged', active: false })).status
  ).toBe(204);
  expect(devtoolsCaptureStore.read(id)).toEqual(before);
  expect((await post(payload)).status).toBe(204);
  expect(await wait).toEqual(payload.recordingStart);
  expect(devtoolsCaptureStore.read(id)).toEqual(before);
});
