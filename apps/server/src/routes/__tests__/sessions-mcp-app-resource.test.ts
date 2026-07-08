/**
 * `POST /api/sessions/:id/mcp-app/resource` — reads a ui:// MCP App resource
 * (SEP-1865) for client rendering (spec `mcp-apps-host` §2.1, §4).
 *
 * The route enforces the `ui://` scheme, session existence, and that the server
 * belongs to the session's live MCP set before delegating to the (here mocked)
 * resource service. Connection config is resolved server-side and never trusted
 * from the client.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    resolveForSession: vi.fn(async () => fakeRuntime),
    has: vi.fn(() => true),
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

const resolveAppResource = vi.fn();
vi.mock('../../services/mcp-apps/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/mcp-apps/index.js')>(
    '../../services/mcp-apps/index.js'
  );
  return { ...actual, resolveAppResource: (args: unknown) => resolveAppResource(args) };
});

import request from 'supertest';
import { createApp, finalizeApp } from '../../app.js';
import {
  getOrCreateProjector,
  disposeProjector,
} from '../../services/session/session-state-projector.js';

const app = createApp();
finalizeApp(app);

const SESSION_ID = '00000000-0000-4000-8000-000000000abc';
const CONNECTION: McpAppServerConnection = {
  transport: 'stdio',
  command: 'node',
  args: ['server.mjs'],
};

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  fakeRuntime.hasSession.mockReturnValue(true);
  fakeRuntime.getMcpStatus.mockReturnValue([
    { name: 'fixture-app', type: 'stdio', status: 'connected' },
  ]);
  fakeRuntime.getMcpServerConfig.mockReturnValue(CONNECTION);
  // The handler reads the session's cwd off the projector.
  getOrCreateProjector(SESSION_ID, '/work/proj');
  resolveAppResource.mockResolvedValue({
    mimeType: 'text/html;profile=mcp-app',
    text: '<html></html>',
    permissions: [],
  });
});

afterEach(() => disposeProjector(SESSION_ID));

describe('POST /api/sessions/:id/mcp-app/resource', () => {
  it('returns 200 with the resource for a known server and ui:// uri', async () => {
    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/mcp-app/resource`)
      .send({ serverName: 'fixture-app', uri: 'ui://dashboard/main' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mimeType: 'text/html;profile=mcp-app',
      text: '<html></html>',
    });
    expect(resolveAppResource).toHaveBeenCalledWith({
      serverName: 'fixture-app',
      uri: 'ui://dashboard/main',
      connection: CONNECTION,
    });
  });

  it('returns 400 for a non-ui:// uri and never calls the service', async () => {
    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/mcp-app/resource`)
      .send({ serverName: 'fixture-app', uri: 'file:///etc/passwd' });

    expect(res.status).toBe(400);
    expect(resolveAppResource).not.toHaveBeenCalled();
  });

  it('returns 404 when the server is not in the session MCP set', async () => {
    fakeRuntime.getMcpStatus.mockReturnValue([{ name: 'other', type: 'stdio' }]);
    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/mcp-app/resource`)
      .send({ serverName: 'fixture-app', uri: 'ui://dashboard/main' });

    expect(res.status).toBe(404);
    expect(resolveAppResource).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown session', async () => {
    fakeRuntime.hasSession.mockReturnValue(false);
    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/mcp-app/resource`)
      .send({ serverName: 'fixture-app', uri: 'ui://dashboard/main' });

    expect(res.status).toBe(404);
  });

  it('returns 400 on a missing serverName', async () => {
    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/mcp-app/resource`)
      .send({ uri: 'ui://dashboard/main' });
    expect(res.status).toBe(400);
  });
});
