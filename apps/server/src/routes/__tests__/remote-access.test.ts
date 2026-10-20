/**
 * `/api/remote-access` (DOR-2086): who may start managed setup, choose a mode
 * and withdraw, and that closing stays open to everyone.
 *
 * The routes are served behind the real `/api` chain with the session gate
 * stubbed open and the identity it would have resolved set in `before`, the
 * way `tunnel.test.ts` tests the same bars, so a refusal here is the route's
 * and not the app gate's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(), set: vi.fn(), onChange: vi.fn(() => () => undefined) },
}));

// A tunnel is open at `box.ngrok.app`, so the `/api` host guard trusts that
// name and a request from another device reaches the route's own local bar.
vi.mock('../../lib/trusted-origins.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/trusted-origins.js')>()),
  getTunnelHosts: () => ['box.ngrok.app'],
}));

vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));

// The install's owner is `u1`.
vi.mock('../../services/core/auth/install-owner.js', () => ({
  isInstallOwner: (user?: { userId: string }) => user?.userId === 'u1',
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { RemoteAccessReport } from '@dorkos/shared/types';

import { configManager } from '../../services/core/config-manager.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { createRemoteAccessRoutes, REMOTE_SETUP_NEEDS_THIS_COMPUTER } from '../remote-access.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { NEEDS_PERSON_AT_THIS_COMPUTER } from '../../lib/caller-authority.js';

const REPORT: RemoteAccessReport = {
  mode: 'off',
  state: 'off',
  alwaysAvailable: false,
  cloudStale: false,
  availability: 'available',
  enrolment: { status: 'none' },
};

const target = swappableServer();
const mockConfigGet = vi.mocked(configManager.get) as unknown as ReturnType<typeof vi.fn>;

function deps() {
  return {
    coordinator: {
      report: vi.fn(async () => REPORT),
      startEnrolment: vi.fn(async () => ({ ok: true as const })),
      selectMode: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(),
      withdraw: vi.fn(async () => 'done' as const),
    },
    canExpose: vi.fn(() => true),
    stopOwnTunnel: vi.fn(async () => undefined),
  };
}

let current: ReturnType<typeof deps>;

/**
 * A person signed in from another device. Other devices always prove a person
 * session at the gate (ADR 261015-125850 rule 3), so a remote case carries one
 * to reach the route's own "only on this computer" bar.
 */
const SIGNED_IN: RequestUser = { userId: 'u1', credential: 'cookie' };

/** The routes alone, with the identity `sessionGate` would have resolved. */
function app(options: { user?: RequestUser; managed?: boolean } = {}) {
  return target.mount(
    honoGroupListener(
      { path: '/api/remote-access', routes: createRemoteAccessRoutes(current) },
      {
        before: async (c, next) => {
          if (options.user) c.set('user', options.user);
          if (options.managed) markIngress(c.env.incoming, 'managed');
          await next();
        },
      }
    )
  );
}

function loginOn(enabled: boolean): void {
  mockConfigGet.mockImplementation((key: string) => (key === 'auth' ? { enabled } : undefined));
}

beforeEach(() => {
  vi.clearAllMocks();
  current = deps();
  loginOn(false);
});

describe('GET /api/remote-access/report', () => {
  it('answers the report', async () => {
    const res = await request(app()).get('/api/remote-access/report');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(REPORT);
  });
});

