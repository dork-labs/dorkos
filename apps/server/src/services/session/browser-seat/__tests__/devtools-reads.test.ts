import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DevtoolsConsoleEntry, DevtoolsNetworkEntry } from '@dorkos/shared/schemas';
import { noopLogger } from '@dorkos/shared/logger';
import {
  readConsole,
  readNetwork,
  takeScreenshot,
  type DevtoolsReadStore,
  type ReadConsoleInput,
  type ReadNetworkInput,
} from '../devtools-reads.js';
import { CapabilityImageResult, composeRegistry } from '../../../core/capabilities/index.js';
import { uiDomain } from '../ui-capabilities.js';
import type { RawSessionEvent } from '../../session-state-projector.js';
import { DevtoolsCaptureStore } from '../../devtools-capture-store.js';

// The window a screenshot request reaches is the calling session's stream.
// Captured rather than stood up: what these tests are about is which request the
// handler minted and how it read the answer back.
const reach = vi.hoisted(() => ({ emitted: [] as RawSessionEvent[], reached: true }));
vi.mock('../session-reach.js', () => ({
  emitToSession: (_sessionId: string, event: RawSessionEvent) => {
    if (reach.reached) reach.emitted.push(event);
    return reach.reached;
  },
}));

const SESSION_ID = 'sess-1';
const resolveSession = () => SESSION_ID;

/**
 * The handler shape these cases were written against, over the capability
 * handlers that replaced them.
 *
 * The verbs take a session id resolved by their SURFACE now, which is the whole
 * point of the `ui` domain — but what each case below asserts is the read
 * itself, so binding the id once here keeps every case about the thing it names.
 */
function createReadConsoleHandler(resolve: () => string | undefined, store: DevtoolsReadStore) {
  return (input: Record<string, unknown> = {}) =>
    readConsole(input as ReadConsoleInput, resolve(), store);
}

/** The network read, bound the same way. */
function createReadNetworkHandler(resolve: () => string | undefined, store: DevtoolsReadStore) {
  return (input: Record<string, unknown> = {}) =>
    readNetwork(input as ReadNetworkInput, resolve(), store);
}

/** The screenshot round trip, bound the same way. */
function createBrowserScreenshotHandler(
  resolve: () => string | undefined,
  store: DevtoolsReadStore,
  timeoutMs: number
) {
  return () => takeScreenshot(resolve(), store, timeoutMs);
}

/** The plain payload a `ui` verb answers with. */
function parse(payload: unknown): Record<string, unknown> {
  return payload as Record<string, unknown>;
}

function consoleEntry(over: Partial<DevtoolsConsoleEntry> = {}): DevtoolsConsoleEntry {
  return { level: 'log', text: 'hello', timestamp: 1, ...over };
}

function networkEntry(over: Partial<DevtoolsNetworkEntry> = {}): DevtoolsNetworkEntry {
  return {
    method: 'GET',
    url: 'http://localhost:3000/api',
    status: 200,
    ok: true,
    durationMs: 12,
    timestamp: 1,
    ...over,
  };
}

/** A store seeded with one ingest batch for `sessionId` (default SESSION_ID). */
function seededStore(
  consoleEntries: DevtoolsConsoleEntry[],
  networkEntries: DevtoolsNetworkEntry[] = [],
  sessionId = SESSION_ID
): DevtoolsCaptureStore {
  const store = new DevtoolsCaptureStore();
  store.ingest(sessionId, {
    seq: 1,
    logicalUrl: 'http://localhost:3000/',
    documentId: 'doc-1',
    console: consoleEntries,
    network: networkEntries,
  });
  return store;
}

