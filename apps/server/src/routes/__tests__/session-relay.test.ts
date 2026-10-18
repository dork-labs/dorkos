/**
 * `/api/session-relay` (DOR-2946): the status for anyone the gate let in, and
 * five writes only the owner at this computer may make, behind the real
 * `/api` chain with the session gate stubbed open. The pin is a real file in a
 * temporary data folder, so pausing and unlinking are proved on disk.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ login: false, ownerId: 'user_owner' as string | null }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: state.login } : undefined)),
    set: vi.fn(),
    onChange: vi.fn(() => () => undefined),
  },
}));
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => (state.ownerId ? { id: state.ownerId } : null),
  hasAnyUser: () => state.ownerId !== null,
}));
vi.mock('../../services/core/auth/install-owner.js', () => ({
  isInstallOwner: (user: { userId: string } | undefined) => user?.userId === state.ownerId,
}));
// A tunnel is open at `box.ngrok.app`, so the host guard lets a request from
// another device reach the route's own bar.
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

import request from '@dorkos/test-utils/supertest';
import type { SessionRelayPresence } from '@dorkos/shared/session-relay-link';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { recordAudit } from '../../services/audit/audit-trail.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { markIngress, type IngressKind } from '../../services/core/remote/ingress-mark.js';
import {
  clearRelayPin,
  readRelayPin,
  updateRelayPin,
  writeRelayPin,
  type RelayPin,
} from '../../services/core/session-relay/pin-store.js';
import {
  createSessionRelayRoutes,
  SESSION_RELAY_NEEDS_THIS_COMPUTER,
  type SessionRelayRouteDeps,
} from '../session-relay.js';

const target = swappableServer();
let home: string;
let deps: SessionRelayRouteDeps & {
  link: ReturnType<typeof vi.fn>;
  closeRelay: ReturnType<typeof vi.fn>;
  checkPassword: ReturnType<typeof vi.fn>;
};

/** The owner's password, as the fake check knows it. */
const PASSWORD = 'correct horse';
let closed: ReturnType<typeof vi.fn<() => void>>;

const PIN: RelayPin = {
  v: 2,
  computerId: 'computer-1',
  hubOrigin: 'https://me.dorkos.test',
  hubKey: randomBytes(32).toString('base64url'),
  relaySecret: randomBytes(32).toString('base64url'),
  pinnedAt: '2026-10-16T21:00:00.000Z',
  computerName: 'Studio Mac',
  level: 'chat',
  paused: false,
};

const PRESENCE: SessionRelayPresence = {
  active: true,
  since: '2026-10-17T10:00:00.000Z',
  devices: [
    {
      label: 'Safari on iPhone',
      firstSeenAt: '2026-10-17T09:00:00.000Z',
      lastSeenAt: '2026-10-17T10:00:05.000Z',
    },
  ],
};

const OWNER_COOKIE: RequestUser = { userId: 'user_owner', credential: 'cookie' };
const OWNER_KEY: RequestUser = { userId: 'user_owner', credential: 'api-key' };

function makeDeps(overrides: Partial<SessionRelayRouteDeps> = {}) {
  closed = vi.fn<() => void>();
  return {
    isHub: () => false,
    enabled: () => true,
    ownerExists: () => state.ownerId !== null,
    readPin: () => readRelayPin(home),
    updatePin: (patch: Partial<Pick<RelayPin, 'level' | 'paused'>>) => updateRelayPin(patch, home),
    clearPin: () => clearRelayPin(home, closed),
    closeRelay: vi.fn(),
    connected: () => true,
    link: vi.fn(async () => {
      await writeRelayPin(PIN, home);
      return { ok: true as const, pin: PIN };
    }),
    suggestedName: () => 'Studio Mac',
    checkPassword: vi.fn(async (password: string | undefined) =>
      password === PASSWORD
        ? ('ok' as const)
        : password
          ? ('wrong' as const)
          : ('required' as const)
    ),
    presence: () => PRESENCE,
    devices: () => PRESENCE.devices,
    ...overrides,
  } as typeof deps;
}

