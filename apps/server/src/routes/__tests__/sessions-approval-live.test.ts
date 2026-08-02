/**
 * The approval contract as a LIVE session actually delivers it, over the real
 * HTTP routes, the real projector, and the durable `/events` stream.
 *
 * Both defects pinned here shipped green against tests that only ever seeded a
 * cold snapshot, so this file deliberately drives the live shape end to end:
 *
 * - DOR-810: the `approval_required` frame carries the timeout the server will
 *   enforce, so the card can draw a countdown. Without it `ToolCallPart.timeoutMs`
 *   was never populated in production and the countdown never rendered.
 * - DOR-809: a denial carries the reason the person typed to the runtime, and
 *   the resolution says a reason was delivered — the only thing that lets the
 *   receipt claim "agent was told why" honestly. An auto-deny (`expired`) says
 *   nothing of the kind, because nobody told the agent anything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { SessionEvent, SessionSnapshot } from '@dorkos/shared/session-stream';
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
import { attachEventStream } from './helpers/trigger-turn-helpers.js';

const app = createApp();
finalizeApp(app);

/**
 * ONE listener for the whole file (DOR-483). Requests and `/events` attachments
 * both target `server`, never `app`: handed a non-listening app, supertest binds
 * and frees an ephemeral port per request, and a pooled keep-alive socket for a
 * reclaimed port can land on the wrong server. See {@link listeningServer}.
 */
const server = listeningServer(app);

const SESSION_ID = '00000000-0000-4000-8000-0000000000ac';
const TOOL_CALL_ID = 'tool-approval-live-1';

/**
 * The budget this fake runtime declares for its ask — deliberately NOT the
 * server-wide `SESSIONS.INTERACTION_TIMEOUT_MS`. A fixture that declares the
 * global constant can never catch a remainder computed against the global
 * constant, which is exactly the bug this file now pins: a 120s ask once
 * shipped `timeoutMs: 120000` beside `remainingMs: 562000` (DOR-810).
 */
const ASK_BUDGET_MS = 120_000;

/** Extract the live (non-snapshot) SessionEvents from a collected stream. */
function liveEvents(frames: { event: string; data: unknown }[]): SessionEvent[] {
  return frames.filter((f) => f.event !== 'snapshot').map((f) => f.data as SessionEvent);
}

/**
 * A turn that raises one approval card and then waits — the state every
 * assertion here is about. `release` ends the turn so the stream can close.
 */
function blockOnApproval(): { release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  fakeRuntime.withScenarios([
    async function* () {
      yield {
        type: 'approval_required',
        data: {
          toolCallId: TOOL_CALL_ID,
          toolName: 'Bash',
          input: JSON.stringify({ command: 'rm -rf node_modules' }),
          timeoutMs: ASK_BUDGET_MS,
          startedAt: Date.now(),
          hasSuggestions: false,
          title: 'Run a shell command?',
          blockedPath: '/repo/node_modules',
        },
      } as StreamEvent;
      await gate;
      yield { type: 'done', data: {} } as StreamEvent;
    },
  ]);
  return { release };
}

beforeEach(() => {
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
  fakeRuntime.subscribeSession.mockImplementation((_ctx, sessionId, sinceCursor, signal) =>
    getOrCreateProjector(sessionId).subscribe(sinceCursor, signal)
  );
});

afterEach(() => {
  disposeProjector(SESSION_ID);
});

describe('live approval stream: the countdown reaches the client (DOR-810)', () => {
  it('carries the timeout the auto-deny will enforce on the live approval_required frame', async () => {
    const { release } = blockOnApproval();
    const stream = attachEventStream(server, SESSION_ID);
    await stream.ready;

    const post = await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-a')
      .send({ content: 'clean up' });
    expect(post.status).toBe(202);

    await vi.waitFor(() => expect(peekProjector(SESSION_ID)?.hasPendingInteractions()).toBe(true));
    release();
    const res = await stream.done;

    const approval = liveEvents(res.frames).find((e) => e.type === 'approval_required');
    expect(approval).toBeDefined();
    // The whole defect: the client gates its countdown on `timeoutMs`, so a
    // frame without it renders a card that never counts down.
    expect(approval).toMatchObject({ id: TOOL_CALL_ID, timeoutMs: ASK_BUDGET_MS });
  });

  it('recovers the timeout with the pending card for a client that connects mid-block', async () => {
    const { release } = blockOnApproval();
    const first = attachEventStream(server, SESSION_ID);
    await first.ready;

    const post = await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-a')
      .send({ content: 'clean up' });
    expect(post.status).toBe(202);
    await vi.waitFor(() => expect(peekProjector(SESSION_ID)?.hasPendingInteractions()).toBe(true));

    const second = attachEventStream(server, SESSION_ID);
    await second.ready;
    release();
    const [, secondRes] = await Promise.all([first.done, second.done]);

    const snapshot = secondRes.frames.find((f) => f.event === 'snapshot')!.data as SessionSnapshot;
    const recovered = snapshot.pendingInteractions[0] as {
      id: string;
      type: string;
      timeoutMs?: number;
      remainingMs: number;
    };
    expect(recovered).toMatchObject({
      id: TOOL_CALL_ID,
      type: 'approval',
      timeoutMs: ASK_BUDGET_MS,
    });
    // The two numbers in this DTO have to agree: a remainder measured against
    // the server-wide constant would exceed the budget shipped beside it, and
    // the card would draw a bar past its own maximum.
    expect(recovered.remainingMs).toBeLessThanOrEqual(ASK_BUDGET_MS);
  });
});

