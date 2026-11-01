/**
 * "Confirm it's you" before one sensitive action (DOR-3234), behind the real
 * `/api` chain with the session gate stubbed open: a guarded route holds its
 * action, and only a person's password, from the app's own page, in the
 * browser that asked, over a connection the password may cross, runs it.
 * Every way it fails writes nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const state = vi.hoisted(() => ({ ownerId: 'user_owner' as string | null }));
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
vi.mock('../../lib/trusted-origins.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/trusted-origins.js')>()),
  getTunnelHosts: () => ['box.ngrok.app'],
}));
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/audit/audit-trail.js')>()),
  recordAudit: vi.fn(),
}));

import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import {
  STEP_UP_MAX_PASSWORD_TRIES,
  STEP_UP_TTL_MS,
  StepUpRequiredBodySchema,
} from '@dorkos/shared/step-up';

import type { ApiEnv } from '../../http/api-chain.js';
import { readJsonBody } from '../../http/request-body.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { recordAudit } from '../../services/audit/audit-trail.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { markIngress, type IngressKind } from '../../services/core/remote/ingress-mark.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import { holdForStepUp } from '../step-up-guard.js';
import { createStepUpRoutes, type StepUpRouteDeps } from '../step-up.js';

const target = swappableServer();
const OWN_ORIGIN = 'http://localhost:4242';
const PASSWORD = 'correct horse battery';
const SHORT_PASSWORD = 'short';

const SESSION_A: RequestUser = { userId: 'user_owner', credential: 'cookie', sessionId: 'sess-a' };
const SESSION_B: RequestUser = { userId: 'user_owner', credential: 'cookie', sessionId: 'sess-b' };

let commit: Mock<(name: string) => Promise<{ status: number; body: unknown }>>;
let deps: StepUpRouteDeps & {
  checkPassword: ReturnType<typeof vi.fn>;
  setOwnerPassword: ReturnType<typeof vi.fn>;
};

/** A guarded route, as a consumer will write one: validate, then hold the commit. */
function guardedRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  router.post('/', async (c) => {
    const { name } = readJsonBody(c) as { name: string };
    return holdForStepUp(c, {
      kind: 'mcp-server.allow-global',
      target: name,
      input: { name, command: 'npx', args: ['-y', `@example/${name}`] },
      reason: `Confirm it’s you to add ${name} (\`@example/${name}\`) for all your agents.`,
      notes: ['Not pinned to a version. What runs can change later.'],
      commit: () => commit(name),
    });
  });
  return router;
}

function app(options: { user?: RequestUser; ingress?: IngressKind } = {}) {
  return target.mount(
    honoGroupListener(
      [
        { path: '/api/guarded', routes: guardedRoutes() },
        { path: '/api/step-up', routes: createStepUpRoutes(deps) },
      ],
      {
        before: async (c, next) => {
          if (options.user) c.set('user', options.user);
          if (options.ingress) markIngress(c.env.incoming, options.ingress);
          await next();
        },
      }
    )
  );
}

/** Ask for the guarded action, and return its held-action id. */
async function hold(options: { user?: RequestUser; ingress?: IngressKind } = { user: SESSION_A }) {
  const res = await request(app(options))
    .post('/api/guarded')
    .set('Origin', OWN_ORIGIN)
    .send({ name: 'github' });
  expect(res.status).toBe(428);
  return StepUpRequiredBodySchema.parse(res.body).heldActionId;
}

function confirm(
  id: string,
  password: string,
  options: { user?: RequestUser; ingress?: IngressKind } = { user: SESSION_A }
) {
  return request(app(options))
    .post(`/api/step-up/${id}/password`)
    .set('Origin', OWN_ORIGIN)
    .set('Sec-Fetch-Site', 'same-origin')
    .send({ password });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetHeldStepUpsForTests();
  commit = vi.fn(async (name: string) => ({ status: 201, body: { added: name } }));
  deps = {
    ownerId: () => state.ownerId,
    checkPassword: vi.fn(async (password: string | undefined) => {
      if (!password) return 'required' as const;
      return password === PASSWORD || password === SHORT_PASSWORD
        ? ('ok' as const)
        : ('wrong' as const);
    }),
    minPasswordLength: async () => 8,
    setOwnerPassword: vi.fn(async () => undefined),
    trustedOrigins: () => [OWN_ORIGIN],
  } as typeof deps;
});
afterEach(() => {
  vi.useRealTimers();
  state.ownerId = 'user_owner';
});