/** The routes behind the chain, with the identity and listener the gate would have seen. */
function app(options: { user?: RequestUser; ingress?: IngressKind } = {}) {
  return target.mount(
    honoGroupListener(
      { path: '/api/session-relay', routes: createSessionRelayRoutes(deps) },
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

const LINK_CODE = '7K3M-Q9TD-X2HV-8RNB@me.dorkos.test';
const CODE = { linkCode: LINK_CODE, password: PASSWORD };

/** Every write, as `[label, send]`. */
const WRITES: Array<
  [string, (agent: ReturnType<typeof request>) => ReturnType<ReturnType<typeof request>['get']>]
> = [
  ['POST /link', (a) => a.post('/api/session-relay/link').send(CODE)],
  [
    'PATCH /level',
    (a) => a.patch('/api/session-relay/level').send({ level: 'full', password: PASSWORD }),
  ],
  ['POST /pause', (a) => a.post('/api/session-relay/pause')],
  ['POST /resume', (a) => a.post('/api/session-relay/resume').send({ password: PASSWORD })],
  ['DELETE /link', (a) => a.delete('/api/session-relay/link')],
  ['POST /presence/end', (a) => a.post('/api/session-relay/presence/end')],
];

beforeEach(() => {
  vi.clearAllMocks();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-session-relay-route-'));
  deps = makeDeps();
});
afterEach(() => {
  state.login = false;
  state.ownerId = 'user_owner';
  fs.rmSync(home, { recursive: true, force: true });
});

describe('GET /api/session-relay/status', () => {
  it('answers not linked, with a name to offer', async () => {
    const res = await request(app()).get('/api/session-relay/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      linked: false,
      hubOrigin: null,
      computerName: null,
      level: 'chat',
      paused: false,
      connected: false,
      pinnedAt: null,
      suggestedName: 'Studio Mac',
    });
  });

  it('answers linked, and never carries the secret', async () => {
    await writeRelayPin(PIN, home);
    const res = await request(app()).get('/api/session-relay/status');
    expect(res.body).toMatchObject({
      linked: true,
      hubOrigin: PIN.hubOrigin,
      computerName: 'Studio Mac',
      connected: true,
    });
    expect(JSON.stringify(res.body)).not.toContain(PIN.relaySecret);
  });

  it('answers a person signed in on another device', async () => {
    const res = await request(app({ user: OWNER_COOKIE, ingress: 'own-tunnel' })).get(
      '/api/session-relay/status'
    );
    expect(res.status).toBe(200);
  });
});

describe('who is using this computer from the web', () => {
  it('answers the presence and the devices seen, to another signed-in device too', async () => {
    const presence = await request(app({ user: OWNER_COOKIE, ingress: 'own-tunnel' })).get(
      '/api/session-relay/presence'
    );
    expect(presence.status).toBe(200);
    expect(presence.body).toEqual(PRESENCE);
    const devices = await request(app()).get('/api/session-relay/devices');
    expect(devices.body).toEqual({ devices: PRESENCE.devices });
  });

  it('refuses an agent: the browsers using this computer are the owner’s to see', async () => {
    for (const path of ['/api/session-relay/presence', '/api/session-relay/devices']) {
      const res = await request(app()).get(path).set('x-dorkos-agent', 'agent-token');
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('Safari on iPhone');
    }
  });

  it('is the /api 404 with the experiment off, or on a hub', async () => {
    deps = makeDeps({ enabled: () => false });
    expect((await request(app()).get('/api/session-relay/presence')).status).toBe(404);
    deps = makeDeps({ isHub: () => true });
    expect((await request(app()).get('/api/session-relay/devices')).status).toBe(404);
  });

  it('ends a remote session now: closes the relay, pauses the link, and records it', async () => {
    await writeRelayPin(PIN, home);
    deps = makeDeps({ presence: () => ({ active: false, devices: [] }) });
    const res = await request(app()).post('/api/session-relay/presence/end');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ active: false, devices: [] });
    expect(deps.closeRelay).toHaveBeenCalledTimes(1);
    expect(readRelayPin(home)?.paused).toBe(true);
    // Lowering access: no password asked.
    expect(deps.checkPassword).not.toHaveBeenCalled();
    expect(vi.mocked(recordAudit).mock.calls.map(([input]) => input.action)).toContain(
      'session-relay.presence.end'
    );
  });

  it('says so when this computer is not linked', async () => {
    const res = await request(app()).post('/api/session-relay/presence/end');
    expect(res.status).toBe(409);
    expect(deps.closeRelay).not.toHaveBeenCalled();
  });
});

describe('the whole group is off', () => {
  it.each([
    ['with the experiment off', { enabled: () => false }],
    ['on a hub', { isHub: () => true }],
  ])('%s: every route is the /api 404', async (_label, overrides) => {
    deps = makeDeps(overrides);
    expect((await request(app()).get('/api/session-relay/status')).status).toBe(404);
    for (const [, send] of WRITES) {
      expect((await send(request(app()))).status).toBe(404);
    }
    expect(deps.link).not.toHaveBeenCalled();
  });
});

