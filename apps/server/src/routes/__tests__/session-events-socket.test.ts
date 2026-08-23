/**
 * The session event stream's WebSocket half, at its connect boundary.
 *
 * **This is the route the cockpit actually opens** (ADR 260805-041016) — the
 * SSE twin is the public integration contract for third parties. Until now it
 * had no test anywhere, which meant DOR-1444's user-visible path was verified
 * only through the surface the cockpit does not use. Everything the route
 * decides, it decides in `authorize`, before the handshake, so that is what
 * this drives — a real upgrade would test the upgrade router (which has its own
 * suite) rather than this.
 *
 * Two decisions are pinned, and they are the two that differ from SSE only in
 * how a refusal is delivered (close frame, not status code):
 *
 * 1. A directory the caller NAMED is judged before the runtime is consulted.
 * 2. A directory nobody named — resolved from the runtime's live binding — is
 *    judged too, so omitting `?cwd=` is never more powerful than supplying it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';

/** Inside the boundary: where the session is really running. */
const LIVE_CWD = '/live/project';
/** Outside it: a directory a task binding could plausibly have set. */
const OUTSIDE_CWD = '/secret/outside';

vi.mock('../../lib/boundary.js', () => {
  class TestBoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  }
  const guard = (dir: string): string => {
    if (dir !== '/live/project' && !dir.startsWith('/live/project/')) {
      throw new TestBoundaryError(
        'Access denied: path outside directory boundary',
        'OUTSIDE_BOUNDARY'
      );
    }
    return dir;
  };
  return {
    validateBoundary: vi.fn(async (p: string) => guard(p)),
    validateBoundaryOrDorkHome: vi.fn(async (p: string) => guard(p)),
    getBoundary: vi.fn(() => '/live/project'),
    initBoundary: vi.fn().mockResolvedValue('/live/project'),
    isWithinBoundary: vi.fn().mockResolvedValue(true),
    BoundaryError: TestBoundaryError,
  };
});

let fakeRuntime: FakeAgentRuntime;
const resolveForSession = vi.fn(async () => fakeRuntime);

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    resolveForSession: (...args: unknown[]) =>
      (resolveForSession as unknown as (...a: unknown[]) => Promise<FakeAgentRuntime>)(...args),
    getSessionSettings: vi.fn(async () => null),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));

import { sessionEventsRoute } from '../session-events-socket.js';
import { validateBoundaryOrDorkHome } from '../../lib/boundary.js';
import type {
  UpgradeAttempt,
  UpgradeDecision,
} from '../../services/core/streams/upgrade-router.js';

const SESSION_ID = '00000000-0000-4000-8000-0000000000ef';
const EVENTS_PATH = `/api/sessions/${SESSION_ID}/events`;

/**
 * Ask the route to authorize an upgrade for this session.
 *
 * @param cwdParam - The `?cwd=` to put on the URL, or omitted for none.
 */
async function authorize(cwdParam?: string): Promise<UpgradeDecision> {
  const url = new URL(`ws://localhost:4242${EVENTS_PATH}`);
  if (cwdParam !== undefined) url.searchParams.set('cwd', cwdParam);
  const match = /^\/api\/sessions\/([^/]+)\/events$/.exec(EVENTS_PATH)!;
  return sessionEventsRoute.authorize({
    url,
    headers: {},
    match,
    locals: {},
  } as unknown as UpgradeAttempt);
}

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  fakeRuntime.getInternalSessionId.mockReturnValue(SESSION_ID);
});

describe('sessionEventsRoute — which directory the socket streams against', () => {
  it('opens without a ?cwd= by resolving the session’s own live directory', async () => {
    fakeRuntime.getSessionCwd = vi.fn(() => LIVE_CWD);

    const decision = await authorize();

    expect(decision.ok).toBe(true);
    expect(validateBoundaryOrDorkHome).toHaveBeenCalledWith(LIVE_CWD);
  });

  it('refuses a directory the caller named that is outside the boundary', async () => {
    fakeRuntime.getSessionCwd = vi.fn(() => LIVE_CWD);

    const decision = await authorize(OUTSIDE_CWD);

    expect(decision).toMatchObject({ ok: false, status: 403, deliver: 'close-frame' });
    // Refused before the runtime was consulted at all — a named directory buys
    // no lookup.
    expect(resolveForSession).not.toHaveBeenCalled();
  });

  it('refuses a RESOLVED directory outside the boundary, the same as a named one', async () => {
    // The inversion this guards: the session is genuinely running outside the
    // boundary (a task binding can do that — routes/tasks.ts checks nothing),
    // so a socket that skipped the check on a directory nobody named would read
    // what naming it is refused for.
    fakeRuntime.getSessionCwd = vi.fn(() => OUTSIDE_CWD);

    const unnamed = await authorize();
    const named = await authorize(OUTSIDE_CWD);

    expect(unnamed).toMatchObject({ ok: false, status: 403 });
    expect(named).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects a malformed session id before anything else', async () => {
    const url = new URL('ws://localhost:4242/api/sessions/not-a-uuid/events');
    const match = /^\/api\/sessions\/([^/]+)\/events$/.exec('/api/sessions/not-a-uuid/events')!;

    const decision = await sessionEventsRoute.authorize({
      url,
      headers: {},
      match,
      locals: {},
    } as unknown as UpgradeAttempt);

    expect(decision).toMatchObject({ ok: false, status: 400 });
    expect(validateBoundaryOrDorkHome).not.toHaveBeenCalled();
  });
});
