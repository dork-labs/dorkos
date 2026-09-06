/**
 * Who the Activity feed says changed a chat connection or a chat route (DOR-1829).
 *
 * All six Activity writes on this router hardcoded `actorType: 'user'` with the
 * label `'You'`, and the router runs no caller check at all — so an agent that
 * added a Telegram connection, or re-pointed somebody's chat route at a different
 * agent, appeared in the operator's own feed as their own action.
 *
 * Uses the REAL {@link BindingStore} in a temp directory rather than a hand-rolled
 * fake, following `relay-bindings-conflict.test.ts`: the actor is the subject, and
 * a store that really persists keeps the route driving realistic. Only the
 * token→agent lookup is faked, because that is the seam under test.
 *
 * @module routes/__tests__/relay-adapters-activity-actor
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** The one token the faked identity service knows about. */
const KNOWN_TOKEN = 'tok_known_agent';

/** A token in the shape agent identity actually mints — bare hex, no prefix. */
const REAL_SHAPED_TOKEN = 'a3f9c1e2b70d48a6915ce4d2f8b03c7e';

const IDENTITY = {
  agentPath: '/Users/dev/agents/researcher',
  displayName: 'Researcher',
  tierCeiling: 'act',
  createdAt: '2026-09-01T00:00:00.000Z',
};

vi.mock('../../services/core/agent-identity/agent-identity-service.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../services/core/agent-identity/agent-identity-service.js')
  >()),
  getAgentIdentityService: () => ({
    resolve: async (token: string) => (token === KNOWN_TOKEN ? IDENTITY : null),
  }),
}));

vi.mock('../../services/relay/relay-sse-events.js', () => ({
  broadcastBindingsChanged: vi.fn(),
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapterRouter } from '../relay-adapters.js';
import { BindingStore } from '../../services/relay/binding-store.js';
import type { AdapterManager } from '../../services/relay/adapter-manager.js';
import { resolveAgentIdentity } from '../../middleware/agent-identity.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** Every actor field an emitted event carried. */
interface EmittedActor {
  actorType: string;
  actorId?: string | null;
  actorLabel: string;
  summary: string;
}

let emitted: EmittedActor[];
let tmpDir: string;
let bindingStore: BindingStore;
/** The binding every binding-route case operates on, recreated per test. */
let bindingId: string;

/** One write on this router, driven with whatever identity headers a test wants. */
type Drive = (headers: Record<string, string>) => Promise<{ status: number }>;

const ROUTES: Array<{ name: string; drive: Drive; expectStatus: number }> = [
  {
    name: 'POST /adapters',
    expectStatus: 201,
    drive: (headers) =>
      request(fixtureServer)
        .post('/api/relay/adapters')
        .set(headers)
        .send({ type: 'telegram', id: 'tg-new', config: {}, enabled: false }),
  },
  {
    name: 'DELETE /adapters/:id',
    expectStatus: 200,
    drive: (headers) => request(fixtureServer).delete('/api/relay/adapters/tg-bot').set(headers),
  },
  {
    name: 'POST /bindings',
    expectStatus: 201,
    drive: (headers) =>
      request(fixtureServer)
        .post('/api/relay/bindings')
        .set(headers)
        .send({ adapterId: 'tg-bot', agentId: 'agent-b', chatId: '999' }),
  },
  {
    name: 'POST /bindings/:id/move',
    expectStatus: 200,
    drive: (headers) =>
      request(fixtureServer)
        .post(`/api/relay/bindings/${bindingId}/move`)
        .set(headers)
        .send({ agentId: 'agent-b' }),
  },
  {
    name: 'PATCH /bindings/:id',
    expectStatus: 200,
    drive: (headers) =>
      request(fixtureServer)
        .patch(`/api/relay/bindings/${bindingId}`)
        .set(headers)
        .send({ label: 'Renamed' }),
  },
  {
    name: 'DELETE /bindings/:id',
    expectStatus: 200,
    drive: (headers) =>
      request(fixtureServer).delete(`/api/relay/bindings/${bindingId}`).set(headers),
  },
];

describe('who the Activity feed says changed a connection or a chat route', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    emitted = [];

    tmpDir = mkdtempSync(join(tmpdir(), 'dorkos-relay-actor-'));
    bindingStore = new BindingStore(tmpDir);
    await bindingStore.init();
    const seeded = await bindingStore.create({
      adapterId: 'tg-bot',
      agentId: 'agent-a',
      chatId: '123',
    });
    bindingId = seeded.id;

    const adapterManager = {
      addAdapter: vi.fn(async () => undefined),
      removeAdapter: vi.fn(async () => undefined),
      resolveAdapterName: vi.fn(() => 'Telegram Bot'),
      getAdapter: vi.fn(() => ({ id: 'tg-bot', config: { id: 'tg-bot', label: 'Telegram Bot' } })),
      getBindingStore: vi.fn(() => bindingStore),
      getBindingRouter: vi.fn(() => undefined),
      getMeshCore: vi.fn(() => ({ getProjectPath: () => '/proj/agent' })),
    } as unknown as AdapterManager;

    const app = express();
    app.use(express.json());
    app.use(resolveAgentIdentity);
    app.locals.activityService = {
      emit: vi.fn(async (event: EmittedActor) => {
        emitted.push(event);
      }),
    };
    app.use('/api/relay', createAdapterRouter(adapterManager));
    fixtureTarget.mount(app);
  });

  afterEach(async () => {
    await bindingStore.shutdown();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe.each(ROUTES)('$name', ({ drive, expectStatus }) => {
    it('records a browser write as the person', async () => {
      const res = await drive({});

      expect(res.status).toBe(expectStatus);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ actorType: 'user', actorLabel: 'You' });
      expect(emitted[0].actorId).toBeUndefined();
    });

    it('records an identified agent as that agent, not as the person', async () => {
      const res = await drive({ 'x-dorkos-agent': KNOWN_TOKEN });

      expect(res.status).toBe(expectStatus);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        actorType: 'agent',
        actorId: IDENTITY.agentPath,
        actorLabel: 'Researcher',
      });
    });

    it('records a token that resolves to nothing as an unidentified caller', async () => {
      const res = await drive({ 'x-dorkos-agent': 'tok_nobody_knows' });

      expect(res.status).toBe(expectStatus);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        actorType: 'system',
        actorLabel: 'Unidentified caller',
      });
      expect(emitted[0].actorId).toBeUndefined();
    });

    it('never writes a real-shaped presented token into the feed', async () => {
      await drive({ 'x-dorkos-agent': REAL_SHAPED_TOKEN });

      const serialized = JSON.stringify(emitted);
      expect(serialized).not.toContain(REAL_SHAPED_TOKEN);
      expect(serialized).not.toContain(REAL_SHAPED_TOKEN.slice(0, 16));
      expect(serialized).not.toContain(REAL_SHAPED_TOKEN.slice(-16));
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ actorType: 'system' });
    });
  });
});
