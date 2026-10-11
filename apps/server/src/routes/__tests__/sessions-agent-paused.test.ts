/**
 * @vitest-environment node
 *
 * A person's message to a paused agent (spec `audit-trail` PR5): the route
 * answers `409 AGENT_PAUSED` with the agent's id, so the app can offer Resume
 * where the message failed. The launch service is stubbed; what is under test
 * is the route's answer.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';

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

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn(async () => null) }));

vi.mock('../../services/session/launch/session-exists.js', () => ({
  sessionExists: vi.fn(async () => true),
}));

const dispatchSessionMessage = vi.fn();
vi.mock('../../services/session/launch/launch-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/session/launch/launch-session.js')>()),
  dispatchSessionMessage: (...args: unknown[]) => dispatchSessionMessage(...args),
}));

import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createApp, finalizeApp } from '../../app.js';

const app = createApp({ admission: new MainRequestAdmission() });
finalizeApp(app);
const server = listeningServer(app);

const CHAT = '00000000-0000-4000-8000-000000000001';

describe('POST /api/sessions/:id/messages for a paused agent', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('answers 409 with the code, the sentence and the agent', async () => {
    dispatchSessionMessage.mockResolvedValue({
      refused: 'AGENT_PAUSED',
      message: 'Scout is paused.',
      agentId: 'agent-1',
    });
    const res = await request(server)
      .post(`/api/sessions/${CHAT}/messages`)
      .set('X-Client-Id', 'window-1')
      .send({ content: 'hi', cwd: '/p1' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Scout is paused.',
      code: 'AGENT_PAUSED',
      agentId: 'agent-1',
    });
  });
});
