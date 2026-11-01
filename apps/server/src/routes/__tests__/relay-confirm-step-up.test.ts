/**
 * "Confirm this setting" on a paused connection asks "Confirm it's you" first
 * (DOR-3467, DOR-3234; designer spec on the DOR-3467 thread): behind the real
 * `/api` chain with the session gate stubbed open, the confirm route holds its
 * write, and only the owner's password through the step-up runs it. A wrong,
 * cancelled or expired step-up leaves the connection paused; Undo asks for
 * nothing; an agent still gets the 403 it always did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ownerId: 'user_owner' as string | null,
  /** Login on and the caller no longer the owner, as `refuseUnlessAccountOwner` would say. */
  notTheOwner: false,
}));
vi.mock('../../lib/caller-authority.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/caller-authority.js')>();
  return {
    ...actual,
    refuseUnlessAccountOwner: (facts: Parameters<typeof actual.refuseUnlessAccountOwner>[0]) =>
      state.notTheOwner ? 'not-the-owner' : actual.refuseUnlessAccountOwner(facts),
  };
});
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
vi.mock('../../services/core/auth/install-owner.js', () => ({
  isInstallOwner: (user: { userId: string } | undefined) => user?.userId === state.ownerId,
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
import { STEP_UP_TTL_MS, StepUpRequiredBodySchema } from '@dorkos/shared/step-up';

import type { ApiEnv } from '../../http/api-chain.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import { AdapterError, type AdapterManager } from '../../services/relay/adapter-manager.js';
import { registerConfirmReferencesRoute } from '../relay-adapter-http.js';
import { createStepUpRoutes, type StepUpRouteDeps } from '../step-up.js';

const target = swappableServer();
const OWN_ORIGIN = 'http://localhost:4242';
const PASSWORD = 'correct horse battery';
const OWNER: RequestUser = { userId: 'user_owner', credential: 'cookie', sessionId: 'sess-a' };

/** One paused connection, and the record Confirm writes. */
let connection: { paused: boolean; fingerprint: string };
let confirmReferences: ReturnType<typeof vi.fn>;

function fakeAdapterManager(): AdapterManager {
  confirmReferences = vi.fn(async (_id: string, fingerprint: string | null, undo: boolean) => {
    if (undo) {
      connection.paused = true;
      return;
    }
    if (fingerprint !== connection.fingerprint) {
      throw new AdapterError('This connection changed since you saw it.', 'CONFIRMATION_STALE');
    }
    connection.paused = false;
  });
  return {
    confirmReferences,
    getCatalog: () => [
      {
        manifest: { displayName: 'Webhook' },
        instances: [
          {
            id: 'wh',
            label: 'Deploy hooks',
            ...(connection.paused
              ? {
                  confirmation: {
                    references: [{ field: 'headers.Authorization', ref: 'env:DEPLOY_TOKEN' }],
                    host: 'hooks.example.dev',
                    fingerprint: connection.fingerprint,
                    notSent: 3,
                  },
                }
              : {}),
          },
        ],
      },
    ],
  } as unknown as AdapterManager;
}

const stepUpDeps: StepUpRouteDeps = {
  ownerId: () => state.ownerId,
  checkPassword: async (password) =>
    !password ? 'required' : password === PASSWORD ? 'ok' : 'wrong',
  minPasswordLength: async () => 8,
  setOwnerPassword: async () => undefined,
  trustedOrigins: () => [OWN_ORIGIN],
};

/** The one fake manager for a test, so a held commit and the checks share it. */
let adapterManager: AdapterManager;

function app(user: RequestUser | null = OWNER) {
  const relay = new Hono<ApiEnv>();
  registerConfirmReferencesRoute(relay, adapterManager, () => state.ownerId !== null);
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

async function pressConfirm(headers: Record<string, string> = {}) {
  return request(app())
    .post('/api/relay/adapters/wh/confirm-references')
    .set('Origin', OWN_ORIGIN)
    .set(headers)
    .send({ fingerprint: connection.fingerprint });
}

async function heldId(): Promise<string> {
  const res = await pressConfirm();
  expect(res.status).toBe(428);
  return StepUpRequiredBodySchema.parse(res.body).heldActionId;
}

function confirmWith(id: string, password: string) {
  return request(app())
    .post(`/api/step-up/${id}/password`)
    .set('Origin', OWN_ORIGIN)
    .send({ password });
}

beforeEach(() => {
  resetHeldStepUpsForTests();
  connection = { paused: true, fingerprint: 'fp-1' };
  adapterManager = fakeAdapterManager();
});
afterEach(() => {
  vi.useRealTimers();
  state.ownerId = 'user_owner';
  state.notTheOwner = false;
});

describe('Confirm this setting, with "Confirm it’s you"', () => {
  it('holds the confirm and writes nothing until the step-up passes', async () => {
    await heldId();
    expect(confirmReferences).not.toHaveBeenCalled();
    expect(connection.paused).toBe(true);
  });

  it('shows the server’s own line about what it lets the connection do', async () => {
    const id = await heldId();
    const view = await request(app()).get(`/api/step-up/${id}`);
    expect(view.body.reason).toBe(
      'Lets Deploy hooks send DEPLOY_TOKEN to hooks.example.dev again.'
    );
  });

  it('right password: the record is written and it sends again', async () => {
    const id = await heldId();
    const res = await confirmWith(id, PASSWORD);
    expect(res.body).toEqual({ ok: true, status: 200, result: { ok: true } });
    expect(confirmReferences).toHaveBeenCalledExactlyOnceWith('wh', 'fp-1', false);
    expect(connection.paused).toBe(false);
  });

  it('wrong password: no record, and the row stays paused', async () => {
    const id = await heldId();
    expect((await confirmWith(id, 'nope')).body.code).toBe('wrong-password');
    expect(confirmReferences).not.toHaveBeenCalled();
    expect(connection.paused).toBe(true);
  });

  it('cancel: nothing held, and nothing written', async () => {
    const id = await heldId();
    await request(app()).delete(`/api/step-up/${id}`).set('Origin', OWN_ORIGIN);
    expect((await confirmWith(id, PASSWORD)).body.code).toBe('expired');
    expect(confirmReferences).not.toHaveBeenCalled();
    expect(connection.paused).toBe(true);
  });

  it('expired: nothing written; pressing Confirm again holds it afresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await heldId();
    vi.setSystemTime(Date.now() + STEP_UP_TTL_MS);
    expect((await confirmWith(first, PASSWORD)).body.code).toBe('expired');
    expect(connection.paused).toBe(true);
    const second = await heldId();
    expect(second).not.toBe(first);
    expect((await confirmWith(second, PASSWORD)).body.ok).toBe(true);
    expect(connection.paused).toBe(false);
  });

  it('a connection that changed while the sheet was up: the confirm is refused, nothing written', async () => {
    const id = await heldId();
    connection.fingerprint = 'fp-2';
    const res = await confirmWith(id, PASSWORD);
    expect(res.body).toMatchObject({
      ok: true,
      status: 409,
      result: { code: 'CONFIRMATION_STALE' },
    });
    expect(connection.paused).toBe(true);
  });

  it('re-checks the owner when it commits: an owner replaced while the sheet was up writes nothing', async () => {
    const id = await heldId();
    // Another account now owns this install; the session that held it does not.
    state.notTheOwner = true;
    const res = await confirmWith(id, PASSWORD);
    expect(res.body).toMatchObject({ ok: true, status: 403, result: { code: 'owner_only' } });
    expect(confirmReferences).not.toHaveBeenCalled();
    expect(connection.paused).toBe(true);
  });

  it('Undo asks for nothing, and pauses it again', async () => {
    connection.paused = false;
    const res = await request(app())
      .delete('/api/relay/adapters/wh/confirm-references')
      .set('Origin', OWN_ORIGIN);
    expect(res.status).toBe(200);
    expect(connection.paused).toBe(true);
  });

  // Security's ruling on DOR-3467: with no owner there is no password to ask
  // for, so the person at this computer confirms with no sheet; a program never does.
  describe('with no owner yet', () => {
    beforeEach(() => {
      state.ownerId = null;
    });

    it('runs at once for the person at this computer, with no sheet', async () => {
      const res = await request(app(null))
        .post('/api/relay/adapters/wh/confirm-references')
        .set('Origin', OWN_ORIGIN)
        .send({ fingerprint: connection.fingerprint });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(connection.paused).toBe(false);
    });

    it.each([
      ['an agent', { 'X-DorkOS-Agent': 'agent-1' }],
      ['an approval token', { 'X-DorkOS-Approval': 'token-1' }],
      ['a bearer', { Authorization: 'Bearer dork_key' }],
      ['an API key header', { 'X-Api-Key': 'not-a-real-key' }],
      ['a proxy credential', { 'Proxy-Authorization': 'Basic Zm9vOmJhcg==' }],
    ])('refuses %s, and writes nothing', async (_label, headers) => {
      const res = await request(app(null))
        .post('/api/relay/adapters/wh/confirm-references')
        .set('Origin', OWN_ORIGIN)
        .set(headers)
        .send({ fingerprint: connection.fingerprint });
      expect(res.status).toBe(403);
      expect(confirmReferences).not.toHaveBeenCalled();
      expect(connection.paused).toBe(true);
    });

    it('asks again with the sheet once an owner exists: no skip is left behind', async () => {
      state.ownerId = 'user_owner';
      expect((await pressConfirm()).status).toBe(428);
      expect(confirmReferences).not.toHaveBeenCalled();
    });
  });

  it('an agent turn gets the 403 it always did, and no step-up is held', async () => {
    const res = await pressConfirm({ 'X-DorkOS-Agent': 'agent-1' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('person_only');
    expect(confirmReferences).not.toHaveBeenCalled();
  });
});