describe('browser_read_console handler', () => {
  it('returns captured console entries with the document header', async () => {
    const store = seededStore([
      consoleEntry({ level: 'error', text: 'boom', stack: 'at App.tsx:42', timestamp: 10 }),
    ]);
    const result = parse(await createReadConsoleHandler(resolveSession, store)({}));

    expect(result.documentUrl).toBe('http://localhost:3000/');
    expect(typeof result.capturedAt).toBe('number');
    expect(result.entries).toHaveLength(1);
    expect((result.entries as DevtoolsConsoleEntry[])[0]).toMatchObject({
      level: 'error',
      text: 'boom',
      stack: 'at App.tsx:42',
    });
    expect(result.truncated).toBe(false);
    expect(result.note).toBeUndefined();
  });

  it('filters by level', async () => {
    const store = seededStore([
      consoleEntry({ level: 'log', text: 'a', timestamp: 1 }),
      consoleEntry({ level: 'error', text: 'b', timestamp: 2 }),
      consoleEntry({ level: 'warn', text: 'c', timestamp: 3 }),
    ]);
    const result = parse(await createReadConsoleHandler(resolveSession, store)({ level: 'error' }));

    const entries = result.entries as DevtoolsConsoleEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('b');
  });

  it('honors limit, returns the newest entries, and flags truncated', async () => {
    const store = seededStore(
      Array.from({ length: 10 }, (_, i) => consoleEntry({ text: `line-${i}`, timestamp: i }))
    );
    const result = parse(await createReadConsoleHandler(resolveSession, store)({ limit: 3 }));

    const entries = result.entries as DevtoolsConsoleEntry[];
    expect(entries.map((e) => e.text)).toEqual(['line-7', 'line-8', 'line-9']);
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/most recent of 10/i);
  });

  it('flags truncated when the server ring evicted by count cap', async () => {
    // 501 entries: the 500-cap ring drops the oldest and flags consoleEvicted.
    const store = seededStore(
      Array.from({ length: 501 }, (_, i) => consoleEntry({ text: `l${i}`, timestamp: i }))
    );
    const result = parse(await createReadConsoleHandler(resolveSession, store)({ limit: 500 }));

    expect((result.entries as DevtoolsConsoleEntry[]).length).toBeLessThanOrEqual(500);
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/buffer overflowed/i);
  });

  it('flags truncated when the byte budget evicted below the count cap', async () => {
    // ~60 entries of ~20 KB each (~1.2 MB) blow the 1 MB session budget while
    // the ring count stays far below 500 — a count-only check would lie here.
    const store = seededStore(
      Array.from({ length: 60 }, (_, i) =>
        consoleEntry({ text: `${i}:${'x'.repeat(20_000)}`, timestamp: i })
      )
    );
    const result = parse(await createReadConsoleHandler(resolveSession, store)({ limit: 10 }));

    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/buffer overflowed/i);
  });

  it('elides oversized text/stack/args per entry with an explicit marker', async () => {
    const store = seededStore([
      consoleEntry({
        text: 'y'.repeat(10_000),
        stack: 's'.repeat(10_000),
        args: ['z'.repeat(10_000)],
        timestamp: 1,
      }),
    ]);
    const result = parse(await createReadConsoleHandler(resolveSession, store)({}));

    const entry = (result.entries as DevtoolsConsoleEntry[])[0];
    expect(entry.text.length).toBeLessThan(2_200);
    expect(entry.text).toMatch(/\[truncated \d+ chars\]/);
    expect(entry.stack!.length).toBeLessThan(2_200);
    expect(entry.stack).toMatch(/\[truncated \d+ chars\]/);
    expect(entry.args).toHaveLength(1);
    expect(String(entry.args![0])).toMatch(/\[args elided: \d+ chars/);
  });

  it('drops the oldest entries past the total result byte budget', async () => {
    // 50 entries of ~2 KB text survive elision untouched (~2 KB serialized each
    // ≈ 100 KB total), so the ~64 KB result budget must drop the oldest.
    const store = seededStore(
      Array.from({ length: 50 }, (_, i) =>
        consoleEntry({ text: `${i}:${'x'.repeat(2_000)}`, timestamp: i })
      )
    );
    const result = parse(await createReadConsoleHandler(resolveSession, store)({ limit: 50 }));

    const entries = result.entries as DevtoolsConsoleEntry[];
    expect(entries.length).toBeLessThan(50);
    expect(entries.length).toBeGreaterThan(0);
    // Newest entry always survives.
    expect(entries[entries.length - 1].text.startsWith('49:')).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/size budget/i);
  });

  it('returns the no-preview note when the session never captured anything', async () => {
    const store = new DevtoolsCaptureStore();
    const result = parse(await createReadConsoleHandler(resolveSession, store)({}));

    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.note).toMatch(/browser_navigate/i);
    expect(result.documentUrl).toBeUndefined();
  });

  it('returns a connected-but-silent note when the console ring is empty', async () => {
    const store = seededStore([], [networkEntry()]);
    const result = parse(await createReadConsoleHandler(resolveSession, store)({}));

    expect(result.entries).toEqual([]);
    expect(result.note).toMatch(/connected but has logged nothing/i);
    expect(result.documentUrl).toBe('http://localhost:3000/');
  });

  it('says entries exist at other levels when the filter matches nothing', async () => {
    const store = seededStore([
      consoleEntry({ level: 'warn', text: 'w1', timestamp: 1 }),
      consoleEntry({ level: 'warn', text: 'w2', timestamp: 2 }),
    ]);
    const result = parse(await createReadConsoleHandler(resolveSession, store)({ level: 'error' }));

    expect(result.entries).toEqual([]);
    expect(result.note).toMatch(/no console entries at level "error"/i);
    expect(result.note).toMatch(/2 entries at other levels/i);
    expect(result.note).not.toMatch(/logged nothing/i);
  });

  it('resolves the session id at read time, surviving a first-turn rekey', async () => {
    // The buffer lives under the CANONICAL id (the client + ingest switched to
    // it mid-first-turn); the id known at registration time was the request
    // UUID. A resolver reading the live session's sdkSessionId must hit it.
    const store = seededStore([consoleEntry({ text: 'rekeyed', timestamp: 1 })], [], 'canonical');
    const session = { sdkSessionId: 'request-uuid' };
    const handler = createReadConsoleHandler(() => session.sdkSessionId, store);

    // The SDK init assigns the canonical id AFTER the tools were registered.
    session.sdkSessionId = 'canonical';

    const result = parse(await handler({}));
    expect((result.entries as DevtoolsConsoleEntry[])[0]?.text).toBe('rekeyed');
    expect(result.note).toBeUndefined();
  });

  it('refuses an out-of-range limit at the registry, before the handler runs', async () => {
    // The bound moved with the verb: the capability's own input schema is what
    // the tool advertises and what `registry.invoke` parses against, so a `limit`
    // past the ring size is refused before any buffer is touched.
    const registry = composeRegistry([uiDomain], { logger: noopLogger });

    await expect(
      registry.invoke('ui.read_console', { limit: 501 }, { sessionId: SESSION_ID })
    ).rejects.toThrow(/limit/i);
  });
});

