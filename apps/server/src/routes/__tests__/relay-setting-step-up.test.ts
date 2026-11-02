/**
 * Security's #3401 M1 (DOR-3234): test, add and save hand a connection a
 * person's `env:`/`keychain:` setting, which approves it (add, save) or
 * resolves it (test). From the owner's cookie alone that would unpause a
 * paused connection with no password, so each is held for "Confirm it's you"
 * exactly as Confirm this setting is. Nothing is written until it passes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ ownerId: 'user_owner' as string | null, notTheOwner: false }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: false } : undefined)),
    set: vi.fn(),
    onChange: vi.fn(() => () => undefined),
  },
}));
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => (state.ownerId ? { id: state.ownerId } : null),
  hasAnyUser: () => state.ownerId !== null,
}));
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/audit/audit-trail.js')>()),
  recordAudit: vi.fn(),
}));
vi.mock('../../lib/caller-authority.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/caller-authority.js')>();
  return {
    ...actual,
    refuseUnlessAccountOwner: (facts: Parameters<typeof actual.refuseUnlessAccountOwner>[0]) =>
      state.notTheOwner ? 'not-the-owner' : actual.refuseUnlessAccountOwner(facts),
  };
});

import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { StepUpRequiredBodySchema } from '@dorkos/shared/step-up';

import type { ApiEnv } from '../../http/api-chain.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import type { AdapterManager } from '../../services/relay/adapter-manager.js';
import { personSettingsIn, registerSettingRoutes } from '../relay-adapter-setting-routes.js';
import { createStepUpRoutes, type StepUpRouteDeps } from '../step-up.js';

const target = swappableServer();
const OWN_ORIGIN = 'http://localhost:4242';
const PASSWORD = 'correct horse battery';
const OWNER: RequestUser = { userId: 'user_owner', credential: 'cookie', sessionId: 'sess-a' };
const WITH_SETTING = {
  url: 'https://hooks.example.dev',
  headers: { Authorization: 'env:DEPLOY_TOKEN' },
};

let manager: {
  testConnection: ReturnType<typeof vi.fn>;
  addAdapter: ReturnType<typeof vi.fn>;
  updateConfig: ReturnType<typeof vi.fn>;
  resolveAdapterName: ReturnType<typeof vi.fn>;
};

const stepUpDeps: StepUpRouteDeps = {
  ownerId: () => state.ownerId,
  checkPassword: async (password) =>
    !password ? 'required' : password === PASSWORD ? 'ok' : 'wrong',
  minPasswordLength: async () => 8,
  setOwnerPassword: async () => undefined,
  trustedOrigins: () => [OWN_ORIGIN],
};

function app(user: RequestUser | null = OWNER) {
  const relay = new Hono<ApiEnv>();
  registerSettingRoutes(relay, {
    adapterManager: manager as unknown as AdapterManager,
    ownerExists: () => state.ownerId !== null,
  });
  return target.mount(
    honoGroupListener(
      [
        { path: '/api/relay', routes: relay },
        { path: '/api/step-up', routes: createStepUpRoutes(stepUpDeps) },
      ],
      {
        before: async (c, next) => {
          if (user) c.set('user', user);
          await next();
        },
      }
    )
  );
}

/** The three routes, each with a person's setting in its body. */
const ROUTES = [
  {
    name: 'save (PATCH /adapters/:id/config)',
    send: (r: ReturnType<typeof request>) =>
      r
        .patch('/api/relay/adapters/wh/config')
        .set('Origin', OWN_ORIGIN)
        .send({ config: WITH_SETTING }),
    call: () => manager.updateConfig,
    reason: 'Lets “Deploy hooks” use DEPLOY_TOKEN.',
  },
  {
    name: 'add (POST /adapters)',
    send: (r: ReturnType<typeof request>) =>
      r
        .post('/api/relay/adapters')
        .set('Origin', OWN_ORIGIN)
        .send({ type: 'webhook', id: 'wh2', label: 'Deploy hooks', config: WITH_SETTING }),
    call: () => manager.addAdapter,
    reason: 'Lets “Deploy hooks” use DEPLOY_TOKEN.',
  },
  {
    name: 'test (POST /adapters/test)',
    send: (r: ReturnType<typeof request>) =>
      r
        .post('/api/relay/adapters/test')
        .set('Origin', OWN_ORIGIN)
        .send({ type: 'webhook', config: WITH_SETTING }),
    call: () => manager.testConnection,
    reason: 'Lets a “webhook” test read DEPLOY_TOKEN.',
  },
];

