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
import { WEBHOOK_MANIFEST } from '@dorkos/relay';
import type { StreamEvent } from '@dorkos/shared/types';

import type { ApiEnv } from '../../http/api-chain.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import {
  countWhileRunning,
  resetLiveOutsiderTurns,
} from '../../services/core/turn-power/live-outsider-turns.js';
import type { AdapterManager } from '../../services/relay/adapter-manager.js';
import { env } from '../../env.js';
import { personSettingsIn, registerSettingRoutes } from '../relay-adapter-setting-routes.js';
import { createStepUpRoutes, type StepUpRouteDeps } from '../step-up.js';

const target = swappableServer();
const OWN_ORIGIN = 'http://localhost:4242';
const PASSWORD = 'correct horse battery';
const OWNER: RequestUser = { userId: 'user_owner', credential: 'cookie', sessionId: 'sess-a' };
const AGENT = ['X-DorkOS-Agent', 'agent-token'] as const;
const AGENT_HOME = '/made-up/agents/porter';
const URL_A = 'https://first.example.test/hooks';
const URL_B = 'https://second.example.test/hooks';
const WITH_SETTING = {
  url: 'https://hooks.example.dev',
  headers: { Authorization: 'env:DEPLOY_TOKEN' },
};

let manager: {
  testConnection: ReturnType<typeof vi.fn>;
  addAdapter: ReturnType<typeof vi.fn>;
  updateConfig: ReturnType<typeof vi.fn>;
  resolveAdapterName: ReturnType<typeof vi.fn>;
  getAdapter: ReturnType<typeof vi.fn>;
  getManifest: ReturnType<typeof vi.fn>;
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
          if (c.req.header(AGENT[0]) === AGENT[1]) {
            c.set('agentIdentity', {
              agentPath: AGENT_HOME,
              displayName: 'Porter',
              createdAt: '2026-11-01T00:00:00.000Z',
            });
          }
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
    getAdapter: vi.fn(() => ({
      config: {
        id: 'wh',
        type: 'webhook',
        enabled: true,
        builtin: false,
        config: {
          inbound: { subject: 'relay.webhook.wh', secret: '***' },
          outbound: { url: URL_A, secret: '***', headers: { Authorization: '***' } },
        },
      },
      status: { state: 'disabled' },
    })),
    getManifest: vi.fn(() => WEBHOOK_MANIFEST),
  };
});
afterEach(() => {
  state.ownerId = 'user_owner';
  state.notTheOwner = false;
  resetLiveOutsiderTurns();
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

/** Run `request` while the verified agent has an outsider-marked turn in progress. */
async function duringMarkedTurn<T>(run: () => Promise<T>): Promise<T> {
  const turn = countWhileRunning(
    { cwd: AGENT_HOME },
    { outsider: true },
    (async function* () {
      yield { type: 'done', data: {} } as StreamEvent;
    })()
  );
  await turn.next();
  try {
    return await run();
  } finally {
    await turn.return(undefined);
  }
}

/** Run one scenario with DOR-3858's boot flag temporarily set. */
async function withStrangerMarkFlag<T>(enabled: boolean, run: () => Promise<T>): Promise<T> {
  const key = 'DORKOS_MARK_STRANGER_TURNS';
  const target = env as unknown as Record<string, unknown>;
  const previous = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, enumerable: true, value: enabled });
  try {
    return await run();
  } finally {
    if (previous) Object.defineProperty(target, key, previous);
    else Reflect.deleteProperty(target, key);
  }
}

const TYPED_SECRETS = {
  inbound: { subject: 'relay.webhook.wh', secret: 'made-up-inbound-secret' },
  outbound: {
    url: URL_B,
    secret: 'made-up-outbound-secret',
    // The form sends this password map as JSON text. The gate must inspect the normalized map.
    headers: '{"Authorization":"made-up-header-secret"}',
  },
};