describe.each(WRITES)('%s, the owner at this computer only', (_label, send) => {
  beforeEach(async () => {
    await writeRelayPin(PIN, home);
  });

  function unchanged(): void {
    expect(readRelayPin(home)).toEqual(PIN);
    expect(deps.link).not.toHaveBeenCalled();
    // The chain's own fallback may record the refused request; the route records nothing.
    const actions = vi.mocked(recordAudit).mock.calls.map(([input]) => input.action);
    expect(actions.filter((action) => action.startsWith('session-relay.'))).toEqual([]);
  }

  it.each(['relay', 'own-tunnel', 'managed', 'wifi'] as const)(
    'refuses a request through %s, even with the owner’s session',
    async (ingress) => {
      const res = await send(request(app({ user: OWNER_COOKIE, ingress })));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe(SESSION_RELAY_NEEDS_THIS_COMPUTER);
      expect(res.body.error).toBe('Change this on the computer DorkOS runs on.');
      unchanged();
    }
  );

  it('refuses another device that names this computer', async () => {
    const res = await send(request(app({ user: OWNER_COOKIE }))).set('Host', 'box.ngrok.app');
    expect(res.status).toBe(403);
    unchanged();
  });

  it('refuses an agent', async () => {
    const res = await send(request(app())).set('x-dorkos-agent', 'agent-token');
    expect(res.status).toBe(403);
    unchanged();
  });

  it('refuses an API key, proved or not', async () => {
    state.login = true;
    expect((await send(request(app({ user: OWNER_KEY })))).status).toBe(403);
    state.login = false;
    expect((await send(request(app())).set('Authorization', 'Bearer dork_key')).status).toBe(403);
    unchanged();
  });
});

describe('POST /api/session-relay/link', () => {
  it('links for the owner at this computer, and records it without the code', async () => {
    const res = await request(app()).post('/api/session-relay/link').send(CODE);
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(true);
    expect(deps.link).toHaveBeenCalledWith({ linkCode: LINK_CODE, computerName: 'Studio Mac' });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session-relay.link', outcome: 'ok' })
    );
    const recorded = JSON.stringify(vi.mocked(recordAudit).mock.calls);
    expect(recorded).not.toContain('7K3M');
    expect(recorded).not.toContain(PASSWORD);
    expect(recorded).not.toContain(PIN.relaySecret);
  });

  it('refuses with no owner account, before reaching the hub', async () => {
    state.ownerId = null;
    const res = await request(app()).post('/api/session-relay/link').send(CODE);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AUTH_REQUIRED_FOR_EXPOSURE');
    expect(deps.link).not.toHaveBeenCalled();
  });

  it.each([
    ['different-account', 409],
    ['hub-unreachable', 502],
    ['already-linked', 409],
  ] as const)('answers a %s refusal with its own sentence', async (reason, status) => {
    deps.link.mockResolvedValueOnce({ ok: false, reason });
    const res = await request(app()).post('/api/session-relay/link').send(CODE);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(reason);
    expect(typeof res.body.error).toBe('string');
    expect(readRelayPin(home)).toBeNull();
  });

  it('refuses a body that is not a code', async () => {
    const res = await request(app()).post('/api/session-relay/link').send({ linkCode: 42 });
    expect(res.status).toBe(400);
    expect(deps.link).not.toHaveBeenCalled();
  });
});

describe('the owner’s switches on a linked computer', () => {
  beforeEach(async () => {
    await writeRelayPin(PIN, home);
  });

  it('stores Full control, which only this computer can set', async () => {
    const res = await request(app())
      .patch('/api/session-relay/level')
      .send({ level: 'full', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.level).toBe('full');
    expect(readRelayPin(home)?.level).toBe('full');
  });

  it('pauses, closing the live relay, and resumes', async () => {
    const paused = await request(app()).post('/api/session-relay/pause');
    expect(paused.body).toMatchObject({ paused: true, connected: false });
    expect(deps.closeRelay).toHaveBeenCalledTimes(1);
    expect(readRelayPin(home)?.paused).toBe(true);
    const resumed = await request(app())
      .post('/api/session-relay/resume')
      .send({ password: PASSWORD });
    expect(resumed.body.paused).toBe(false);
    expect(readRelayPin(home)?.paused).toBe(false);
  });

  it('unlinks with the network off: the pin is gone and the relay closed', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const res = await request(app()).delete('/api/session-relay/link');
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(false);
    expect(readRelayPin(home)).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session-relay.unlink', operation: 'remove' })
    );
  });

  it('says so when changing a computer that is not linked', async () => {
    clearRelayPin(home);
    const res = await request(app()).post('/api/session-relay/pause');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_LINKED');
  });
});