describe('browser_read_network handler', () => {
  it('returns captured requests with method/url/status/duration/size', async () => {
    const store = seededStore(
      [],
      [networkEntry({ status: 404, ok: false, responseSize: 128, timestamp: 5 })]
    );
    const result = parse(await createReadNetworkHandler(resolveSession, store)({}));

    const requests = result.requests as DevtoolsNetworkEntry[];
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      status: 404,
      ok: false,
      durationMs: 12,
      responseSize: 128,
    });
  });

  it('"failed" matches network errors and 4xx/5xx, never redirects', async () => {
    const store = seededStore(
      [],
      [
        networkEntry({ status: 200, ok: true, timestamp: 1 }),
        // A redirect an XHR capture may have recorded with ok=false — still not
        // a failure: "failed" is status-based, identical for fetch and XHR.
        networkEntry({ status: 302, ok: false, timestamp: 2 }),
        networkEntry({ status: 0, ok: false, timestamp: 3 }),
        networkEntry({ status: 500, ok: false, timestamp: 4 }),
      ]
    );
    const result = parse(
      await createReadNetworkHandler(resolveSession, store)({ status: 'failed' })
    );

    const requests = result.requests as DevtoolsNetworkEntry[];
    expect(requests.map((r) => r.status)).toEqual([0, 500]);
  });

  it('filters by status class', async () => {
    const store = seededStore(
      [],
      [
        networkEntry({ status: 201, ok: true, timestamp: 1 }),
        networkEntry({ status: 404, ok: false, timestamp: 2 }),
        networkEntry({ status: 502, ok: false, timestamp: 3 }),
      ]
    );
    const result = parse(await createReadNetworkHandler(resolveSession, store)({ status: '4xx' }));

    const requests = result.requests as DevtoolsNetworkEntry[];
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe(404);
  });

  it('honors limit and flags truncated', async () => {
    const store = seededStore(
      [],
      Array.from({ length: 6 }, (_, i) =>
        networkEntry({ url: `http://localhost/${i}`, timestamp: i })
      )
    );
    const result = parse(await createReadNetworkHandler(resolveSession, store)({ limit: 2 }));

    const requests = result.requests as DevtoolsNetworkEntry[];
    expect(requests.map((r) => r.url)).toEqual(['http://localhost/4', 'http://localhost/5']);
    expect(result.truncated).toBe(true);
  });

  it('caps limit at the network ring size (200), not the console ring size', async () => {
    // Its own ring, its own bound — asserted through the registry, which is what
    // parses a call against the schema the tool advertises.
    const registry = composeRegistry([uiDomain], { logger: noopLogger });
    const call = (limit: number) =>
      registry.invoke('ui.read_network', { limit }, { sessionId: SESSION_ID });

    await expect(call(300)).rejects.toThrow(/limit/i);
    await expect(call(200)).resolves.toBeDefined();
  });

  it('says requests exist at other statuses when the filter matches nothing', async () => {
    const store = seededStore([], [networkEntry({ status: 200, ok: true, timestamp: 1 })]);
    const result = parse(
      await createReadNetworkHandler(resolveSession, store)({ status: 'failed' })
    );

    expect(result.requests).toEqual([]);
    expect(result.note).toMatch(/no requests matching status "failed"/i);
    expect(result.note).toMatch(/1 captured request in total/i);
  });

  it('returns the no-preview note when nothing captured', async () => {
    const store = new DevtoolsCaptureStore();
    const result = parse(await createReadNetworkHandler(resolveSession, store)({}));

    expect(result.requests).toEqual([]);
    expect(result.note).toMatch(/browser_navigate/i);
  });
});

