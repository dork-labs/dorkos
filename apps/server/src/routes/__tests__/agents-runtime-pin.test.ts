/**
 * A person's new agent runs on the runtime they picked (DOR-3459): both
 * creation routes pin what DorkOS wrote when a PERSON asked, and leave an
 * agent's new agent unpinned, so its runtime waits for a person's card.
 *
 * Driven through the real `/api` chain and identity middleware, with only the
 * token→agent lookup and the pin itself faked: the subject is who triggers it.
 *
 * @module routes/__tests__/agents-runtime-pin
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const KNOWN_TOKEN = 'tok_known_agent';

vi.mock('../../services/core/agent-identity/agent-identity-service.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../services/core/agent-identity/agent-identity-service.js')
  >()),
  getAgentIdentityService: () => ({
    resolve: async (token: string) =>
      token === KNOWN_TOKEN
        ? { agentPath: '/tmp/agents/maker', displayName: 'Maker', createdAt: '2026-10-30' }
        : null,
  }),
}));

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  expandTilde: vi.fn((p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));

vi.mock('@dorkos/shared/manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/shared/manifest')>()),
  readManifest: vi.fn(async () => null),
  writeManifest: vi.fn(async () => undefined),
}));

vi.mock('@dorkos/shared/convention-files-io', () => ({
  readConventionFile: vi.fn(async () => null),
  writeConventionFile: vi.fn(async () => undefined),
  writeConventionFileIfAbsent: vi.fn(async () => true),
}));

vi.mock('../../services/heartbeats/heartbeat-file.js', () => ({
  seedHeartbeatFile: vi.fn(async () => undefined),
}));

vi.mock('../../services/core/agent-created-hook.js', () => ({
  notifyAgentCreated: vi.fn(async () => undefined),
}));

vi.mock('../../services/core/agent-creator.js', () => ({
  createAgentWorkspace: vi.fn(async () => ({
    manifest: { id: 'created-1', name: 'created' },
    path: '/tmp/agents/created',
  })),
  AgentCreationError: class AgentCreationError extends Error {},
}));

vi.mock('../../services/runtimes/claude-code/folder-settings/folder-config-consent.js', () => ({
  pinPersonCreatedAgent: vi.fn(() => true),
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

vi.mock('ulidx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ulidx')>()),
  ulid: vi.fn(() => 'NEW_AGENT_ID'),
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createAgentsRoutes } from '../agents.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { pinPersonCreatedAgent } from '../../services/runtimes/claude-code/folder-settings/folder-config-consent.js';

const target = swappableServer();

const ROUTES = [
  {
    name: 'POST /api/agents',
    drive: (headers: Record<string, string>) =>
      request(target.server)
        .post('/api/agents')
        .set(headers)
        .send({ path: '/tmp/agents/new', name: 'new', runtime: 'codex' }),
    pinned: ['NEW_AGENT_ID', '/tmp/agents/new'],
  },
  {
    name: 'POST /api/agents/create',
    drive: (headers: Record<string, string>) =>
      request(target.server)
        .post('/api/agents/create')
        .set(headers)
        .send({ name: 'created', directory: '/tmp/agents/created', runtime: 'opencode' }),
    pinned: ['created-1', '/tmp/agents/created'],
  },
];

describe.each(ROUTES)('$name pins a new agent only for a person', ({ drive, pinned }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    target.mount(honoGroupListener({ path: '/api/agents', routes: createAgentsRoutes({}) }));
  });

  it("pins the person's new agent, so its runtime is honoured", async () => {
    const res = await drive({});
    expect(res.status).toBe(201);
    expect(pinPersonCreatedAgent).toHaveBeenCalledWith(...pinned);
  });

  it("leaves an agent's new agent unpinned, for a person's card", async () => {
    const res = await drive({ 'x-dorkos-agent': KNOWN_TOKEN });
    expect(res.status).toBe(201);
    expect(pinPersonCreatedAgent).not.toHaveBeenCalled();
  });
});
