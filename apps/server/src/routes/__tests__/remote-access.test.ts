/**
 * `/api/remote-access` (DOR-2086): who may start managed setup, choose a mode
 * and withdraw, and that closing stays open to everyone.
 *
 * The router is mounted alone behind a fixture standing in for `sessionGate`,
 * the way `tunnel.test.ts` tests the same bars, so a refusal here is the
 * route's and not the app gate's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(), set: vi.fn(), onChange: vi.fn(() => () => undefined) },
}));

import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { RemoteAccessReport } from '@dorkos/shared/types';

import { configManager } from '../../services/core/config-manager.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { markManagedIngress } from '../../services/core/remote/ingress-mark.js';
import { createRemoteAccessRouter, REMOTE_SETUP_NEEDS_THIS_COMPUTER } from '../remote-access.js';

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

/** The router alone, with the identity `sessionGate` would have resolved. */
function app(options: { user?: RequestUser; managed?: boolean } = {}) {
  const fixture = express();
  fixture.use(express.json());
  fixture.use((req, res, next) => {
    if (options.user) res.locals.user = options.user;
    if (options.managed) markManagedIngress(req);
    next();
  });
  fixture.use('/api/remote-access', createRemoteAccessRouter(current));
  return target.mount(fixture);
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

  it('refuses a caller on another device', async () => {
    const res = await request(app()).post(path).set('Host', 'box.ngrok.app').send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(REMOTE_SETUP_NEEDS_THIS_COMPUTER);
    expect(effect()).not.toHaveBeenCalled();
  });

  it('refuses a request that arrived over managed access, whatever its Host says', async () => {
    const res = await request(app({ managed: true }))
      .post(path)
      .send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(REMOTE_SETUP_NEEDS_THIS_COMPUTER);
    expect(effect()).not.toHaveBeenCalled();
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

  it('refuses an agent, another device and a request over managed access', async () => {
    const agent = await request(app()).post(path).set('x-dorkos-agent', 'agent-token');
    expect(agent.status).toBe(403);
    expect(agent.body.code).toBe('operator_only_config');
    const remote = await request(app()).post(path).set('Host', 'box.ngrok.app');
    expect(remote.status).toBe(403);
    expect(remote.body.code).toBe(REMOTE_SETUP_NEEDS_THIS_COMPUTER);
    const managed = await request(app({ managed: true })).post(path);
    expect(managed.status).toBe(403);
    expect(managed.body.code).toBe(REMOTE_SETUP_NEEDS_THIS_COMPUTER);
    expect(current.coordinator.withdraw).not.toHaveBeenCalled();
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
