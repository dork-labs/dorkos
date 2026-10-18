/**
 * @vitest-environment node
 *
 * The owner's agent grant routes on `/api/hub/agent-grants` (DOR-2939 part 6),
 * behind the real `/api` chain: a hub only, the owner's own browser sign-in
 * only, never an agent or an API key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: () => undefined, onChange: () => () => {} },
}));
const audit = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('../../services/audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/audit/audit-trail.js')>()),
  recordAudit: audit.record,
}));

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { NO_SETUP_GRANTS, type SetupGrants } from '../../services/core/tool-bridge/index.js';
import { createHubAgentGrantRoutes, type HubAgentGrantRoutesDeps } from '../hub-agent-grants.js';

const SCOUT = '01KJXYKJYW4N8QGQ5W4GB6YM9J';
const ATLAS = '01KJXYKJYW4N8QGQ5W4GB6YM9K';

const caller: { credential: 'cookie' | 'api-key' | null; userId: string } = {
  credential: 'cookie',
  userId: 'user_owner',
};
let grants: SetupGrants;

const deps = {
  isHub: vi.fn(() => true),
  ownerId: vi.fn((): string | null => 'user_owner'),
  read: vi.fn(() => grants),
  setDorkBotSetup: vi.fn(async (granted: boolean) => {
    grants = { ...grants, dorkbotSetup: granted };
    return grants;
  }),
  allowPair: vi.fn(async (from: string, to: string) => {
    grants = {
      ...grants,
      pairs: [...grants.pairs, { from, to, grantedAt: '2026-10-18T00:00:00.000Z' }],
    };
    return grants;
  }),
  removePair: vi.fn(async () => grants),
} satisfies HubAgentGrantRoutesDeps;

const server = listeningServer(
  honoGroupListener(
    { path: '/api/hub/agent-grants', routes: createHubAgentGrantRoutes(deps) },
    {
      before: async (c, next) => {
        if (caller.credential)
          c.set('user', { userId: caller.userId, credential: caller.credential });
        await next();
      },
    }
  )
);

beforeEach(() => {
  vi.clearAllMocks();
  caller.credential = 'cookie';
  caller.userId = 'user_owner';
  grants = NO_SETUP_GRANTS;
  deps.isHub.mockReturnValue(true);
  deps.ownerId.mockReturnValue('user_owner');
});

const ROUTES = [
  ['get', '/api/hub/agent-grants', undefined],
  ['put', '/api/hub/agent-grants/dorkbot-setup', { granted: true }],
  ['post', '/api/hub/agent-grants/pairs', { from: SCOUT, to: ATLAS }],
  ['delete', `/api/hub/agent-grants/pairs/${SCOUT}/${ATLAS}`, undefined],
] as const;

/** Send one of {@link ROUTES}. */
function send(method: (typeof ROUTES)[number][0], path: string, body?: object) {
  const req = request(server)[method](path);
  return body ? req.send(body) : req;
}

const writes = () => [deps.setDorkBotSetup, deps.allowPair, deps.removePair];

describe('who is answered', () => {
  it.each(ROUTES)('%s %s is the /api 404 on anything but a hub', async (method, path, body) => {
    deps.isHub.mockReturnValue(false);
    const res = await send(method, path, body);
    expect(res.status).toBe(404);
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it.each(ROUTES)(
    '%s %s refuses a caller presenting agent identity',
    async (method, path, body) => {
      const res = await send(method, path, body).set('X-DorkOS-Agent', 'agent-token');
      expect(res.status).toBe(403);
      expect(deps.read).not.toHaveBeenCalled();
      for (const write of writes()) expect(write).not.toHaveBeenCalled();
    }
  );

  it.each(ROUTES)('%s %s refuses an API key', async (method, path, body) => {
    caller.credential = 'api-key';
    const res = await send(method, path, body);
    expect(res.status).toBe(403);
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it.each(ROUTES)(
    '%s %s refuses a signed-in account that is not the owner',
    async (method, path, body) => {
      caller.userId = 'user_invited';
      const res = await send(method, path, body);
      expect(res.status).toBe(403);
      expect(deps.read).not.toHaveBeenCalled();
      for (const write of writes()) expect(write).not.toHaveBeenCalled();
    }
  );

  it('refuses everyone while the hub has no owner', async () => {
    deps.ownerId.mockReturnValue(null);
    expect((await request(server).get('/api/hub/agent-grants')).status).toBe(403);
  });

  it('records a refused change, and not a refused read', async () => {
    caller.credential = 'api-key';
    await send('put', '/api/hub/agent-grants/dorkbot-setup', { granted: true });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'hub.agent_grants.dorkbot_setup',
        outcome: 'refused',
        error: 'api_key',
      })
    );
    audit.record.mockClear();
    await request(server).get('/api/hub/agent-grants');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s %s refuses nobody signed in', async (method, path, body) => {
    caller.credential = null;
    expect((await send(method, path, body)).status).toBe(401);
  });
});

describe('the owner', () => {
  it('reads the grants, never cached', async () => {
    const res = await request(server).get('/api/hub/agent-grants');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(NO_SETUP_GRANTS);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('turns DorkBot`s setup level on, audited for them alone', async () => {
    const res = await send('put', '/api/hub/agent-grants/dorkbot-setup', { granted: true });
    expect(res.status).toBe(200);
    expect(res.body.dorkbotSetup).toBe(true);
    expect(deps.setDorkBotSetup).toHaveBeenCalledWith(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub.agent_grants.dorkbot_setup', outcome: 'ok' })
    );
  });

  it('allows and removes a pair', async () => {
    expect(
      (await send('post', '/api/hub/agent-grants/pairs', { from: SCOUT, to: ATLAS })).status
    ).toBe(200);
    expect(deps.allowPair).toHaveBeenCalledWith(SCOUT, ATLAS);
    const removed = await request(server).delete(`/api/hub/agent-grants/pairs/${SCOUT}/${ATLAS}`);
    expect(removed.status).toBe(200);
    expect(deps.removePair).toHaveBeenCalledWith(SCOUT, ATLAS);
  });

  it.each([
    ['put', '/api/hub/agent-grants/dorkbot-setup', { granted: 'yes' }],
    ['put', '/api/hub/agent-grants/dorkbot-setup', { granted: true, extra: 1 }],
    ['post', '/api/hub/agent-grants/pairs', { from: SCOUT, to: SCOUT }],
    ['post', '/api/hub/agent-grants/pairs', { from: '../etc', to: ATLAS }],
  ] as const)('refuses %s %s with %j', async (method, path, body) => {
    expect((await send(method, path, body)).status).toBe(400);
    for (const write of writes()) expect(write).not.toHaveBeenCalled();
  });

  it('answers 409 when there is no room for another pair', async () => {
    deps.allowPair.mockRejectedValueOnce(new Error('full'));
    const res = await send('post', '/api/hub/agent-grants/pairs', { from: SCOUT, to: ATLAS });
    expect(res.status).toBe(409);
    expect(res.body.error).not.toMatch(/full/);
  });
});
