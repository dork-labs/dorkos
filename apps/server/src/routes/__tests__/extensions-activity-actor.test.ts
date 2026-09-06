/**
 * Who the Activity feed says changed an extension (DOR-1801).
 *
 * The secrets and settings routes are not behind the person bar — an agent may
 * legitimately store an API key for an extension it drives — and every one of
 * them recorded `actorType: 'user'` with the label `'You'` no matter who called.
 * So the operator's own feed reported a machine's write as something they did
 * themselves, which is worse than silence because a feed is believed.
 *
 * Driven through the real router and the REAL identity middleware, with only the
 * token→agent lookup faked, because the subject is a seam: what the middleware
 * leaves on `res.locals`, and what the route then writes into the feed.
 *
 * DOR-1829 added the other half of each pair: the two DELETE routes recorded
 * nothing at all, so removing a secret — at least as worth knowing as setting one
 * — left no trace. They emit only when something was actually removed, which is
 * asserted here too: `delete` is idempotent, and a feed line about a secret that
 * was never set is a lie about the verb rather than the actor.
 *
 * The shape guard that used to live at the bottom of this file moved to
 * `route-activity-actor.test.ts`, which enumerates the WHOLE `routes/` directory
 * and so covers `extensions*.ts` as a strict superset.
 *
 * @module routes/__tests__/extensions-activity-actor
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The one token the faked identity service knows about. */
const KNOWN_TOKEN = 'tok_known_agent';

const IDENTITY = {
  agentPath: '/Users/dev/agents/researcher',
  displayName: 'Researcher',
  tierCeiling: 'act',
  createdAt: '2026-09-01T00:00:00.000Z',
};

vi.mock('../../services/core/agent-identity/agent-identity-service.js', () => ({
  agentTokenDigestPrefix: () => 'digest',
  getAgentIdentityService: () => ({
    resolve: async (token: string) => (token === KNOWN_TOKEN ? IDENTITY : null),
  }),
}));

/** In-memory secret store keyed by extensionId -> key -> value. */
const secretStores = new Map<string, Map<string, string>>();

vi.mock('@dorkos/shared/extension-secrets', () => ({
  ExtensionSecretStore: vi.fn().mockImplementation(function (extensionId: string) {
    if (!secretStores.has(extensionId)) secretStores.set(extensionId, new Map());
    const store = secretStores.get(extensionId)!;
    return {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => void store.set(key, value)),
      delete: vi.fn(async (key: string) => void store.delete(key)),
      has: vi.fn(async (key: string) => store.has(key)),
    };
  }),
}));

/** In-memory settings store keyed by extensionId -> key -> value. */
const settingStores = new Map<string, Map<string, string | number | boolean>>();