describe('a marked agent turn typing secrets into a connection (DOR-3858, DOR-4453 F2)', () => {
  it.each([
    {
      name: 'add',
      send: () =>
        request(app())
          .post('/api/relay/adapters')
          .set(...AGENT)
          .send({ type: 'webhook', id: 'wh-new', config: TYPED_SECRETS }),
      saved: () => manager.addAdapter,
    },
    {
      name: 'save',
      send: () =>
        request(app())
          .patch('/api/relay/adapters/wh/config')
          .set(...AGENT)
          .send({ config: TYPED_SECRETS }),
      saved: () => manager.updateConfig,
    },
  ])('refuses a $name with typed secrets and saves nothing', async ({ send, saved }) => {
    const res = await withStrangerMarkFlag(true, () => duringMarkedTurn(send));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('marked_turn_typed_secret');
    expect(saved()).not.toHaveBeenCalled();
  });

  // DOR-4453 F2: the address no longer decides it, so the two-call route is closed.
  it('refuses typed secrets at the same saved address', async () => {
    const res = await withStrangerMarkFlag(true, () =>
      duringMarkedTurn(() =>
        request(app())
          .patch('/api/relay/adapters/wh/config')
          .set(...AGENT)
          .send({
            config: { ...TYPED_SECRETS, outbound: { ...TYPED_SECRETS.outbound, url: URL_A } },
          })
      )
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('marked_turn_typed_secret');
    expect(manager.updateConfig).not.toHaveBeenCalled();
  });

  it('refuses the two-call route: add at a new address with no secret, then save one there', async () => {
    const [added, saved] = await withStrangerMarkFlag(true, () =>
      duringMarkedTurn(async () => {
        const first = await request(app())
          .post('/api/relay/adapters')
          .set(...AGENT)
          .send({ type: 'webhook', id: 'wh', config: { outbound: { url: URL_A } } });
        // The connection now names URL_A, which is the saved address the second call sends.
        const second = await request(app())
          .patch('/api/relay/adapters/wh/config')
          .set(...AGENT)
          .send({
            config: {
              outbound: { url: URL_A, headers: '{"Authorization":"made-up-header-secret"}' },
            },
          });
        return [first, second] as const;
      })
    );

    expect(added.status).toBe(201);
    expect(saved.status).toBe(403);
    expect(saved.body.code).toBe('marked_turn_typed_secret');
    expect(manager.updateConfig).not.toHaveBeenCalled();
  });

  it('lets a marked turn save a change that types no secret', async () => {
    const res = await withStrangerMarkFlag(true, () =>
      duringMarkedTurn(() =>
        request(app())
          .patch('/api/relay/adapters/wh/config')
          .set(...AGENT)
          .send({
            config: { outbound: { url: URL_A, secret: '***', headers: '{"Authorization":"***"}' } },
          })
      )
    );

    expect(res.status).toBe(200);
    expect(manager.updateConfig).toHaveBeenCalledOnce();
  });

  it('allows an unmarked agent turn to use a new address', async () => {
    const res = await withStrangerMarkFlag(true, () =>
      request(app())
        .patch('/api/relay/adapters/wh/config')
        .set(...AGENT)
        .send({ config: TYPED_SECRETS })
    );

    expect(res.status).toBe(200);
    expect(manager.updateConfig).toHaveBeenCalledOnce();
  });

  it('allows the person writer to use a new address', async () => {
    const res = await withStrangerMarkFlag(true, () =>
      request(app()).patch('/api/relay/adapters/wh/config').send({ config: TYPED_SECRETS })
    );

    expect(res.status).toBe(200);
    expect(manager.updateConfig).toHaveBeenCalledOnce();
  });

  it('refuses a test that sends typed secrets, and connects nothing', async () => {
    const res = await withStrangerMarkFlag(true, () =>
      duringMarkedTurn(() =>
        request(app())
          .post('/api/relay/adapters/test')
          .set(...AGENT)
          .send({ type: 'webhook', config: TYPED_SECRETS })
      )
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('marked_turn_typed_secret');
    expect(manager.testConnection).not.toHaveBeenCalled();
  });

  it('lets an unmarked agent turn test the same connection', async () => {
    const res = await withStrangerMarkFlag(true, () =>
      request(app())
        .post('/api/relay/adapters/test')
        .set(...AGENT)
        .send({ type: 'webhook', config: TYPED_SECRETS })
    );

    expect(res.status).toBe(200);
    expect(manager.testConnection).toHaveBeenCalledOnce();
  });

  // Fail closed: an agent header DorkOS can't resolve names no turn to read marks from.
  it('refuses an agent it cannot identify, with a reason that says so', async () => {
    const res = await withStrangerMarkFlag(true, () =>
      request(app())
        .post('/api/relay/adapters')
        .set('X-DorkOS-Agent', 'made-up-unknown-token')
        .send({ type: 'webhook', id: 'wh-new', config: TYPED_SECRETS })
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('marked_turn_typed_secret');
    expect(res.body.error).toContain("couldn't tell which agent");
    expect(manager.addAdapter).not.toHaveBeenCalled();
  });

  // Re-review of #3778: a signed-in person who isn't the owner presents no agent header, so this
  // rule doesn't judge them, and they aren't told they are an agent.
  it('lets a signed-in person who is not the owner add a typed secret at a new address', async () => {
    state.notTheOwner = true;
    const res = await withStrangerMarkFlag(true, () =>
      request(app())
        .post('/api/relay/adapters')
        .send({ type: 'webhook', id: 'wh-new', config: TYPED_SECRETS })
    );

    expect(res.status).toBe(201);
    expect(manager.addAdapter).toHaveBeenCalledOnce();
  });

  it('refuses an agent it cannot identify at the same saved address too', async () => {
    const res = await withStrangerMarkFlag(true, () =>
      request(app())
        .patch('/api/relay/adapters/wh/config')
        .set('X-DorkOS-Agent', 'made-up-unknown-token')
        .send({
          config: { ...TYPED_SECRETS, outbound: { ...TYPED_SECRETS.outbound, url: URL_A } },
        })
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('marked_turn_typed_secret');
    expect(manager.updateConfig).not.toHaveBeenCalled();
  });

  // DOR-4453 review nit 3: a plugin whose endpoint is typed text. Rule 3 clears stored secrets only
  // for a url field, so without this gate the masks would carry the saved token to the new endpoint.
  describe('a plugin connection whose endpoint is typed text', () => {
    const PLUGIN_MANIFEST = {
      ...WEBHOOK_MANIFEST,
      type: 'example-plugin',
      configFields: [
        { key: 'endpoint', type: 'text', label: 'Endpoint' },
        { key: 'token', type: 'password', label: 'Token', required: true },
      ],
    } as typeof WEBHOOK_MANIFEST;
    const MOVE = { endpoint: 'https://outside.example.test/in', token: '***' };

    beforeEach(() => {
      manager.getManifest = vi.fn(() => PLUGIN_MANIFEST);
      manager.getAdapter = vi.fn(() => ({
        config: {
          id: 'wh',
          type: 'example-plugin',
          enabled: true,
          builtin: false,
          config: {
            endpoint: 'https://owner.example.test/in',
            token: 'file:relay-adapter:wh:token',
          },
        },
        status: { state: 'disabled' },
      })) as unknown as typeof manager.getAdapter;
    });

    it('refuses a marked turn that moves the endpoint, and saves nothing', async () => {
      const res = await withStrangerMarkFlag(true, () =>
        duringMarkedTurn(() =>
          request(app())
            .patch('/api/relay/adapters/wh/config')
            .set(...AGENT)
            .send({ config: MOVE })
        )
      );

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('marked_turn_moves_secret');
      expect(manager.updateConfig).not.toHaveBeenCalled();
    });

    it('refuses an agent it cannot identify the same way', async () => {
      const res = await withStrangerMarkFlag(true, () =>
        request(app())
          .patch('/api/relay/adapters/wh/config')
          .set('X-DorkOS-Agent', 'made-up-unknown-token')
          .send({ config: MOVE })
      );

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('marked_turn_moves_secret');
    });

    it('lets an unmarked agent turn move it, as before', async () => {
      const res = await withStrangerMarkFlag(true, () =>
        request(app())
          .patch('/api/relay/adapters/wh/config')
          .set(...AGENT)
          .send({ config: MOVE })
      );

      expect(res.status).toBe(200);
      expect(manager.updateConfig).toHaveBeenCalledOnce();
    });
  });

  it('keeps today’s behavior while the flag is off', async () => {
    const res = await withStrangerMarkFlag(false, () =>
      duringMarkedTurn(() =>
        request(app())
          .patch('/api/relay/adapters/wh/config')
          .set(...AGENT)
          .send({ config: TYPED_SECRETS })
      )
    );

    expect(res.status).toBe(200);
    expect(manager.updateConfig).toHaveBeenCalledOnce();
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