describe('a guarded action', () => {
  it('holds rather than runs, and writes nothing', async () => {
    await hold();
    expect(commit).not.toHaveBeenCalled();
  });

  it('shows the server’s own sentence about what will run', async () => {
    const id = await hold();
    const res = await request(app({ user: SESSION_A })).get(`/api/step-up/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      heldActionId: id,
      kind: 'mcp-server.allow-global',
      reason: 'Confirm it’s you to add github (`@example/github`) for all your agents.',
      notes: ['Not pinned to a version. What runs can change later.'],
      methods: ['password'],
      triesLeft: STEP_UP_MAX_PASSWORD_TRIES,
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers the Mac app’s own window, which names our origin on its read', async () => {
    // Measured on Electron 42: a main-process read with `Origin` arrives
    // `same-origin`; without one it arrives `none`, which is refused.
    const id = await hold();
    const shell = await request(app({ user: SESSION_A }))
      .get(`/api/step-up/${id}`)
      .set('Origin', OWN_ORIGIN)
      .set('Sec-Fetch-Site', 'same-origin');
    expect(shell.status).toBe(200);
    const bare = await request(app({ user: SESSION_A }))
      .get(`/api/step-up/${id}`)
      .set('Sec-Fetch-Site', 'none');
    expect(bare.status).toBe(403);
    expect(bare.body.code).toBe('not-a-person');
  });
});

// Security's 13:08 Musts (DOR-3234 PR 2): only the secret, checked on the
// server on that same request, grants a step-up. The Mac app's own headers
// and `Origin` are a CSRF guard, never a stand-in for it.
describe('the secret is the only proof', () => {
  const MAC_APP = {
    Origin: OWN_ORIGIN,
    'Sec-Fetch-Site': 'same-origin',
    'x-dorkos-person': 'proof-1',
    'User-Agent': 'Mozilla/5.0 (Macintosh) Electron/42.11.16 DorkOS/0.129.0',
  };

  it.each([
    ['no password', {}],
    ['an empty password', { password: '' }],
    ['a wrong password', { password: 'not-it' }],
  ])('the Mac app’s exact headers with %s are refused, and nothing runs', async (_label, body) => {
    const id = await hold();
    const res = await request(app({ user: SESSION_A }))
      .post(`/api/step-up/${id}/password`)
      .set(MAC_APP)
      .send(body);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.ok).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
  });

  it('a change-password with the Mac app’s headers but no current password runs nothing', async () => {
    const id = await hold();
    const res = await request(app({ user: SESSION_A }))
      .post(`/api/step-up/${id}/change-password`)
      .set(MAC_APP)
      .send({ newPassword: 'a much longer one' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(commit).not.toHaveBeenCalled();
    expect(deps.setOwnerPassword).not.toHaveBeenCalled();
  });

  it('checks the secret on every confirm: a passed one is never a pass for the next', async () => {
    const first = await hold();
    expect((await confirm(first, PASSWORD)).status).toBe(200);
    const second = await hold();
    const res = await request(app({ user: SESSION_A }))
      .post(`/api/step-up/${second}/password`)
      .set(MAC_APP)
      .send({});
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('leaves nothing an agent could replay: no answer or Activity line carries the password', async () => {
    const id = await hold();
    const view = await request(app({ user: SESSION_A })).get(`/api/step-up/${id}`);
    const done = await confirm(id, PASSWORD);
    for (const body of [view.body, done.body, vi.mocked(recordAudit).mock.calls]) {
      expect(JSON.stringify(body)).not.toContain(PASSWORD);
    }
  });
});

describe('POST /api/step-up/:id/password', () => {
  it('runs the held action once the password passes, and answers with its result', async () => {
    const id = await hold();
    const res = await confirm(id, PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 201, result: { added: 'github' } });
    expect(commit).toHaveBeenCalledExactlyOnceWith('github');
    expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'step-up.confirm', outcome: 'ok' })
    );
    expect(JSON.stringify(vi.mocked(recordAudit).mock.calls)).not.toContain(PASSWORD);
  });

  it('runs exactly what was held, whatever the confirm sends beside the password', async () => {
    const id = await hold();
    await request(app({ user: SESSION_A }))
      .post(`/api/step-up/${id}/password`)
      .set('Origin', OWN_ORIGIN)
      .send({ password: PASSWORD, name: 'evil', input: { command: 'rm' } });
    expect(commit).toHaveBeenCalledExactlyOnceWith('github');
  });

  it('is single use: a second confirm finds nothing, and nothing runs twice', async () => {
    const id = await hold();
    expect((await confirm(id, PASSWORD)).status).toBe(200);
    const again = await confirm(id, PASSWORD);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('expired');
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('writes nothing on a wrong password, and counts it', async () => {
    const id = await hold();
    const res = await confirm(id, 'wrong horse');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'wrong-password',
      triesLeft: STEP_UP_MAX_PASSWORD_TRIES - 1,
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('drops the action on its last wrong password, so even the right one then runs nothing', async () => {
    const id = await hold();
    for (let i = 1; i < STEP_UP_MAX_PASSWORD_TRIES; i++) {
      expect((await confirm(id, `guess ${i}`)).body.code).toBe('wrong-password');
    }
    const last = await confirm(id, 'guess last');
    expect(last.body.code).toBe('too-many-tries');
    expect((await confirm(id, PASSWORD)).body.code).toBe('expired');
    expect(commit).not.toHaveBeenCalled();
  });

  it('says when to try again while the owner’s password is throttled, and writes nothing', async () => {
    deps.checkPassword.mockResolvedValueOnce('too-many-attempts');
    const id = await hold();
    const res = await confirm(id, PASSWORD);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('too-many-attempts');
    expect(res.headers['retry-after']).toBeDefined();
    expect(commit).not.toHaveBeenCalled();
  });

  it('writes nothing once two minutes have passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const id = await hold();
    vi.setSystemTime(Date.now() + STEP_UP_TTL_MS);
    const res = await confirm(id, PASSWORD);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      code: 'expired',
      error: 'That took too long. Nothing changed.',
    });
    expect(commit).not.toHaveBeenCalled();
  });

  it('refuses a matching password shorter than the minimum, and keeps the action held', async () => {
    const id = await hold();
    const res = await confirm(id, SHORT_PASSWORD);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'password-too-short', minLength: 8 });
    expect(commit).not.toHaveBeenCalled();
    expect((await request(app({ user: SESSION_A })).get(`/api/step-up/${id}`)).status).toBe(200);
  });

  it('refuses where there is no owner password to check', async () => {
    const id = await hold();
    state.ownerId = null;
    const res = await confirm(id, PASSWORD);
    expect(res.body.code).toBe('no-password');
    expect(commit).not.toHaveBeenCalled();
  });
});

// Security Must 2: the password path needs this server's own page, port included.
describe('who may confirm', () => {
  // Each case names who refuses it: CORS stops a foreign origin before the route runs
  // (`ORIGIN_NOT_ALLOWED`); the route itself refuses everything else (`not-a-person`).
  const REFUSED: Array<
    [
      string,
      'ORIGIN_NOT_ALLOWED' | 'not-a-person',
      (r: ReturnType<typeof request>, id: string) => ReturnType<ReturnType<typeof request>['post']>,
    ]
  > = [
    [
      'no Origin header',
      'not-a-person',
      (r, id) => r.post(`/api/step-up/${id}/password`).send({ password: PASSWORD }),
    ],
    [
      'another port’s page on this computer',
      'ORIGIN_NOT_ALLOWED',
      (r, id) =>
        r
          .post(`/api/step-up/${id}/password`)
          .set('Origin', 'http://localhost:5173')
          .send({ password: PASSWORD }),
    ],
    [
      'another site',
      'ORIGIN_NOT_ALLOWED',
      (r, id) =>
        r
          .post(`/api/step-up/${id}/password`)
          .set('Origin', 'https://evil.example')
          .send({ password: PASSWORD }),
    ],
    [
      'a cross-site fetch carrying our Origin',
      'not-a-person',
      (r, id) =>
        r
          .post(`/api/step-up/${id}/password`)
          .set('Origin', OWN_ORIGIN)
          .set('Sec-Fetch-Site', 'cross-site')
          .send({ password: PASSWORD }),
    ],
    [
      'an agent',
      'not-a-person',
      (r, id) =>
        r
          .post(`/api/step-up/${id}/password`)
          .set('Origin', OWN_ORIGIN)
          .set('X-DorkOS-Agent', 'agent-1')
          .send({ password: PASSWORD }),
    ],
    [
      'a program with a key',
      'not-a-person',
      (r, id) =>
        r
          .post(`/api/step-up/${id}/password`)
          .set('Origin', OWN_ORIGIN)
          .set('Authorization', 'Bearer dork_key')
          .send({ password: PASSWORD }),
    ],
    [
      'a program with an API key header',
      'not-a-person',
      (r, id) =>
        r
          .post(`/api/step-up/${id}/password`)
          .set('Origin', OWN_ORIGIN)
          .set('X-Api-Key', 'not-a-real-key')
          .send({ password: PASSWORD }),
    ],
    [
      'a program with a proxy credential',
      'not-a-person',
      (r, id) =>
        r
          .post(`/api/step-up/${id}/password`)
          .set('Origin', OWN_ORIGIN)
          .set('Proxy-Authorization', 'Basic Zm9vOmJhcg==')
          .send({ password: PASSWORD }),
    ],
  ];

  // Whoever refuses, nothing runs and no password is checked.
  it.each(REFUSED)('refuses %s, and writes nothing', async (_label, code, send) => {
    const id = await hold();
    const res = await send(request(app({ user: SESSION_A })), id);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(code);
    expect(commit).not.toHaveBeenCalled();
    expect(deps.checkPassword).not.toHaveBeenCalled();
  });

  it('refuses an origin the server answers that is not exactly its own, port included', async () => {
    const id = await hold();
    deps.trustedOrigins = () => ['http://localhost:4241'];
    const res = await confirm(id, PASSWORD);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not-a-person');
    expect(deps.checkPassword).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('refuses another browser’s held action', async () => {
    const id = await hold({ user: SESSION_A });
    const res = await confirm(id, PASSWORD, { user: SESSION_B });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not-your-action');
    expect((await request(app({ user: SESSION_B })).get(`/api/step-up/${id}`)).body.code).toBe(
      'not-your-action'
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it('never takes a password over plain http from another device', async () => {
    const id = await hold({ user: SESSION_A, ingress: 'wifi' });
    const view = await request(app({ user: SESSION_A, ingress: 'wifi' })).get(`/api/step-up/${id}`);
    expect(view.body).toMatchObject({ methods: [], passwordUnavailable: 'insecure-connection' });
    const res = await confirm(id, PASSWORD, { user: SESSION_A, ingress: 'wifi' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'insecure-connection',
      error: 'Confirm this on the computer running DorkOS.',
    });
    expect(deps.checkPassword).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('takes the password over an encrypted connection from another device', async () => {
    const id = await hold({ user: SESSION_A, ingress: 'own-tunnel' });
    const res = await confirm(id, PASSWORD, { user: SESSION_A, ingress: 'own-tunnel' });
    expect(res.status).toBe(200);
    expect(commit).toHaveBeenCalledOnce();
  });
});

describe('POST /api/step-up/:id/change-password', () => {
  function change(id: string, body: object) {
    return request(app({ user: SESSION_A }))
      .post(`/api/step-up/${id}/change-password`)
      .set('Origin', OWN_ORIGIN)
      .send(body);
  }

  it('checks the current password, stores the new one, then runs the action', async () => {
    const id = await hold();
    const res = await change(id, {
      currentPassword: SHORT_PASSWORD,
      newPassword: 'a much longer password',
    });
    expect(res.status).toBe(200);
    expect(deps.setOwnerPassword).toHaveBeenCalledExactlyOnceWith(
      'user_owner',
      'a much longer password'
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(vi.mocked(recordAudit)).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'step-up.password-changed', outcome: 'ok' })
    );
    const audits = JSON.stringify(vi.mocked(recordAudit).mock.calls);
    expect(audits).not.toContain(SHORT_PASSWORD);
    expect(audits).not.toContain('a much longer password');
  });

  it('changes nothing with a wrong current password', async () => {
    const id = await hold();
    const res = await change(id, {
      currentPassword: 'nope',
      newPassword: 'a much longer password',
    });
    expect(res.body.code).toBe('wrong-password');
    expect(deps.setOwnerPassword).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('changes nothing when the new password is still too short', async () => {
    const id = await hold();
    const res = await change(id, { currentPassword: SHORT_PASSWORD, newPassword: 'tiny' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('new-password-invalid');
    expect(deps.setOwnerPassword).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/step-up/:id', () => {
  it('cancels: nothing ran, and nothing can run it later', async () => {
    const id = await hold();
    const res = await request(app({ user: SESSION_A }))
      .delete(`/api/step-up/${id}`)
      .set('Origin', OWN_ORIGIN);
    expect(res.status).toBe(204);
    expect((await confirm(id, PASSWORD)).body.code).toBe('expired');
    expect(commit).not.toHaveBeenCalled();
  });
});
