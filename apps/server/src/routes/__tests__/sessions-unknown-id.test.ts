import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
/**
 * A message to an id nobody started is a 404, never a new session (DOR-2712).
 *
 * `POST /:id/messages` starts a session on first contact, which is how the app
 * opens a chat. Before this, a stale id did the same: a coordinator's follow-up
 * to an id it had been handed started a stranger session on the default
 * runtime in the home folder, and nobody was told. Starting a chat is now said
 * out loud with `create: true`; anything else must name a session that exists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
/** Whether the registry reports the session as bound to a runtime. */
let bound = false;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    resolveForSessionWithOwnership: vi.fn(async () => ({ runtime: fakeRuntime, bound })),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => true),
    getSessionSettings: vi.fn(async () => null),
    has: vi.fn(() => true),
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

vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn(async () => null) }));

import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createApp, finalizeApp } from '../../app.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { disposeProjector } from '../../services/session/session-state-projector.js';
import { resetMessageDispatcher } from '../../services/session/message-dispatcher.js';

const app = createApp({ admission: new MainRequestAdmission() });
finalizeApp(app);
const server = listeningServer(app);

const SESSION_ID = '00000000-0000-4000-8000-0000000a2712';

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  bound = false;
  fakeRuntime.acquireLock.mockReturnValue(true);
  fakeRuntime.isLocked.mockReturnValue(false);
  fakeRuntime.getLockInfo.mockReturnValue(null);
  fakeRuntime.getInternalSessionId.mockReturnValue(undefined);
  fakeRuntime.getSession.mockResolvedValue(null);
  fakeRuntime.withScenarios([async function* () {}]);
});

afterEach(() => {
  resetMessageDispatcher();
  disposeProjector(SESSION_ID);
});

describe('POST /api/sessions/:id/messages — unknown ids (DOR-2712)', () => {
  it('answers 404 for an id nobody started, and starts nothing', async () => {
    const res = await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'are you there?' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SESSION_NOT_FOUND');
    expect(runtimeRegistry.persistSessionRuntime).not.toHaveBeenCalled();
    expect(fakeRuntime.sendMessage).not.toHaveBeenCalled();
  });

  it('starts a new session when the caller says so', async () => {
    const res = await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'hello', create: true });

    expect(res.status).toBe(202);
    expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalledOnce();
  });

  it('feeds a session that is bound to a runtime', async () => {
    bound = true;
    const res = await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'next' });

    expect(res.status).toBe(202);
  });

  it('feeds a session its runtime can find without a binding', async () => {
    // A transcript from before sessions were bound, or a live session asked
    // for by an older id.
    fakeRuntime.getSession.mockResolvedValue({ id: SESSION_ID } as never);
    const res = await request(server)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'next' });

    expect(res.status).toBe(202);
  });
});
