/**
 * `GET /api/config` never waits on npm (DOR-3226). The update check answers
 * from its cache and refreshes in the background, so a registry that hangs
 * costs the settings read nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

// Mock dependencies before importing the router
vi.mock('../../services/core/config-manager.js', () => {
  const store: Record<string, unknown> = {};
  return {
    configManager: {
      get: vi.fn((key: string) => store[key]),
      getDot: vi.fn((key: string) =>
        key
          .split('.')
          .reduce<unknown>((node, segment) => (node as Record<string, unknown>)?.[segment], store)
      ),
      set: vi.fn((key: string, value: unknown) => {
        store[key] = value;
      }),
      getAll: vi.fn(() => ({ version: 1, ...store })),
    },
    initConfigManager: vi.fn(),
  };
});

vi.mock('../../env.js', () => ({
  env: {
    DORKOS_PORT: 6242,
    DORKOS_SERVER_ROLE: 'computer',
    MCP_API_KEY: undefined as string | undefined,
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: {
      enabled: false,
      connected: false,
      url: null,
      port: null,
      startedAt: null,
      authEnabled: false,
      tokenConfigured: false,
      domain: null,
    },
  },
}));

vi.mock('../../services/runtimes/claude-code/sdk/sdk-utils.js', () => ({
  resolveClaudeCliPath: vi.fn(() => null),
}));

vi.mock('../../services/tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn(() => false),
  getTasksInitError: vi.fn(() => undefined),
}));

vi.mock('../../services/relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn(() => false),
  getRelayInitError: vi.fn(() => undefined),
}));

vi.mock('../../services/mesh/mesh-state.js', () => ({
  getMeshInitError: vi.fn(() => undefined),
}));

vi.mock('../../lib/boundary.js', () => ({
  getBoundary: vi.fn(() => '/Users/test'),
}));

vi.mock('../../lib/version.js', () => ({
  SERVER_VERSION: '1.0.0',
  // A published build, so the real update check runs.
  IS_DEV_BUILD: false,
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  logError: vi.fn((err: unknown) => ({ err })),
}));

// The session gate lets every request through, so the cases that turn login on
// reach the route's own answer.
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));

// The auth barrel pulls in Better Auth + the DB adapter; mock the readers
// the config route uses so the router imports cleanly without a live auth instance.
vi.mock('../../services/core/auth/index.js', () => ({
  hasAnyApiKey: vi.fn(() => false),
  readOwnerEmail: vi.fn(() => null),
}));

// The local-token module reads env/fs at import; mock the two accessors the
// config route consults so the DTO + rotate route are exercised without touching
// the real 0600 token file.
vi.mock('../../services/core/auth/mcp-local-token.js', () => ({
  getMcpLocalToken: vi.fn(() => null),
  rotateMcpLocalToken: vi.fn(() => 'dork_mcp_local_rotated'),
}));

vi.mock('../../lib/dork-home.js', () => ({
  resolveDorkHome: vi.fn(() => '/tmp/dork-test'),
}));

import configRouter from '../config.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { resetCache } from '../../services/core/update-checker.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** A registry that never answers: every fetch hangs until the test ends. */
const hangingFetch = vi.fn(() => new Promise<never>(() => {}));

describe('GET /api/config with a registry that hangs', () => {
  beforeEach(() => {
    resetCache();
    hangingFetch.mockClear();
    vi.stubGlobal('fetch', hangingFetch);
    process.env.DORK_HOME = '/tmp/dork-test';
    fixtureTarget.mount(honoGroupListener({ path: '/api/config', routes: configRouter }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetCache();
  });

  it('answers at once, without waiting on npm', async () => {
    const started = Date.now();
    const res = await request(fixtureServer).get('/api/config').expect(200);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.body.latestVersion).toBeNull();
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });

  it('starts no second check while the first is still out', async () => {
    await request(fixtureServer).get('/api/config').expect(200);
    await request(fixtureServer).get('/api/config').expect(200);
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });
});