describe.each([
  ['POST /enrolment', '/api/remote-access/enrolment', {}],
  ['POST /mode managed', '/api/remote-access/mode', { mode: 'managed' }],
])('%s, a person at this computer only', (_label, path, body) => {
  const effect = () =>
    path.endsWith('enrolment')
      ? current.coordinator.startEnrolment
      : current.coordinator.selectMode;

  it('lets the person at this computer through, and answers the report', async () => {
    const res = await request(app()).post(path).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(REPORT);
    expect(effect()).toHaveBeenCalled();
  });

  it('refuses a caller that names itself an agent', async () => {
    const res = await request(app()).post(path).set('x-dorkos-agent', 'agent-token').send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('operator_only_config');
    expect(effect()).not.toHaveBeenCalled();
  });

  it('refuses an API key under login, and lets a signed-in person through', async () => {
    loginOn(true);
    const key = await request(app({ user: { userId: 'u1', credential: 'api-key' } as RequestUser }))
      .post(path)
      .send(body);
    expect(key.status).toBe(403);
    expect(key.body.code).toBe('operator_cookie_required');
    expect(effect()).not.toHaveBeenCalled();

    const cookie = await request(
      app({ user: { userId: 'u1', credential: 'cookie' } as RequestUser })
    )
      .post(path)
      .send(body);
    expect(cookie.status).toBe(200);
    expect(effect()).toHaveBeenCalled();
  });

  it('refuses a person signed in on another device', async () => {
    const res = await request(app({ user: SIGNED_IN }))
      .post(path)
      .set('Host', 'box.ngrok.app')
      .send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(REMOTE_SETUP_NEEDS_THIS_COMPUTER);
    expect(effect()).not.toHaveBeenCalled();
  });

  it('refuses a person at this computer who is not the owner, and a bearer with the gate open', async () => {
    const guest = await request(app({ user: { userId: 'guest', credential: 'cookie' } }))
      .post(path)
      .send(body);
    expect(guest.status).toBe(403);
    expect(guest.body.code).toBe(NEEDS_PERSON_AT_THIS_COMPUTER);
    const bearer = await request(app())
      .post(path)
      .set('Authorization', 'Bearer some-key')
      .send(body);
    expect(bearer.status).toBe(403);
    expect(bearer.body.code).toBe(NEEDS_PERSON_AT_THIS_COMPUTER);
    expect(effect()).not.toHaveBeenCalled();
  });

  it('asks another device with no browser session for one, with the this-computer password off', async () => {
    // The cookie bar decides "login on" per request now: another device is
    // always asked, whatever "Ask for a password on this computer too" says.
    const res = await request(app()).post(path).set('Host', 'box.ngrok.app').send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('operator_cookie_required');
    expect(effect()).not.toHaveBeenCalled();
  });

  // Managed access is encrypted: the owner there is the owner at the desk (DOR-3172).
  it('lets the owner through over managed access, and nobody else', async () => {
    const guest = await request(app({ managed: true, user: { userId: 'guest', credential: 'cookie' } }))
      .post(path)
      .send(body);
    expect(guest.status).toBe(403);
    expect(guest.body.code).toBe(NEEDS_PERSON_AT_THIS_COMPUTER);
    expect(effect()).not.toHaveBeenCalled();
    const owner = await request(app({ managed: true, user: SIGNED_IN }))
      .post(path)
      .send(body);
    expect(owner.status).toBe(200);
    expect(effect()).toHaveBeenCalled();
  });

  it('refuses without a real login, with the code the client routes to owner setup', async () => {
    current.canExpose.mockReturnValue(false);
    const res = await request(app()).post(path).send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AUTH_REQUIRED_FOR_EXPOSURE');
    expect(effect()).not.toHaveBeenCalled();
  });
});

describe('POST /api/remote-access/enrolment', () => {
  it('passes the coordinator’s refusal through, such as the feature being off', async () => {
    current.coordinator.startEnrolment.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'MANAGED_REMOTE_UNAVAILABLE',
      error: 'Not available.',
    } as never);
    const res = await request(app()).post('/api/remote-access/enrolment');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'MANAGED_REMOTE_UNAVAILABLE', error: 'Not available.' });
  });
});

