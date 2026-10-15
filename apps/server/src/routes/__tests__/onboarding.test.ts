/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserConfigSchema, type UserConfig } from '@dorkos/shared/config-schema';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import type { RequestUser } from '../../services/core/auth/session-gate.js';

// The session gate lets every request through: these cases are about the
// routes' own bars, and each one sets the user the gate would have proved
// (`before` below).
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../services/core/auth/index.js', async (original) => ({
  ...(await original<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => ({ id: 'owner', name: 'Owner' }),
}));
vi.mock('../../services/core/operator/config-write.js', async (original) => ({
  ...(await original<typeof import('../../services/core/operator/config-write.js')>()),
  logConfigWrite: vi.fn(),
}));

import { configManager } from '../../services/core/config-manager.js';
import type { FirstRunDeps } from '../../services/core/onboarding/first-run.js';
import type { WelcomeDeps } from '../../services/core/onboarding/welcome.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createOnboardingRoutes } from '../onboarding.js';

let config: UserConfig;
const setDorkBotRuntime = vi.fn(async () => {});
const storeCredential = vi.fn();
const fetchList = vi.fn();
const postAgentGreeting = vi.fn();

const firstRunDeps = (): FirstRunDeps => ({
  config: {
    get: (key) => config[key],
    set: (key, value) => {
      config = { ...config, [key]: value };
    },
  },
  setDorkBotRuntime,
  storeCredential,
  fetch: fetchList,
  linked: () => false,
  isRuntime: () => true,
});

const welcomeDeps = (): WelcomeDeps => ({
  config: firstRunDeps().config,
  rooms: {
    findWellKnownRoom: () => null,
    listAgentMembers: () => [],
    postAgentGreeting,
    hasEntry: () => false,
  },
  dorkbotPath: '/dork/agents/dorkbot',
  personName: () => null,
});

const server = listeningServer(
  honoGroupListener(
    {
      path: '/api/onboarding',
      routes: createOnboardingRoutes({ firstRun: firstRunDeps, welcome: welcomeDeps }),
    },
    {
      before: async (c, next) => {
        const kind = c.req.header('x-fixture-user');
        if (kind) {
          c.set('user', {
            userId: kind === 'member-cookie' ? 'member' : 'owner',
            credential: kind === 'owner-api-key' ? 'api-key' : 'cookie',
          } satisfies RequestUser);
        }
        await next();
      },
    }
  )
);

beforeEach(() => {
  vi.clearAllMocks();
  config = UserConfigSchema.parse({ version: 1 });
  vi.mocked(configManager.get).mockImplementation((key) => config[key] as never);
});

describe('POST /api/onboarding/first-run', () => {
  for (const header of ['X-DorkOS-Agent', 'X-DorkOS-Approval']) {
    it(`refuses ${header} before any write, even on loopback with login off`, async () => {
      const res = await request(server)
        .post('/api/onboarding/first-run')
        .set(header, 'present')
        .send({ path: 'dorkos' });
      expect(res.status).toBe(403);
      expect(config.runtimes.default).toBe('claude-code');
      expect(setDorkBotRuntime).not.toHaveBeenCalled();
    });
  }

  for (const user of ['owner-api-key', 'member-cookie']) {
    it(`refuses ${user} under login before any write`, async () => {
      config.auth.enabled = true;
      const res = await request(server)
        .post('/api/onboarding/first-run')
        .set('X-Fixture-User', user)
        .send({ path: 'dorkos' });
      expect(res.status).toBe(403);
      expect(config.onboarding.firstRunPath).toBeNull();
    });
  }

  it('applies the pick for the local operator and answers what it set up', async () => {
    const res = await request(server).post('/api/onboarding/first-run').send({ path: 'dorkos' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: 'dorkos', runtime: 'doe' });
    expect(setDorkBotRuntime).toHaveBeenCalledWith('doe');
  });

  it('refuses a body that names no known path', async () => {
    const res = await request(server)
      .post('/api/onboarding/first-run')
      .send({ path: 'own', choice: { kind: 'openai' } });
    expect(res.status).toBe(400);
    expect(storeCredential).not.toHaveBeenCalled();
  });

  it('answers 409 with its code once the first run is finished', async () => {
    config.onboarding.completedAt = '2026-10-01T00:00:00.000Z';
    const res = await request(server).post('/api/onboarding/first-run').send({ path: 'none' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Setup is already finished.', code: 'onboarding_complete' });
  });
});

describe('POST /api/onboarding/welcome', () => {
  it('refuses an agent before posting anything', async () => {
    const res = await request(server).post('/api/onboarding/welcome').set('X-DorkOS-Agent', 'x');
    expect(res.status).toBe(403);
    expect(postAgentGreeting).not.toHaveBeenCalled();
  });

  it('answers 503 while #team is not there yet', async () => {
    const res = await request(server).post('/api/onboarding/welcome');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('team_unavailable');
  });
});
