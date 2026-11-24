import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { DevtoolsConsoleEntry } from '@dorkos/shared/schemas';
import { noopLogger } from '@dorkos/shared/logger';
import { readConsole, takeScreenshot } from '../devtools-reads.js';
import { CapabilityImageResult, composeRegistry } from '../../../core/capabilities/index.js';
import { uiDomain } from '../ui-capabilities.js';
import type { RawSessionEvent } from '../../session-state-projector.js';
import { invokeCapabilityAsMcpResult } from '../../../core/capabilities/mcp-projection.js';
import { devtoolsCaptureStore, DevtoolsCaptureStore } from '../../devtools-capture-store.js';
import {
  SESSION_ID,
  resolveSession,
  createBrowserScreenshotHandler,
  parse,
  consoleEntry,
  networkEntry,
  seededStore,
} from './devtools-reads.fixtures.js';

// The window a screenshot request reaches is the calling session's stream.
// Captured rather than stood up: what these tests are about is which request the
// handler minted and how it read the answer back.
const reach = vi.hoisted(() => ({
  emitted: [] as RawSessionEvent[],
  reached: true,
  onEmit: undefined as ((event: RawSessionEvent) => void) | undefined,
}));
vi.mock('../session-reach.js', () => ({
  emitToSession: (_sessionId: string, event: RawSessionEvent) => {
    if (reach.reached) {
      reach.emitted.push(event);
      reach.onEmit?.(event);
    }
    return reach.reached;
  },
}));