vi.mock('@dorkos/shared/extension-settings', () => ({
  ExtensionSettingsStore: vi.fn().mockImplementation(function (_dorkHome: string, id: string) {
    if (!settingStores.has(id)) settingStores.set(id, new Map());
    const store = settingStores.get(id)!;
    return {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(
        async (key: string, value: string | number | boolean) => void store.set(key, value)
      ),
      delete: vi.fn(async (key: string) => void store.delete(key)),
      getAll: vi.fn(async () => Object.fromEntries(store)),
    };
  }),
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import express from 'express';
import type { ExtensionRecord, ExtensionRecordPublic } from '@dorkos/extension-api';
import { createExtensionsRouter } from '../extensions.js';
import { resolveAgentIdentity } from '../../middleware/agent-identity.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

const DORK_HOME = '/tmp/dork-test-activity-actor';

/** Every actor field an emitted event carried. */
interface EmittedActor {
  actorType: string;
  actorId?: string | null;
  actorLabel: string;
  summary: string;
}

let emitted: EmittedActor[];

function stubRecord(): ExtensionRecord {
  return {
    id: 'test-ext',
    manifest: {
      id: 'test-ext',
      name: 'Test Extension',
      version: '1.0.0',
      serverCapabilities: {
        secrets: [{ key: 'api_key', label: 'API Key', required: true }],
        settings: [{ key: 'interval', type: 'number', label: 'Interval', default: 30 }],
      },
    },
    status: 'compiled',
    scope: 'global',
    path: '/fake/extensions/test-ext',
    bundleReady: true,
    hasServerEntry: true,
    hasDataProxy: false,
  } as ExtensionRecord;
}

/** The app in `app.ts`'s middleware order: identity resolution, then the router. */
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(resolveAgentIdentity);

  const manager = {
    listPublic: vi.fn<() => ExtensionRecordPublic[]>().mockReturnValue([]),
    get: vi.fn().mockReturnValue(stubRecord()),
  };

  app.locals.activityService = {
    emit: vi.fn(async (event: EmittedActor) => {
      emitted.push(event);
    }),
  };

  app.use(
    '/api/extensions',
    createExtensionsRouter(
      manager as unknown as Parameters<typeof createExtensionsRouter>[0],
      DORK_HOME,
      () => null
    )
  );
  return app;
}

describe('who the Activity feed says changed an extension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    secretStores.clear();
    settingStores.clear();
    emitted = [];
    fixtureTarget.mount(buildApp());
  });

  describe('PUT /api/extensions/:id/secrets/:key', () => {
    it('records a browser write as the person', async () => {
      const res = await request(fixtureServer)
        .put('/api/extensions/test-ext/secrets/api_key')
        .send({ value: 'sk-test' });

      expect(res.status).toBe(200);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ actorType: 'user', actorLabel: 'You' });
      expect(emitted[0].actorId).toBeUndefined();
    });

    it('records an identified agent as that agent, not as the person', async () => {
      const res = await request(fixtureServer)
        .put('/api/extensions/test-ext/secrets/api_key')
        .set('x-dorkos-agent', KNOWN_TOKEN)
        .send({ value: 'sk-test' });

      expect(res.status).toBe(200);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        actorType: 'agent',
        actorId: IDENTITY.agentPath,
        actorLabel: 'Researcher',
      });
    });

    it('never writes the presented token into the feed', async () => {
      await request(fixtureServer)
        .put('/api/extensions/test-ext/secrets/api_key')
        .set('x-dorkos-agent', KNOWN_TOKEN)
        .send({ value: 'sk-test' });

      expect(JSON.stringify(emitted)).not.toContain(KNOWN_TOKEN);
    });

    it('never writes a REAL-SHAPED token into the feed either', async () => {
      // `tok_…` is an artificially distinctive string, and a probe that only
      // ever searches for one is weaker than it looks: it would still pass if
      // the route wrote some transformed slice of the credential. A token in
      // the shape agent identity actually mints — bare hex, no prefix — is the
      // honest input for this assertion, and the individual halves are checked
      // too so a split or truncated copy cannot hide inside JSON escaping.
      const REAL_SHAPED = 'a3f9c1e2b70d48a6915ce4d2f8b03c7e';

      await request(fixtureServer)
        .put('/api/extensions/test-ext/secrets/api_key')
        .set('x-dorkos-agent', REAL_SHAPED)
        .send({ value: 'sk-test' });

      const serialized = JSON.stringify(emitted);
      expect(serialized).not.toContain(REAL_SHAPED);
      expect(serialized).not.toContain(REAL_SHAPED.slice(0, 16));
      expect(serialized).not.toContain(REAL_SHAPED.slice(-16));
      // It still lands as an unidentified caller, so the absence above is the
      // route declining to name the token — not the route emitting nothing.
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        actorType: 'system',
        actorLabel: 'Unidentified caller',
      });
    });

    it('records a token that resolves to nothing as an unidentified caller', async () => {
      // The header is there, so a machine is calling — DorkOS just cannot say
      // which one. Answering `You` here would be the same lie in a rarer case,
      // and the raw token is a credential, never a label.
      const res = await request(fixtureServer)
        .put('/api/extensions/test-ext/secrets/api_key')
        .set('x-dorkos-agent', 'tok_nobody_knows')
        .send({ value: 'sk-test' });

      expect(res.status).toBe(200);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        actorType: 'system',
        actorLabel: 'Unidentified caller',
      });
      expect(emitted[0].actorId).toBeUndefined();
      expect(JSON.stringify(emitted)).not.toContain('tok_nobody_knows');
    });
  });

  describe('PUT /api/extensions/:id/settings/:key', () => {
    it('records a browser write as the person', async () => {
      const res = await request(fixtureServer)
        .put('/api/extensions/test-ext/settings/interval')
        .send({ value: 60 });

      expect(res.status).toBe(200);
      expect(emitted[0]).toMatchObject({ actorType: 'user', actorLabel: 'You' });
    });

    it('records an identified agent as that agent', async () => {
      const res = await request(fixtureServer)
        .put('/api/extensions/test-ext/settings/interval')
        .set('x-dorkos-agent', KNOWN_TOKEN)
        .send({ value: 60 });

      expect(res.status).toBe(200);
      expect(emitted[0]).toMatchObject({
        actorType: 'agent',
        actorId: IDENTITY.agentPath,
        actorLabel: 'Researcher',
      });
    });

    it('records an unresolvable token as an unidentified caller', async () => {
      const res = await request(fixtureServer)
        .put('/api/extensions/test-ext/settings/interval')
        .set('x-dorkos-agent', 'tok_nobody_knows')
        .send({ value: 60 });

      expect(res.status).toBe(200);
      expect(emitted[0]).toMatchObject({
        actorType: 'system',
        actorLabel: 'Unidentified caller',
      });
    });
  });

  describe('DELETE /api/extensions/:id/secrets/:key', () => {
    /** Put the secret in place so the DELETE has something to remove. */
    async function setSecret(): Promise<void> {
      await request(fixtureServer)
        .put('/api/extensions/test-ext/secrets/api_key')
        .send({ value: 'sk-test' });
      emitted = [];
    }

    it('records a browser deletion as the person', async () => {
      await setSecret();

      const res = await request(fixtureServer).delete('/api/extensions/test-ext/secrets/api_key');

      expect(res.status).toBe(200);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ actorType: 'user', actorLabel: 'You' });
      expect(emitted[0].summary).toContain('Removed secret');
    });

    it('records an identified agent as that agent', async () => {
      await setSecret();

      const res = await request(fixtureServer)
        .delete('/api/extensions/test-ext/secrets/api_key')
        .set('x-dorkos-agent', KNOWN_TOKEN);

      expect(res.status).toBe(200);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        actorType: 'agent',
        actorId: IDENTITY.agentPath,
        actorLabel: 'Researcher',
      });
    });

    it('records an unresolvable token as an unidentified caller', async () => {
      await setSecret();

      const res = await request(fixtureServer)
        .delete('/api/extensions/test-ext/secrets/api_key')
        .set('x-dorkos-agent', 'tok_nobody_knows');

      expect(res.status).toBe(200);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        actorType: 'system',
        actorLabel: 'Unidentified caller',
      });
      expect(JSON.stringify(emitted)).not.toContain('tok_nobody_knows');
    });

    it('says nothing when the secret was never set', async () => {
      const res = await request(fixtureServer).delete('/api/extensions/test-ext/secrets/api_key');

      expect(res.status).toBe(200);
      expect(emitted).toEqual([]);
    });
  });

  describe('DELETE /api/extensions/:id/settings/:key', () => {
    /** Store the setting so the DELETE resets something real. */
    async function setSetting(): Promise<void> {
      await request(fixtureServer)
        .put('/api/extensions/test-ext/settings/interval')
        .send({ value: 60 });
      emitted = [];
    }

    it('records a browser reset as the person', async () => {
      await setSetting();

      const res = await request(fixtureServer).delete('/api/extensions/test-ext/settings/interval');

      expect(res.status).toBe(200);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ actorType: 'user', actorLabel: 'You' });
      expect(emitted[0].summary).toContain('Reset setting');
    });

    it('records an identified agent as that agent', async () => {
      await setSetting();

      const res = await request(fixtureServer)
        .delete('/api/extensions/test-ext/settings/interval')
        .set('x-dorkos-agent', KNOWN_TOKEN);

      expect(res.status).toBe(200);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        actorType: 'agent',
        actorId: IDENTITY.agentPath,
        actorLabel: 'Researcher',
      });
    });

    it('records an unresolvable token as an unidentified caller', async () => {
      await setSetting();

      const res = await request(fixtureServer)
        .delete('/api/extensions/test-ext/settings/interval')
        .set('x-dorkos-agent', 'tok_nobody_knows');

      expect(res.status).toBe(200);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        actorType: 'system',
        actorLabel: 'Unidentified caller',
      });
    });

    it('says nothing when the setting was already at its default', async () => {
      const res = await request(fixtureServer).delete('/api/extensions/test-ext/settings/interval');

      expect(res.status).toBe(200);
      expect(emitted).toEqual([]);
    });
  });

  // `PUT /:id/data` is the one write on this router that stays silent, and the
  // silence is a decision rather than an oversight (DOR-1829): it is the
  // extension API's `saveData`, called by extension CODE at whatever rate that
  // code likes — the shipped `hello-world` extension writes on every activation —
  // so a row per call would drown the feed. Pinned so the decision is visible if
  // somebody later "completes" the router.
  it('deliberately records nothing for a blob write', async () => {
    const res = await request(fixtureServer)
      .put('/api/extensions/test-ext/data')
      .set('x-dorkos-agent', KNOWN_TOKEN)
      .send({ visits: 1 });

    expect(res.status).toBe(200);
    expect(emitted).toEqual([]);
  });
});