describe('the owner’s password, for every change that opens access wider', () => {
  beforeEach(async () => {
    await writeRelayPin(PIN, home);
  });

  // The DOR-505 shape: an agent's shell on this computer, calling loopback with
  // no headers at all, clears the person bar while no password is asked. The
  // password is what it cannot supply.
  it.each([
    [
      'POST /link',
      (password?: string) =>
        request(app())
          .post('/api/session-relay/link')
          .send(
            password === undefined ? { linkCode: LINK_CODE } : { linkCode: LINK_CODE, password }
          ),
    ],
    [
      'PATCH /level to full',
      (password?: string) =>
        request(app())
          .patch('/api/session-relay/level')
          .send(password === undefined ? { level: 'full' } : { level: 'full', password }),
    ],
    [
      'POST /resume',
      (password?: string) =>
        request(app())
          .post('/api/session-relay/resume')
          .send(password === undefined ? {} : { password }),
    ],
  ])('%s from a bare loopback caller needs the right password', async (label, send) => {
    if (label === 'POST /link') clearRelayPin(home);
    else await updateRelayPin({ paused: true }, home);
    const before = readRelayPin(home);

    const missing = await send();
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe('SESSION_RELAY_PASSWORD');
    expect(missing.body.reason).toBe('required');
    const wrong = await send('guess');
    expect(wrong.status).toBe(403);
    expect(wrong.body.reason).toBe('wrong');
    expect(readRelayPin(home)).toEqual(before);
    expect(deps.link).not.toHaveBeenCalled();

    expect((await send(PASSWORD)).status).toBe(200);
  });

  it('asks for it even with the owner’s browser session', async () => {
    state.login = true;
    const res = await request(app({ user: OWNER_COOKIE }))
      .post('/api/session-relay/link')
      .send({ linkCode: LINK_CODE });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SESSION_RELAY_PASSWORD');
  });

  it('answers the throttle and a missing owner password with their own sentences', async () => {
    clearRelayPin(home);
    deps.checkPassword.mockResolvedValueOnce('too-many-attempts');
    const throttled = await request(app()).post('/api/session-relay/link').send(CODE);
    expect(throttled.status).toBe(429);
    deps.checkPassword.mockResolvedValueOnce('no-password');
    const none = await request(app()).post('/api/session-relay/link').send(CODE);
    expect(none.status).toBe(409);
    expect(none.body.error).toBe('Set a password for this computer’s owner first.');
    expect(deps.link).not.toHaveBeenCalled();
  });

  it('needs none to lower the level, pause or unlink', async () => {
    await updateRelayPin({ level: 'full' }, home);
    expect(
      (await request(app()).patch('/api/session-relay/level').send({ level: 'chat' })).status
    ).toBe(200);
    expect((await request(app()).post('/api/session-relay/pause')).status).toBe(200);
    expect((await request(app()).delete('/api/session-relay/link')).status).toBe(200);
    expect(deps.checkPassword).not.toHaveBeenCalled();
    expect(readRelayPin(home)).toBeNull();
  });
});

describe('changes to the pin run one at a time', () => {
  it('a resume racing an unlink never brings the pin back', async () => {
    await writeRelayPin({ ...PIN, paused: true }, home);
    const [unlinked, resumed] = await Promise.all([
      request(app()).delete('/api/session-relay/link'),
      request(app()).post('/api/session-relay/resume').send({ password: PASSWORD }),
    ]);
    expect(unlinked.status).toBe(200);
    expect([200, 409]).toContain(resumed.status);
    expect(readRelayPin(home)).toBeNull();
  });

  it('two links at once: one links, the other finds it already linked', async () => {
    deps = makeDeps({
      link: vi.fn(async () => {
        if (readRelayPin(home)) return { ok: false as const, reason: 'already-linked' as const };
        await new Promise((resolve) => setTimeout(resolve, 20));
        await writeRelayPin(PIN, home);
        return { ok: true as const, pin: PIN };
      }),
    });
    const results = await Promise.all([
      request(app()).post('/api/session-relay/link').send(CODE),
      request(app()).post('/api/session-relay/link').send(CODE),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
  });
});