describe('live approval stream: the agent hears why you said no (DOR-809)', () => {
  it('hands the runtime the reason the person typed', async () => {
    fakeRuntime.approveTool.mockImplementation((sessionId: string, toolCallId: string) => {
      peekProjector(sessionId)?.resolveInteraction(toolCallId, 'denied');
      return true;
    });
    const { release } = blockOnApproval();
    const stream = attachEventStream(server, SESSION_ID);
    await stream.ready;
    await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-a')
      .send({ content: 'clean up' });
    await vi.waitFor(() => expect(peekProjector(SESSION_ID)?.hasPendingInteractions()).toBe(true));

    const deny = await request(server)
      .post(`/api/sessions/${SESSION_ID}/deny`)
      .set('X-Client-Id', 'client-a')
      .send({ toolCallId: TOOL_CALL_ID, reason: 'Use pnpm prune instead' });
    expect(deny.status).toBe(200);
    release();
    await stream.done;

    expect(fakeRuntime.approveTool).toHaveBeenCalledWith(SESSION_ID, TOOL_CALL_ID, false, {
      denyReason: 'Use pnpm prune instead',
    });
  });

  it('says on the stream that a reason was delivered, so the receipt can claim it', async () => {
    fakeRuntime.approveTool.mockImplementation(
      (
        sessionId: string,
        toolCallId: string,
        approved: boolean,
        options?: { denyReason?: string }
      ) => {
        peekProjector(sessionId)?.resolveInteraction(toolCallId, approved ? 'approved' : 'denied', {
          reasonGiven: options?.denyReason !== undefined,
        });
        return true;
      }
    );
    const { release } = blockOnApproval();
    const stream = attachEventStream(server, SESSION_ID);
    await stream.ready;
    await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-a')
      .send({ content: 'clean up' });
    await vi.waitFor(() => expect(peekProjector(SESSION_ID)?.hasPendingInteractions()).toBe(true));

    await request(server)
      .post(`/api/sessions/${SESSION_ID}/deny`)
      .set('X-Client-Id', 'client-a')
      .send({ toolCallId: TOOL_CALL_ID, reason: 'Use pnpm prune instead' });
    release();
    const res = await stream.done;

    const resolved = liveEvents(res.frames).find((e) => e.type === 'interaction_resolved');
    expect(resolved).toMatchObject({
      id: TOOL_CALL_ID,
      resolution: 'denied',
      kind: 'approval',
      reasonGiven: true,
    });
  });

  it('rejects a deny whose reason is longer than the cap', async () => {
    const res = await request(server)
      .post(`/api/sessions/${SESSION_ID}/deny`)
      .set('X-Client-Id', 'client-a')
      .send({ toolCallId: TOOL_CALL_ID, reason: 'x'.repeat(5_000) });
    expect(res.status).toBe(400);
  });

  it('leaves an expired approval with no reason claim — nobody told the agent anything', async () => {
    // The 10-minute auto-deny. The run continues; the receipt must read as the
    // clock answering, never as a person explaining.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fakeRuntime.withScenarios([
      async function* () {
        yield {
          type: 'approval_required',
          data: {
            toolCallId: TOOL_CALL_ID,
            toolName: 'Bash',
            input: '{}',
            timeoutMs: ASK_BUDGET_MS,
            startedAt: Date.now(),
            hasSuggestions: false,
          },
        } as StreamEvent;
        yield {
          type: 'interaction_cancelled',
          data: { interactionId: TOOL_CALL_ID, reason: 'timeout' },
        } as StreamEvent;
        await gate;
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);

    const stream = attachEventStream(server, SESSION_ID);
    await stream.ready;
    await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('X-Client-Id', 'client-a')
      .send({ content: 'clean up' });
    await vi.waitFor(() => expect(peekProjector(SESSION_ID)?.hasPendingInteractions()).toBe(false));
    release();
    const res = await stream.done;

    const resolved = liveEvents(res.frames).find((e) => e.type === 'interaction_resolved');
    expect(resolved).toMatchObject({ id: TOOL_CALL_ID, resolution: 'expired', kind: 'approval' });
    expect((resolved as { reasonGiven?: boolean }).reasonGiven).toBeUndefined();
  });
});
