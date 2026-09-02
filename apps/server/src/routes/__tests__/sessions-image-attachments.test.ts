/**
 * The whole DorkOS half of an image, in one pass: a runtime emits an
 * `image_attachment`, and a browser ends up with the bytes.
 *
 * Every other test in this change proves one link. This one proves the chain —
 * runtime → `toRawSessionEvent` → projector → `GET /:id/events` → the URL the
 * part carries → `GET /:id/attachments/:file` → the actual PNG. The failure it
 * exists to catch is the one that made this feature necessary: a link that
 * silently drops what it was handed, which every unit test on either side of it
 * still passes.
 *
 * The runtime is faked and the bytes are real. That split is deliberate: which
 * runtime produced the image is exactly what this seam is supposed to not care
 * about, and the OpenCode adapter's own end of it is proven separately by its
 * conformance suite's `mediaTurn`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime } from '@dorkos/test-utils';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    getSessionSettings: vi.fn(async () => null),
    has: vi.fn(() => true),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {
    constructor(
      public readonly runtime: string,
      public readonly sessionId: string
    ) {
      super(`Session '${sessionId}' is owned by runtime '${runtime}', which is not registered.`);
      this.name = 'RuntimeNotRegisteredError';
    }
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn(async () => null) }));

import request from 'supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createApp, finalizeApp } from '../../app.js';
import {
  getOrCreateProjector,
  disposeProjector,
} from '../../services/session/session-state-projector.js';
import {
  LocalSessionAttachmentStore,
  resetSessionAttachmentStore,
  setSessionAttachmentStore,
} from '../../services/session/attachments/index.js';
import { collectTriggeredTurn } from './helpers/trigger-turn-helpers.js';

const app = createApp();
finalizeApp(app);
const server = listeningServer(app);

const SESSION_ID = '00000000-0000-4000-8000-0000000000f1';
/** A real one-pixel PNG — the assertion is about bytes, so they have to be bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let dorkHome: string;

beforeEach(() => {
  dorkHome = mkdtempSync(path.join(tmpdir(), 'dorkos-image-e2e-'));
  setSessionAttachmentStore(new LocalSessionAttachmentStore(dorkHome));

  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  fakeRuntime.acquireLock.mockReturnValue(true);
  fakeRuntime.isLocked.mockReturnValue(false);
  fakeRuntime.getLockInfo.mockReturnValue(null);
  fakeRuntime.hasSession.mockReturnValue(true);
  fakeRuntime.getInternalSessionId.mockReturnValue(SESSION_ID);
  fakeRuntime.getSessionSnapshot.mockImplementation((_ctx, sessionId) =>
    getOrCreateProjector(sessionId).buildSnapshot(async () => [])
  );
  fakeRuntime.subscribeSession = vi.fn((_ctx, sessionId, sinceCursor, signal) =>
    getOrCreateProjector(sessionId).subscribe(sinceCursor, signal)
  );
});

afterEach(() => {
  disposeProjector(SESSION_ID);
  resetSessionAttachmentStore();
  rmSync(dorkHome, { recursive: true, force: true });
});

describe('an image a turn produced, from the runtime to the browser', () => {
  it('reaches the durable stream as a reference and serves the real bytes at that URL', async () => {
    // The runtime has already stored the bytes by the time it announces one —
    // that ordering is the adapter's contract, so the URL is live on arrival.
    const store = new LocalSessionAttachmentStore(dorkHome);
    const stored = await store.put(SESSION_ID, 'abc123def456', 'image/png', PNG);

    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'Here is your image.' } } as StreamEvent;
        yield {
          type: 'image_attachment',
          data: { ...stored, attachmentId: 'abc123def456', alt: 'banana.png' },
        } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const frames = await collectTriggeredTurn(server, SESSION_ID, 'draw me a banana');

    const image = frames.find((frame) => frame.event === 'image_attachment');
    expect(
      image,
      'the image never reached the durable stream — one of runtime → normalizer → projector → SSE dropped it'
    ).toBeDefined();
    expect(image!.data).toMatchObject({
      attachmentId: 'abc123def456',
      url: stored.url,
      mediaType: 'image/png',
      size: PNG.byteLength,
      alt: 'banana.png',
    });

    // The whole point of the reference: what rode the stream is small, and the
    // bytes are behind a URL the browser fetches once.
    expect(JSON.stringify(image!.data).length).toBeLessThan(500);
    expect(JSON.stringify(image!.data)).not.toContain('base64');

    // And that URL really answers with the picture.
    const fetched = await request(server).get(stored.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers['content-type']).toBe('image/png');
    expect(Buffer.from(fetched.body)).toEqual(PNG);
  });

  it('replays the image to a client that reconnects mid-transcript', async () => {
    // A picture that renders once and disappears on refresh is barely better
    // than one that never rendered. Replay is what makes it durable.
    const store = new LocalSessionAttachmentStore(dorkHome);
    const stored = await store.put(SESSION_ID, 'abc123def456', 'image/png', PNG);

    fakeRuntime.withScenarios([
      async function* () {
        yield {
          type: 'image_attachment',
          data: { ...stored, attachmentId: 'abc123def456' },
        } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    await collectTriggeredTurn(server, SESSION_ID, 'draw me a banana');

    const resumed = await readResumedStream(SESSION_ID);

    expect(
      resumed,
      'the image was not replayed to a reconnecting client — it would render once and vanish on refresh'
    ).toContain('image_attachment');
    // Still a reference on the replay path, which is where an inlined payload
    // would have hurt most: this is the read that repeats forever.
    expect(resumed).not.toContain('base64');
  });
});

/**
 * Read `GET /:id/events` from the very start of the stream, the way a client
 * reconnecting with a stale cursor does.
 *
 * Raw `http` rather than supertest, because supertest waits for a response that
 * an event stream never finishes; and its own reader rather than
 * `attachEventStream`, because that helper deliberately takes no resume cursor.
 * `?after=0` is the plain-integer query form of the resume cursor (the
 * `Last-Event-ID` form carries an epoch and a resource id; `after` does not).
 *
 * @param sessionId - The session whose stream to replay.
 */
function readResumedStream(sessionId: string): Promise<string> {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return new Promise<string>((resolve) => {
    let raw = '';
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: `/api/sessions/${sessionId}/events?after=0`,
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          raw += chunk;
          // The replay is complete once the turn's terminator has come back.
          if (raw.includes('event: turn_end')) {
            req.destroy();
            resolve(raw);
          }
        });
        res.on('end', () => resolve(raw));
      }
    );
    req.on('error', () => resolve(raw));
    setTimeout(() => {
      req.destroy();
      resolve(raw);
    }, 3000).unref();
    req.end();
  });
}