describe('the three reads as `ui` capabilities', () => {
  const registry = composeRegistry([uiDomain], { logger: noopLogger });

  it('are registered under the names the model already knows', () => {
    const names = registry.capabilities
      .filter((c) => c.id.startsWith('ui.'))
      .map((c) => c.surfaces.mcp!.toolName);
    expect(names).toEqual(expect.arrayContaining(['browser_read_console', 'browser_read_network', 'browser_screenshot']));
  });

  it('reach no surface but the in-session one', () => {
    for (const capability of registry.capabilities.filter((c) => c.id.startsWith('ui.'))) {
      expect(capability.surfaces.mcp!.servers, capability.id).toEqual(['in-session']);
    }
  });

  it('refuse a surface with no session rather than fabricating an empty read', async () => {
    for (const id of ['ui.read_console', 'ui.read_network', 'ui.screenshot']) {
      await expect(registry.invoke(id, {}), id).rejects.toMatchObject({
        payload: expect.objectContaining({
          error: expect.stringMatching(/require an attached interactive session/i),
        }),
      });
    }
  });

  it('read the calling session’s buffer, and nothing it was passed', async () => {
    // There is no session ARGUMENT to pass, which is the security property: the
    // only session a read can name is the one the surface verified.
    const store = seededStore([consoleEntry({ text: 'live', timestamp: 1 })]);
    const parsed = parse(await readConsole({}, SESSION_ID, store));
    expect((parsed.entries as DevtoolsConsoleEntry[])[0].text).toBe('live');

    const other = parse(await readConsole({}, 'some-other-session', store));
    expect(other.entries).toEqual([]);
  });
});

