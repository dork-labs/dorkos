/**
 * A second turn triggered under a session's PRE-REKEY id (DOR-1262).
 *
 * A brand-new session is triggered under the request UUID and the runtime names
 * it a couple of seconds later — after the 202 has already gone out carrying the
 * request UUID. A client that follows the canonical-id re-announce (the cockpit)
 * moves on; anything holding only the 202's id does not: the evals harness, an
 * API/MCP integrator, a second window on a stale URL. Live, the widget-round-trip
 * eval failed exactly there (2026-08-16): its `/ui-action` under the retired id
 * minted a FRESH EMPTY projector, the runtime's next re-announce of the canonical
 * id displaced the real one, and the displaced instance's live `/events`
 * subscriber was terminated — turn 2 streamed into a projector nobody watched.
 *
 * These pin the property the fix owes: BOTH trigger routes, plus the durable
 * stream, keep speaking for the one live session when handed the retired id.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  peekProjector,
  disposeProjector,
} from '../../services/session/session-state-projector.js';
import { resetMessageDispatcher } from '../../services/session/message-dispatcher.js';
import { attachEventStream } from './helpers/trigger-turn-helpers.js';

const app = createApp();
finalizeApp(app);

/** One listener for the whole file — see {@link attachEventStream} (DOR-483). */
const server = listeningServer(app);

/** The id the client sends the first message under, and keeps. */
const REQUEST_ID = '00000000-0000-4000-8000-0000000012e2';
/** The id the runtime assigns mid-first-turn, after the 202 has gone out. */
const CANONICAL_ID = '11111111-1111-4111-8111-1111111112e2';

/** How long a two-turn round trip may take on a loaded machine. */
const WAIT_MS = 8000;

/** Count how many frames of one event name are on the wire so far. */
function countFrames(raw: string, event: string): number {
  return raw.split(`event: ${event}`).length - 1;
}

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  fakeRuntime.acquireLock.mockReturnValue(true);
  fakeRuntime.isLocked.mockReturnValue(false);
  fakeRuntime.getLockInfo.mockReturnValue(null);
  fakeRuntime.hasSession.mockReturnValue(true);
  // The claude-code shape: the adapter SEEDS an identity mapping at session
  // creation and only learns the real id when the SDK init lands mid-turn.
  fakeRuntime.getInternalSessionId.mockReturnValue(REQUEST_ID);
  fakeRuntime.getSessionSnapshot.mockImplementation((_ctx, sessionId) =>
    getOrCreateProjector(sessionId).buildSnapshot(async () => [])
  );
  fakeRuntime.subscribeSession = vi.fn((_ctx, sessionId, sinceCursor, signal) =>
    getOrCreateProjector(sessionId).subscribe(sinceCursor, signal)
  );
});

afterEach(() => {
  resetMessageDispatcher();
  disposeProjector(REQUEST_ID);
  disposeProjector(CANONICAL_ID);
});

/**
 * Turn 1 as the runtime really behaves: it starts under the request id and the
 * canonical id lands mid-turn, which is what makes the 202 hand back an id that
 * is about to be retired. Turn 2 is an ordinary turn under the new name.
 */
function loadTwoTurns(): void {
  fakeRuntime.withScenarios([
    async function* () {
      yield { type: 'text_delta', data: { text: 'turn one' } } as StreamEvent;
      // The SDK init lands: from here the session has a different id than the
      // one the request used — and the 202 has already resolved.
      fakeRuntime.getInternalSessionId.mockReturnValue(CANONICAL_ID);
      yield { type: 'text_delta', data: { text: ' …done' } } as StreamEvent;
      yield { type: 'done', data: {} } as StreamEvent;
    },
    async function* () {
      yield { type: 'text_delta', data: { text: 'turn two' } } as StreamEvent;
      yield { type: 'done', data: {} } as StreamEvent;
    },
  ]);
}

/**
 * Subscribe-first under the retired id and run turn 1 to completion, leaving the
 * `/events` connection OPEN — the client that never learned the canonical id is
 * still watching. Returns the live handle, which closes on the SECOND `turn_end`.
 */
async function openStreamAndRunFirstTurn(): Promise<ReturnType<typeof attachEventStream>> {
  loadTwoTurns();
  const stream = attachEventStream(server, REQUEST_ID, {
    until: (raw) => countFrames(raw, 'turn_end') >= 2,
    maxMs: WAIT_MS,
  });
  await stream.ready;

  const first = await request(server)
    .post(`/api/sessions/${REQUEST_ID}/messages`)
    .send({ content: 'one' });
  expect(first.status).toBe(202);
  // The whole premise: the 202 raced the runtime's naming, so the only id this
  // client has ever been given is the one about to be retired.
  expect(first.body.sessionId).toBe(REQUEST_ID);

  await vi.waitFor(() => expect(peekProjector(CANONICAL_ID)?.getStatus().lifecycle).toBe('idle'), {
    timeout: WAIT_MS,
  });
  return stream;
}

describe('a second trigger under a session’s retired id (DOR-1262)', () => {
  it('POST /messages under the retired id reaches the subscriber that stayed on it', async () => {
    const stream = await openStreamAndRunFirstTurn();
    const live = peekProjector(CANONICAL_ID);

    const second = await request(server)
      .post(`/api/sessions/${REQUEST_ID}/messages`)
      .send({ content: 'two' });
    expect(second.status).toBe(202);
    // The trigger resolves the retired id to the session's real name.
    expect(second.body.sessionId).toBe(CANONICAL_ID);

    const { frames } = await stream.done;
    // Two turns on ONE connection. Turn 2's `turn_start` arriving is the whole
    // property: it used to be fed to a fresh projector minted under the retired
    // id while this connection was terminated by the collision that produced.
    expect(frames.filter((f) => f.event === 'turn_start')).toHaveLength(2);
    expect(frames.filter((f) => f.event === 'turn_end')).toHaveLength(2);
    expect(frames.map((f) => f.event)).not.toContain('error');

    // One projector for the session, still the instance turn 1 ran on, and both
    // ids answer with it.
    expect(peekProjector(REQUEST_ID)).toBe(live);
    expect(peekProjector(CANONICAL_ID)).toBe(live);
  });

  it('POST /ui-action under the retired id reaches it too (the widget-round-trip shape)', async () => {
    const stream = await openStreamAndRunFirstTurn();
    const live = peekProjector(CANONICAL_ID);

    // A widget rendered in turn 1 can only be clicked with the id the page was
    // given, which is the retired one.
    const second = await request(server)
      .post(`/api/sessions/${REQUEST_ID}/ui-action`)
      .send({ actionId: 'refresh', payload: { city: 'SF' }, widgetTitle: 'Weather' });
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ sessionId: CANONICAL_ID });

    const { frames } = await stream.done;
    expect(frames.filter((f) => f.event === 'turn_start')).toHaveLength(2);
    // The action's turn carried the click into the conversation.
    expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(2);
    expect(fakeRuntime.sendMessage.mock.calls[1]?.[1]).toContain('<ui_action>');
    expect(peekProjector(REQUEST_ID)).toBe(live);
  });
});