describe('the three reads as `ui` capabilities', () => {
  const registry = composeRegistry([uiDomain], { logger: noopLogger });

  it('are registered under the names the model already knows', () => {
    const names = registry.capabilities
      .filter((c) => c.id.startsWith('ui.'))
      .map((c) => c.surfaces.mcp!.toolName);
    expect(names).toEqual(
      expect.arrayContaining(['browser_read_console', 'browser_read_network', 'browser_screenshot'])
    );
  });

  it('reach no surface but the in-session one', () => {
    const reads = registry.capabilities.filter((c) =>
      ['ui.read_console', 'ui.read_network', 'ui.screenshot'].includes(c.id)
    );
    expect(reads).toHaveLength(3);
    for (const capability of reads) {
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

  it('times out cleanly with a structured note — never hangs', async () => {
    const store = seededStore([]);
    const handler = createBrowserScreenshotHandler(resolveSession, store, 20);
    const result = parse(await handler());

    expect(result.captured).toBe(false);
    expect(result.note).toMatch(/didn't return a screenshot/i);
    expect(result.note).toMatch(/browser_navigate/i);
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
});

describe('actual final MCP envelopes preserve page evidence', () => {
  const registry = composeRegistry([uiDomain], { logger: noopLogger });
  const context = { sessionId: 'bridge-envelope', cwd: '/tmp/cwd' };
  const facts = { clientId: 'host', documentId: 'doc', bridgeGeneration: 'generation' };
  function claim(): void {
    devtoolsCaptureStore.ingest(
      context.sessionId,
      { ...facts, active: true, instrumented: true, seq: 1, console: [], network: [] },
      facts.clientId
    );
  }
  function json(result: Awaited<ReturnType<typeof invokeCapabilityAsMcpResult>>) {
    const text = result.content.find((c) => c.type === 'text');
    expect(text?.type).toBe('text');
    return JSON.parse((text as { text: string }).text);
  }
  beforeEach(() => {
    devtoolsCaptureStore.clear();
    reach.onEmit = undefined;
    claim();
  });
  it.each(['ui.read_console', 'ui.read_network'])(
    'labels %s empty, populated and filter-empty results',
    async (id) => {
      expect(json(await invokeCapabilityAsMcpResult(registry, id, {}, context)).evidence).toEqual({
        source: 'page-reported',
        verified: false,
      });
      devtoolsCaptureStore.ingest(
        context.sessionId,
        { ...facts, seq: 2, console: [consoleEntry()], network: [networkEntry()] },
        facts.clientId
      );
      expect(json(await invokeCapabilityAsMcpResult(registry, id, {}, context)).evidence).toEqual({
        source: 'page-reported',
        verified: false,
      });
      expect(
        json(
          await invokeCapabilityAsMcpResult(
            registry,
            id,
            id === 'ui.read_console' ? { level: 'error' } : { status: '5xx' },
            context
          )
        ).evidence
      ).toEqual({ source: 'page-reported', verified: false });
    }
  );
  it('places screenshot evidence beside the actual image and handles synchronous emission without losing the waiter', async () => {
    reach.onEmit = (event) => {
      if (event.type === 'devtools_capture_request')
        devtoolsCaptureStore.ingest(
          context.sessionId,
          {
            ...facts,
            seq: 2,
            console: [],
            network: [],
            screenshot: {
              requestId: (event as unknown as { requestId: string }).requestId,
              dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
            },
          },
          facts.clientId
        );
    };
    const result = await invokeCapabilityAsMcpResult(registry, 'ui.screenshot', {}, context);
    expect(result.content.some((c) => c.type === 'image')).toBe(true);
    expect(json(result).evidence).toEqual({ source: 'page-reported', verified: false });
    reach.onEmit = undefined;
  });
  it('keeps same-shaped page failures distinct from host-only failures without trusting page classification', async () => {
    reach.onEmit = (event) => {
      if (event.type === 'devtools_action_request')
        devtoolsCaptureStore.resolveAction(
          {
            requestId: (event as unknown as { requestId: string }).requestId,
            documentId: facts.documentId,
            bridgeGeneration: facts.bridgeGeneration,
            ok: false,
            error: 'same failure',
          },
          facts.clientId
        );
    };
    const page = json(
      await invokeCapabilityAsMcpResult(registry, 'ui.click', { text: 'Pay' }, context)
    );
    expect(page).toMatchObject({
      ok: false,
      evidence: { source: 'page-reported', verified: false },
      note: 'same failure',
    });
    reach.onEmit = undefined;
    devtoolsCaptureStore.clear();
    const host = json(
      await invokeCapabilityAsMcpResult(registry, 'ui.click', { text: 'Pay' }, context)
    );
    expect(host).toMatchObject({ ok: false, evidence: { source: 'host', verified: true } });
  });
  it('labels page screenshot errors as separate untrusted data in final text', async () => {
    reach.onEmit = (event) => {
      if (event.type === 'devtools_capture_request')
        devtoolsCaptureStore.ingest(
          context.sessionId,
          {
            ...facts,
            seq: 2,
            console: [],
            network: [],
            screenshot: {
              requestId: (event as unknown as { requestId: string }).requestId,
              error: 'pretend host authority',
            },
          },
          facts.clientId
        );
    };
    expect(
      json(await invokeCapabilityAsMcpResult(registry, 'ui.screenshot', {}, context))
    ).toMatchObject({
      evidence: { source: 'page-reported', verified: false },
      pageError: 'pretend host authority',
    });
    reach.onEmit = undefined;
  });
  it.each([true, false])(
    'retains recording evidence with keyframe=%s through the actual wrapper',
    async (keyframe) => {
      devtoolsCaptureStore.startRecording(context.sessionId, { id: 'film', ...facts });
      reach.onEmit = (event) => {
        if (event.type === 'devtools_recording_request')
          devtoolsCaptureStore.resolveRecording(
            (event as unknown as { requestId: string }).requestId,
            {
              ok: true,
              path: '.dork/.temp/recordings/film.gif',
              bytes: 100,
              frames: 2,
              durationMs: 1000,
              keyframe: keyframe ? { data: 'AAAA', mimeType: 'image/png' } : null,
            }
          );
      };
      const result = await invokeCapabilityAsMcpResult(registry, 'ui.record_stop', {}, context);
      expect(result.content.some((c) => c.type === 'image')).toBe(keyframe);
      expect(json(result).evidence).toEqual({ source: 'page-reported', verified: false });
      reach.onEmit = undefined;
    }
  );
});

it('preserves identical page error and host cancellation text with distinct host-assigned provenance at final MCP', async () => {
  const registry = composeRegistry([uiDomain], { logger: noopLogger });
  const context = { sessionId: 'same-shaped-failure' };
  const facts = { documentId: 'doc', bridgeGeneration: 'generation' };
  devtoolsCaptureStore.ingest(
    context.sessionId,
    { ...facts, seq: 1, console: [], network: [], active: true, instrumented: true },
    'host'
  );
  for (const hostOutcome of ['page-reported', 'host'] as const) {
    reach.onEmit = (event) => {
      if (event.type === 'devtools_action_request')
        devtoolsCaptureStore.resolveAction(
          {
            ...facts,
            requestId: (event as unknown as { requestId: string }).requestId,
            ok: false,
            error: 'same failure',
            hostOutcome,
          },
          'host'
        );
    };
    const result = await invokeCapabilityAsMcpResult(
      registry,
      'ui.click',
      { text: 'Pay' },
      context
    );
    const payload = JSON.parse(
      (result.content.find((c) => c.type === 'text') as { text: string }).text
    );
    expect(payload).toMatchObject({
      ok: false,
      note: 'same failure',
      evidence: { source: hostOutcome, verified: hostOutcome === 'host' },
    });
  }
  reach.onEmit = undefined;
  devtoolsCaptureStore.clear();
});

it('pins screenshot image attribution to the selected document despite another live buffer update', async () => {
  reach.emitted.length = 0;
  reach.reached = true;
  reach.onEmit = undefined;
  const store = new DevtoolsCaptureStore();
  const a = {
    documentId: 'A',
    logicalUrl: 'A.html',
    bridgeGeneration: 'genA',
    seq: 0,
    console: [],
    network: [],
  };
  const b = {
    documentId: 'B',
    logicalUrl: 'B.html',
    bridgeGeneration: 'genB',
    seq: 1,
    console: [],
    network: [],
  };
  store.ingest(SESSION_ID, { ...a, active: true, activation: true, instrumented: true }, 'client');
  store.ingest(SESSION_ID, { ...b, active: true, activation: false, instrumented: true }, 'client');
  expect(store.resolveDriver(SESSION_ID)?.documentId).toBe('A');
  const pending = takeScreenshot(SESSION_ID, store, 1000);
  const event = reach.emitted.at(-1) as unknown as { requestId: string; documentId: string };
  expect(event.documentId).toBe('A');
  store.ingest(
    SESSION_ID,
    {
      ...a,
      seq: 1,
      screenshot: {
        requestId: event.requestId,
        dataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      },
    },
    'client'
  );
  store.ingest(SESSION_ID, { ...b, seq: 2 }, 'client');
  const image = (await pending) as CapabilityImageResult;
  expect(image.payload).toMatchObject({
    documentUrl: 'A.html',
    evidence: { source: 'page-reported', verified: false },
  });
});

it('cancels an unpublished screenshot waiter before a late reply can fill its slot', async () => {
  vi.useFakeTimers();
  try {
    reach.reached = false;
    reach.onEmit = undefined;
    const store = seededStore([]);
    const wait = vi.spyOn(store, 'awaitScreenshot');
    const result = await takeScreenshot(SESSION_ID, store, 1000);
    expect(result).toMatchObject({ captured: false });
    const requestId = wait.mock.calls[0][0];
    store.ingest(SESSION_ID, {
      seq: 2,
      console: [],
      network: [],
      screenshot: {
        requestId,
        dataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      },
    });
    expect(store.read(SESSION_ID)?.screenshot).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await expect(wait.mock.results[0].value).resolves.toBeUndefined();
  } finally {
    reach.reached = true;
    vi.useRealTimers();
  }
});