describe('browser_screenshot handler', () => {
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg==';
  const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

  beforeEach(() => {
    reach.emitted.length = 0;
    reach.reached = true;
  });

  /** The requestId the handler stamped on the capture request it pushed. */
  function enqueuedRequestId(): string {
    const event = reach.emitted[0] as unknown as { type: string; requestId: string };
    expect(event.type).toBe('devtools_capture_request');
    expect(typeof event.requestId).toBe('string');
    return event.requestId;
  }

  it('returns the no-preview note immediately when no capture buffer exists', async () => {
    const store = new DevtoolsCaptureStore();
    const handler = createBrowserScreenshotHandler(resolveSession, store, 5);
    const result = parse(await handler());

    expect(result.captured).toBe(false);
    expect(result.note).toMatch(/browser_navigate/i);
    // No pointless round-trip was started.
    expect(reach.emitted).toHaveLength(0);
  });

  it('puts a devtools_capture_request on the calling session’s stream', async () => {
    const store = seededStore([]);
    const handler = createBrowserScreenshotHandler(resolveSession, store, 10);
    const pending = handler();
    expect(enqueuedRequestId()).toBeTruthy();
    await pending; // times out quickly; this test only asserts the push
  });

  it('says so at once when the session has no live stream to reach', async () => {
    // Nothing is reading, so nothing was ever going to answer. Waiting out the
    // round trip and then blaming the page would be the wrong sentence.
    reach.reached = false;
    const store = seededStore([]);
    const result = parse(await createBrowserScreenshotHandler(resolveSession, store, 5_000)());
    expect(result.captured).toBe(false);
    expect(result.note).toMatch(/browser_navigate/i);
  });

  it('addresses the capture to the driver seat when a window has claimed one', async () => {
    // The race `use-devtools-bridge.ts` used to carry as a known limitation: with
    // several previews open, an untargeted request reached every bridge and the
    // first answer won. Now the server names the window and the page, and every
    // other bridge ignores it.
    const store = seededStore([]);
    store.ingest(
      SESSION_ID,
      { documentId: 'doc-a', seq: 1, console: [], network: [], active: true, instrumented: true },
      'window-a'
    );
    store.ingest(
      SESSION_ID,
      { documentId: 'doc-b', seq: 1, console: [], network: [], active: true, instrumented: true },
      'window-b'
    );
    const handler = createBrowserScreenshotHandler(resolveSession, store, 10);
    const pending = handler();

    const event = reach.emitted[0] as unknown as {
      targetClientId?: string;
      documentId?: string;
    };
    expect(event.targetClientId).toBe('window-b');
    expect(event.documentId).toBe('doc-b');
    await pending;
  });

  it('sends an untargeted capture when no window has claimed a seat', async () => {
    // A client that predates the seat never claims, and must keep working.
    const store = seededStore([]);
    const handler = createBrowserScreenshotHandler(resolveSession, store, 10);
    const pending = handler();

    const event = reach.emitted[0] as unknown as {
      targetClientId?: string;
      documentId?: string;
    };
    expect(event.targetClientId).toBeUndefined();
    expect(event.documentId).toBeUndefined();
    await pending;
  });

  it('resolves with MCP image content when the matching ingest arrives', async () => {
    const store = seededStore([]);
    const handler = createBrowserScreenshotHandler(resolveSession, store, 5_000);
    const pending = handler();
    const requestId = enqueuedRequestId();

    store.ingest(SESSION_ID, {
      seq: 2,
      console: [],
      network: [],
      screenshot: { requestId, dataUrl: PNG_DATA_URL },
    });

    const result = await pending;
    expect(result).toBeInstanceOf(CapabilityImageResult);
    const picture = result as CapabilityImageResult;
    expect(picture.image).toEqual({ data: PNG_B64, mimeType: 'image/png' });
    const meta = picture.payload as { documentUrl: string; capturedAt: number };
    expect(meta.documentUrl).toBe('http://localhost:3000/');
    expect(typeof meta.capturedAt).toBe('number');
  });

  it('resolves even when the ingest lands under a rekeyed (canonical) session id', async () => {
    const store = seededStore([]);
    const handler = createBrowserScreenshotHandler(resolveSession, store, 5_000);
    const pending = handler();
    const requestId = enqueuedRequestId();

    // First-turn rekey: the client now ingests under the canonical id.
    store.rekeySession(SESSION_ID, 'canonical');
    store.ingest('canonical', {
      seq: 2,
      console: [],
      network: [],
      screenshot: { requestId, dataUrl: PNG_DATA_URL },
    });

    const result = (await pending) as { content: { type: string }[] };
    expect(result).toBeInstanceOf(CapabilityImageResult);
  });

  it('times out cleanly with a structured note — never hangs', async () => {
    const store = seededStore([]);
    const handler = createBrowserScreenshotHandler(resolveSession, store, 20);
    const result = parse(await handler());

    expect(result.captured).toBe(false);
    expect(result.note).toMatch(/didn't return a screenshot/i);
    expect(result.note).toMatch(/browser_navigate/i);
  });

  it('surfaces a shim-side rasterization error as a note', async () => {
    const store = seededStore([]);
    const handler = createBrowserScreenshotHandler(resolveSession, store, 5_000);
    const pending = handler();
    const requestId = enqueuedRequestId();

    store.ingest(SESSION_ID, {
      seq: 2,
      console: [],
      network: [],
      screenshot: { requestId, error: 'the page CSP may block injected scripts' },
    });

    const result = parse(await pending);
    expect(result.captured).toBe(false);
    expect(result.note).toMatch(/could not be rasterized/i);
    expect(result.note).toMatch(/CSP/i);
  });

  // A hostile page may only ever LIE to the agent (a wrong picture) — it must
  // never produce an image block the model API rejects, breaking the turn. So
  // anything that fails the mime-whitelist / base64 / magic-byte gates
  // degrades to the same structured note.
  const malformedDataUrls: Array<{ name: string; dataUrl: string }> = [
    { name: 'not a data URL at all', dataUrl: 'not-a-data-url' },
    {
      // Scriptable markup, not pixels — must never reach an image block even
      // though it matches a naive `image/*` pattern.
      name: 'an SVG mime (scriptable, not on the raster whitelist)',
      dataUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmciLz4=',
    },
    {
      name: 'a non-base64 payload',
      dataUrl: 'data:image/png;base64,!!!not-base64-at-all!!!',
    },
    {
      // '/9j/4A==' decodes to JPEG magic bytes (FF D8 FF E0) — claimed PNG.
      name: 'a mime/magic-byte mismatch (claims PNG, carries JPEG bytes)',
      dataUrl: 'data:image/png;base64,/9j/4A==',
    },
  ];

  for (const { name, dataUrl } of malformedDataUrls) {
    it(`degrades to a note on ${name}`, async () => {
      const store = seededStore([]);
      const handler = createBrowserScreenshotHandler(resolveSession, store, 5_000);
      const pending = handler();
      const requestId = enqueuedRequestId();

      store.ingest(SESSION_ID, {
        seq: 2,
        console: [],
        network: [],
        screenshot: { requestId, dataUrl },
      });

      const result = parse(await pending);
      expect(result.captured).toBe(false);
      expect(result.note).toMatch(/malformed/i);
    });
  }

  it('returns the session-less error when the resolver yields no id', async () => {
    const store = new DevtoolsCaptureStore();
    const handler = createBrowserScreenshotHandler(() => undefined, store, 5);
    await expect(handler()).rejects.toMatchObject({
      payload: expect.objectContaining({
        error: expect.stringMatching(/require an attached interactive session/i),
      }),
    });
  });
});
