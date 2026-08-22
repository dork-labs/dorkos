/**
 * @vitest-environment node
 *
 * The billing-account launch hint on `POST /api/sessions/:id/messages`
 * (spec `billing-account-ladder`, ADR 260821-205323).
 *
 * The hint rides the message body on exactly the `runtime` hint's lifecycle
 * (ADR-0255): honored on the send that CREATES the session, and only for the
 * claude-code runtime. Every other case is ignored — never a 400 — because the
 * resolver falls through an unusable reference rather than failing a launch, and
 * refusing here would be exactly the failure that rule exists to prevent.
 *
 * Asserted at the seam that decides real money: the `MessageOpts` the runtime's
 * `sendMessage` was called with. Nothing downstream of that is this route's
 * business, and the resolver's own tests cover it.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
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

/** Shared between the `vi.mock` factory and the test body (see sessions.test.ts). */
let fakeRuntime: FakeAgentRuntime;
/** What `resolveRuntimeTypeForNewSession` will answer for these requests. */
let runtimeType = 'claude-code';

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    listRuntimes: vi.fn(() => [fakeRuntime]),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => runtimeType),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => runtimeType),
    persistSessionRuntime: vi.fn(async () => true),
    has: vi.fn(() => true),
    getSessionSettings: vi.fn(async () => null),
    saveSessionSettings: vi.fn(async () => {}),
    getSessionSettingsMany: vi.fn(() => new Map()),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(async () => null),
}));

import { createServer } from 'node:http';
import { once } from 'node:events';
import request from 'supertest';
import { createApp, finalizeApp } from '../../app.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { disposeProjector } from '../../services/session/session-state-projector.js';

const app = createApp();
finalizeApp(app);
const server = createServer(app);

const S1 = '00000000-0000-4000-8000-0000000000a1';

beforeAll(async () => {
  server.listen(0);
  await once(server, 'listening');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Post one message and wait for the detached turn to have reached the runtime.
 *
 * The route answers `202` before the turn runs (ADR-0264), so an assertion made
 * the instant the response lands would read an empty spy and pass for the wrong
 * reason. `vi.waitFor` is what makes "the runtime was never told" distinguishable
 * from "the runtime has not been told YET".
 *
 * @param body - The request body, minus `content`.
 * @returns The `MessageOpts` the runtime's `sendMessage` was handed.
 */
async function sendAndCapture(body: Record<string, unknown>): Promise<MessageOpts | undefined> {
  await request(server)
    .post(`/api/sessions/${S1}/messages`)
    .send({ content: 'hi', ...body });
  await vi.waitFor(() => expect(fakeRuntime.sendMessage).toHaveBeenCalled());
  return fakeRuntime.sendMessage.mock.calls[0]?.[2];
}

describe('POST /:id/messages — the billing-account launch hint', () => {
  beforeEach(() => {
    fakeRuntime = new FakeAgentRuntime('claude-code');
    runtimeType = 'claude-code';
    vi.clearAllMocks();
    fakeRuntime.acquireLock.mockReturnValue(true);
    fakeRuntime.getLockInfo.mockReturnValue(null);
    fakeRuntime.getInternalSessionId.mockReturnValue(undefined);
    vi.mocked(runtimeRegistry.resolveForSession).mockReset().mockResolvedValue(fakeRuntime);
    vi.mocked(runtimeRegistry.persistSessionRuntime).mockReset().mockResolvedValue(true);
    disposeProjector(S1);
  });

  it('carries the hint to the runtime on the send that creates the session', async () => {
    const opts = await sendAndCapture({ account: 'acme-corp' });
    expect(opts?.accountHint).toBe('acme-corp');
  });

  it('carries nothing when the sender named no account', async () => {
    const opts = await sendAndCapture({});
    expect(opts?.accountHint).toBeUndefined();
  });

  it('ignores the hint once the session exists', async () => {
    // `persistSessionRuntime` answering false is the route's "already bound"
    // signal. After launch the account is a fact on disk (ADR 260801-204127),
    // so honoring a hint here would promise a move that cannot happen.
    vi.mocked(runtimeRegistry.persistSessionRuntime).mockResolvedValue(false);

    const opts = await sendAndCapture({ account: 'acme-corp' });
    expect(opts?.accountHint).toBeUndefined();
  });

  it('ignores the hint for a runtime that has no accounts', async () => {
    runtimeType = 'codex';
    fakeRuntime = new FakeAgentRuntime('codex');
    vi.mocked(runtimeRegistry.resolveForSession).mockResolvedValue(fakeRuntime);

    const opts = await sendAndCapture({ account: 'acme-corp' });
    expect(opts?.accountHint).toBeUndefined();
  });

  it('still accepts the message when the hint is ignored — never a 400', async () => {
    vi.mocked(runtimeRegistry.persistSessionRuntime).mockResolvedValue(false);

    const res = await request(server)
      .post(`/api/sessions/${S1}/messages`)
      .send({ content: 'hi', account: 'acme-corp' });

    expect(res.status).toBe(202);
  });

  it('accepts a message naming an account that is not registered', async () => {
    // Invariant 3 at the route: whether the id resolves is the resolver's
    // question, and its answer is "fall through", not "refuse".
    const res = await request(server)
      .post(`/api/sessions/${S1}/messages`)
      .send({ content: 'hi', account: 'no-such-account' });

    expect(res.status).toBe(202);
  });

  it('refuses an EMPTY account, which names nothing at all', async () => {
    const res = await request(server)
      .post(`/api/sessions/${S1}/messages`)
      .send({ content: 'hi', account: '' });

    expect(res.status).toBe(400);
  });
});
