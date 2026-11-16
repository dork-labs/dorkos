/**
 * Only a person sets the monthly spend limit and an app's price (DOR-4204 PR 2,
 * spec §2.2 and 1.1). Anything that lets more money leave without a card waits
 * for "Confirm it's you"; anything that narrows goes straight through; an
 * agent is refused either way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'auth' ? { enabled: false } : undefined)),
    set: vi.fn(),
    onChange: vi.fn(() => () => undefined),
  },
}));
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/core/auth/install-owner.js', () => ({
  isInstallOwner: (user?: { userId: string }) => user?.userId === 'owner',
}));
vi.mock('../../services/core/auth/index.js', () => ({
  readOwnerAccount: () => ({ id: 'owner' }),
  hasAnyUser: () => true,
}));
vi.mock('../../services/audit/audit-trail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/audit/audit-trail.js')>()),
  recordAudit: vi.fn(),
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { StepUpRequiredBodySchema } from '@dorkos/shared/step-up';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { AGENT_IDENTITY_HEADER } from '../../middleware/agent-identity.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { SpendingStore } from '../../services/connectors/spending/spending-store.js';
import { createConnectorSpendingRoutes } from '../connector-spending.js';
import { createStepUpRoutes, type StepUpRouteDeps } from '../step-up.js';

const target = swappableServer();
const OWN_ORIGIN = 'http://localhost:4242';
const PASSWORD = 'correct horse battery';
const OWNER: RequestUser = { userId: 'owner', credential: 'cookie', sessionId: 'sess-a' };

const stepUpDeps: StepUpRouteDeps = {
  ownerId: () => 'owner',
  checkPassword: async (password) =>
    !password ? 'required' : password === PASSWORD ? 'ok' : 'wrong',
  minPasswordLength: async () => 8,
  setOwnerPassword: async () => undefined,
  trustedOrigins: () => [OWN_ORIGIN],
};

let spending: SpendingStore;
const lines: string[] = [];

function app(user: RequestUser | null = OWNER) {
  return target.mount(
    honoGroupListener(
      [
        {
          path: '/api/connectors/spending',
          routes: createConnectorSpendingRoutes({
            spending,
            activity: { emit: async (event) => void lines.push(event.summary) },
          }),
        },
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

const putLimit = (limit: string | null) =>
  request(app()).put('/api/connectors/spending/limit').set('Origin', OWN_ORIGIN).send({ limit });
const putPrice = (price: string | null) =>
  request(app())
    .put('/api/connectors/spending/prices/tavily')
    .set('Origin', OWN_ORIGIN)
    .send({ price });
const confirm = (id: string) =>
  request(app())
    .post(`/api/step-up/${id}/password`)
    .set('Origin', OWN_ORIGIN)
    .send({ password: PASSWORD });

beforeEach(() => {
  resetHeldStepUpsForTests();
  spending = new SpendingStore(createTestDb());
  lines.length = 0;
});

afterEach(() => vi.clearAllMocks());

describe('the monthly limit', () => {
  it('holds a first limit for "Confirm it\'s you", and writes it only then (spec §13 #6)', async () => {
    const held = await putLimit('40000000');
    expect(held.status).toBe(428);
    expect(spending.limit()).toBeNull();
    const done = await confirm(StepUpRequiredBodySchema.parse(held.body).heldActionId);
    expect(done.body).toMatchObject({ ok: true });
    expect(spending.limit()).toBe(40_000_000);
  });

  it('holds a raise', async () => {
    spending.setLimit(40_000_000);
    expect((await putLimit('60000000')).status).toBe(428);
    expect(spending.limit()).toBe(40_000_000);
  });

  it('lowers and clears with no hold', async () => {
    spending.setLimit(40_000_000);
    expect((await putLimit('20000000')).status).toBe(200);
    expect(spending.limit()).toBe(20_000_000);
    expect((await putLimit(null)).status).toBe(200);
    expect(spending.limit()).toBeNull();
  });

  it('refuses $0, less than a cent, and more than the maximum', async () => {
    for (const limit of ['0', '9999', '10000000001']) {
      expect((await putLimit(limit)).status).toBe(400);
    }
    expect(spending.limit()).toBeNull();
  });
});

describe("an app's price per run", () => {
  it('holds a first price and a lower price, which let more runs through (spec §13 #7)', async () => {
    expect((await putPrice('300000')).status).toBe(428);
    spending.setPrice('tavily', 300_000);
    expect((await putPrice('100000')).status).toBe(428);
    expect(spending.price('tavily')).toBe(300_000);
  });

  it('raises and clears a price with no hold', async () => {
    spending.setPrice('tavily', 300_000);
    expect((await putPrice('500000')).status).toBe(200);
    expect(spending.price('tavily')).toBe(500_000);
    expect((await putPrice(null)).status).toBe(200);
    expect(spending.price('tavily')).toBeNull();
  });
});

describe('only a person (spec 1.1)', () => {
  it('refuses an agent setting the limit or a price, however it asks', async () => {
    const asAgent = (path: string, body: object) =>
      request(app())
        .put(path)
        .set('Origin', OWN_ORIGIN)
        .set(AGENT_IDENTITY_HEADER, 'agent-token')
        .send(body);
    spending.setLimit(40_000_000);
    for (const [path, body] of [
      ['/api/connectors/spending/limit', { limit: '20000000' }],
      ['/api/connectors/spending/limit', { limit: null }],
      ['/api/connectors/spending/prices/tavily', { price: '500000' }],
    ] as const) {
      expect((await asAgent(path, body)).status).toBe(403);
    }
    expect(spending.limit()).toBe(40_000_000);
    expect(spending.price('tavily')).toBeNull();
  });
});

describe('the Activity record (spec §9)', () => {
  it('says each change to the limit and to a price', async () => {
    spending.setLimit(40_000_000);
    await putLimit('20000000');
    await putLimit(null);
    spending.setPrice('tavily', 300_000);
    await putPrice('500000');
    expect(lines).toEqual([
      'Lowered the monthly limit to $20.00',
      'Set spending to ask every time',
      "Set tavily's price to about $0.50 a run",
    ]);
  });

  it('says a raise once it is confirmed', async () => {
    const held = await putLimit('60000000');
    await confirm(StepUpRequiredBodySchema.parse(held.body).heldActionId);
    expect(lines).toEqual(['Raised the monthly limit to $60.00 · confirmed with password']);
  });

  it('says nothing when the limit or a price is saved unchanged', async () => {
    spending.setLimit(40_000_000);
    spending.setPrice('tavily', 300_000);
    expect((await putLimit('40000000')).status).toBe(200);
    expect((await putLimit(null)).status).toBe(200);
    expect((await putLimit(null)).status).toBe(200);
    expect((await putPrice('300000')).status).toBe(200);
    expect(lines).toEqual(['Set spending to ask every time']);
  });

  it('words a confirmed change against the limit at the moment it is confirmed', async () => {
    spending.setLimit(40_000_000);
    const held = await putLimit('60000000');
    spending.setLimit(80_000_000);
    await confirm(StepUpRequiredBodySchema.parse(held.body).heldActionId);
    expect(spending.limit()).toBe(60_000_000);
    expect(lines).toEqual(['Lowered the monthly limit to $60.00 · confirmed with password']);
  });
});
