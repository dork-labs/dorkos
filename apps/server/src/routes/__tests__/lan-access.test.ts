/**
 * `/api/lan-access` (DOR-2930): who may turn Wi-Fi access on, the refusal that
 * walks a person into owner setup, and that turning it off stays open to all.
 *
 * Served behind the real `/api` chain with the session gate stubbed open, the
 * way `remote-access.test.ts` tests the same bars.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(), set: vi.fn(), onChange: vi.fn(() => () => undefined) },
}));

// A tunnel is open at `box.ngrok.app`, so the host guard trusts that name and a
// request from another device reaches the route's own bar.
vi.mock('../../lib/trusted-origins.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/trusted-origins.js')>()),
  getTunnelHosts: () => ['box.ngrok.app'],
}));

vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createLanAccessStatus } from '@dorkos/test-utils';
import type { LanAccessStatus } from '@dorkos/shared/types';
import { configManager } from '../../services/core/config-manager.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import {
  createLanAccessRoutes,
  LAN_ACCESS_NEEDS_THIS_COMPUTER,
  LAN_ACCESS_SET_BY_ENVIRONMENT,
} from '../lan-access.js';

const target = swappableServer();
const mockConfigGet = vi.mocked(configManager.get) as unknown as ReturnType<typeof vi.fn>;

/** Fakes for the controller and the setting, with the status they would answer. */
function deps(status: Partial<LanAccessStatus> = {}) {
  const answer = createLanAccessStatus(status);
  return {
    lanAccess: {
      status: vi.fn(() => answer),
      reconcile: vi.fn(async () => answer),
    },
    writeSetting: vi.fn(),
    canExpose: vi.fn(() => true),
  };
}

let current: ReturnType<typeof deps>;

function app() {
  return target.mount(
    honoGroupListener({ path: '/api/lan-access', routes: createLanAccessRoutes(current) })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  current = deps();
  mockConfigGet.mockImplementation((key: string) =>
    key === 'auth' ? { enabled: false } : undefined
  );
});

describe('GET /api/lan-access', () => {
  it('answers the status', async () => {
    const res = await request(app()).get('/api/lan-access');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(createLanAccessStatus());
  });
});

describe('POST /api/lan-access { enabled: true }', () => {
  it('writes the setting and answers the status once applied', async () => {
    const res = await request(app()).post('/api/lan-access').send({ enabled: true });
    expect(res.status).toBe(200);
    expect(current.writeSetting).toHaveBeenCalledWith(true);
    expect(current.lanAccess.reconcile).toHaveBeenCalled();
  });

  it('asks for a login first, with the code that opens owner setup', async () => {
    current.canExpose.mockReturnValue(false);
    const res = await request(app()).post('/api/lan-access').send({ enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AUTH_REQUIRED_FOR_EXPOSURE');
    expect(current.writeSetting).not.toHaveBeenCalled();
  });

  it('refuses while DORKOS_HOST decides where DorkOS listens', async () => {
    current = deps({ envHost: '0.0.0.0' });
    const res = await request(app()).post('/api/lan-access').send({ enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(LAN_ACCESS_SET_BY_ENVIRONMENT);
    expect(current.writeSetting).not.toHaveBeenCalled();
  });

  it('refuses a caller that names itself an agent', async () => {
    const res = await request(app())
      .post('/api/lan-access')
      .set('x-dorkos-agent', 'agent-token')
      .send({ enabled: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('operator_only_config');
    expect(current.writeSetting).not.toHaveBeenCalled();
  });

  it('refuses a device that is already reaching in from elsewhere', async () => {
    const res = await request(app())
      .post('/api/lan-access')
      .set('Host', 'box.ngrok.app')
      .send({ enabled: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(LAN_ACCESS_NEEDS_THIS_COMPUTER);
    expect(current.writeSetting).not.toHaveBeenCalled();
  });

  it('refuses a body that is not a yes or a no', async () => {
    const res = await request(app()).post('/api/lan-access').send({ enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(current.writeSetting).not.toHaveBeenCalled();
  });
});

describe('POST /api/lan-access { enabled: false }', () => {
  it('turns it off for anyone, even from another device, with no login', async () => {
    current.canExpose.mockReturnValue(false);
    const res = await request(app())
      .post('/api/lan-access')
      .set('Host', 'box.ngrok.app')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(current.writeSetting).toHaveBeenCalledWith(false);
  });
});