describe('POST /api/remote-access/mode', () => {
  it('lets a person choose their own tunnel without a login, which managed needs', async () => {
    current.canExpose.mockReturnValue(false);
    const res = await request(app()).post('/api/remote-access/mode').send({ mode: 'byo' });
    expect(res.status).toBe(200);
    expect(current.coordinator.selectMode).toHaveBeenCalledWith('byo');
    expect(current.stopOwnTunnel).not.toHaveBeenCalled();
  });

  it('turning it off also stops the person’s own tunnel', async () => {
    const res = await request(app()).post('/api/remote-access/mode').send({ mode: 'off' });
    expect(res.status).toBe(200);
    expect(current.coordinator.selectMode).toHaveBeenCalledWith('off');
    expect(current.stopOwnTunnel).toHaveBeenCalled();
  });

  it('refuses a mode it does not know', async () => {
    const res = await request(app()).post('/api/remote-access/mode').send({ mode: 'both' });
    expect(res.status).toBe(400);
    expect(current.coordinator.selectMode).not.toHaveBeenCalled();
  });

  it('refuses an agent even for off', async () => {
    const res = await request(app())
      .post('/api/remote-access/mode')
      .set('x-dorkos-agent', 'agent-token')
      .send({ mode: 'off' });
    expect(res.status).toBe(403);
    expect(current.stopOwnTunnel).not.toHaveBeenCalled();
  });
});

describe('POST /api/remote-access/close, open to every caller because it only narrows', () => {
  it('works for an agent, a remote caller and an API key under login', async () => {
    loginOn(true);
    const path = '/api/remote-access/close';
    const agent = await request(app()).post(path).set('x-dorkos-agent', 'agent-token');
    const remote = await request(app()).post(path).set('Host', 'box.ngrok.app');
    const key = await request(
      app({ user: { userId: 'u1', credential: 'api-key' } as RequestUser })
    ).post(path);
    for (const res of [agent, remote, key]) {
      expect(res.status).toBe(200);
      expect(res.body).toEqual(REPORT);
    }
    expect(current.coordinator.close).toHaveBeenCalledTimes(3);
  });
});

describe('POST /api/remote-access/withdraw, a person at this computer', () => {
  const path = '/api/remote-access/withdraw';

  it('lets the person through even with no real login, since it only narrows', async () => {
    current.canExpose.mockReturnValue(false);
    const res = await request(app()).post(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(REPORT);
    expect(current.coordinator.withdraw).toHaveBeenCalledTimes(1);
  });

  it('refuses an agent and another device (signed in or not), and lets the owner over managed access', async () => {
    const agent = await request(app()).post(path).set('x-dorkos-agent', 'agent-token');
    expect(agent.status).toBe(403);
    expect(agent.body.code).toBe('operator_only_config');
    const remote = await request(app({ user: SIGNED_IN }))
      .post(path)
      .set('Host', 'box.ngrok.app');
    expect(remote.status).toBe(403);
    expect(remote.body.code).toBe(REMOTE_SETUP_NEEDS_THIS_COMPUTER);
    const unsigned = await request(app()).post(path).set('Host', 'box.ngrok.app');
    expect(unsigned.status).toBe(403);
    expect(unsigned.body.code).toBe('operator_cookie_required');
    expect(current.coordinator.withdraw).not.toHaveBeenCalled();
    // The owner over managed access may withdraw, as at the desk (DOR-3172).
    const managed = await request(app({ managed: true, user: SIGNED_IN })).post(path);
    expect(managed.status).toBe(200);
    expect(current.coordinator.withdraw).toHaveBeenCalledTimes(1);
  });

  it('refuses an API key under login, and lets a signed-in person through', async () => {
    loginOn(true);
    const key = await request(
      app({ user: { userId: 'u1', credential: 'api-key' } as RequestUser })
    ).post(path);
    expect(key.status).toBe(403);
    expect(key.body.code).toBe('operator_cookie_required');
    expect(current.coordinator.withdraw).not.toHaveBeenCalled();
    const cookie = await request(
      app({ user: { userId: 'u1', credential: 'cookie' } as RequestUser })
    ).post(path);
    expect(cookie.status).toBe(200);
    expect(current.coordinator.withdraw).toHaveBeenCalledTimes(1);
  });
});