function confirmWith(id: string, password: string) {
  return request(app())
    .post(`/api/step-up/${id}/password`)
    .set('Origin', OWN_ORIGIN)
    .send({ password });
}

beforeEach(() => {
  resetHeldStepUpsForTests();
  manager = {
    testConnection: vi.fn(async () => ({ ok: true })),
    addAdapter: vi.fn(async () => undefined),
    updateConfig: vi.fn(async () => undefined),
    resolveAdapterName: vi.fn(() => 'Deploy hooks'),
  };
});
afterEach(() => {
  state.ownerId = 'user_owner';
  state.notTheOwner = false;
});

describe.each(ROUTES)('$name with a person’s setting', ({ send, call, reason }) => {
  it('holds it for "Confirm it’s you", and writes or resolves nothing', async () => {
    const res = await send(request(app()));
    expect(res.status).toBe(428);
    expect(StepUpRequiredBodySchema.safeParse(res.body).success).toBe(true);
    expect(call()).not.toHaveBeenCalled();
  });

  it('shows what it hands over', async () => {
    const id = StepUpRequiredBodySchema.parse((await send(request(app()))).body).heldActionId;
    const view = await request(app()).get(`/api/step-up/${id}`);
    expect(view.body.reason).toBe(reason);
  });

  it('a wrong password runs nothing; the right one runs it as the person', async () => {
    const id = StepUpRequiredBodySchema.parse((await send(request(app()))).body).heldActionId;
    expect((await confirmWith(id, 'nope')).body.code).toBe('wrong-password');
    expect(call()).not.toHaveBeenCalled();
    const done = await confirmWith(id, PASSWORD);
    expect(done.body.ok).toBe(true);
    expect(call()).toHaveBeenCalledTimes(1);
    expect(call().mock.calls[0]).toContain('person');
  });

  it('re-checks the owner when it commits: an owner replaced meanwhile runs nothing', async () => {
    const id = StepUpRequiredBodySchema.parse((await send(request(app()))).body).heldActionId;
    state.notTheOwner = true;
    const res = await confirmWith(id, PASSWORD);
    expect(res.body).toMatchObject({ ok: true, status: 403, result: { code: 'owner_only' } });
    expect(call()).not.toHaveBeenCalled();
  });

  it('with no owner yet, the person at this computer goes on with no sheet', async () => {
    state.ownerId = null;
    const res = await send(request(app(null)));
    expect(res.status).toBeLessThan(300);
    expect(call()).toHaveBeenCalledTimes(1);
  });

  it('with no owner yet, a program with a key is refused and nothing runs', async () => {
    state.ownerId = null;
    const res = await send(request(app(null))).set('Authorization', 'Bearer dork_key');
    expect(res.status).toBe(403);
    expect(call()).not.toHaveBeenCalled();
  });
});

describe('a request with no person’s setting', () => {
  it('runs at once, as before', async () => {
    const res = await request(app())
      .patch('/api/relay/adapters/wh/config')
      .set('Origin', OWN_ORIGIN)
      .send({ config: { url: 'https://hooks.example.dev', token: 'plain-value' } });
    expect(res.status).toBe(200);
    expect(manager.updateConfig).toHaveBeenCalledWith('wh', expect.any(Object), 'person');
  });

  it('an agent’s request runs as the agent, which never approves a setting', async () => {
    const res = await request(app())
      .patch('/api/relay/adapters/wh/config')
      .set('Origin', OWN_ORIGIN)
      .set('X-DorkOS-Agent', 'agent-1')
      .send({ config: WITH_SETTING });
    expect(res.status).not.toBe(428);
    expect(manager.updateConfig).toHaveBeenCalledWith('wh', expect.any(Object), 'agent');
  });
});

describe('personSettingsIn', () => {
  it('finds every env: and keychain: setting, nested anywhere, once each', () => {
    expect(
      personSettingsIn({
        a: 'env:ONE',
        b: { c: ['keychain:TWO', 'plain'], d: 'env:ONE' },
        e: 'secret:not-a-person-kind',
      })
    ).toEqual(['ONE', 'TWO']);
  });
});
