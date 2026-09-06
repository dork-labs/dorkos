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
 * @module routes/__tests__/extensions-activity-actor
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

  // The defect was one hardcoded pair copied into four more routes, so pinning
  // the six cases above would leave the seventh free to be written the old way.
  // This asserts the SHAPE instead: nothing on this router names an actor by
  // hand, whether or not a person bar makes it true today.
  //
  // Both halves of this guard are the way they are because an adversarial review
  // walked past the first version of it:
  //
  //  - The pattern is UNANCHORED. A line-anchored `^\s*actorType:` sees the
  //    formatted multi-line `emit({ … })` call and nothing else, so a one-line
  //    `emit({ actorType: 'user', actorLabel: 'You', … })` and a
  //    `const actor = { actorType: 'user' … }` spread in later both slid
  //    straight through it. What is forbidden is a quoted actor literal
  //    anywhere, so that is what it matches.
  //  - The file list is READ FROM THE DIRECTORY, not written out. Two literals
  //    guard the two files that exist today and say nothing about
  //    `extensions-<next-thing>.ts`, which is precisely the route that would
  //    copy the old shape.
  it('leaves no route on this router asserting its own actor', async () => {
    const routesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const files = readdirSync(routesDir).filter((name) => /^extensions.*\.ts$/.test(name));

    // A filter that silently matched nothing would pass this test forever.
    expect(files.length).toBeGreaterThanOrEqual(2);

    for (const file of files) {
      const source = await readFile(path.join(routesDir, file), 'utf-8');
      const hardcoded = source
        .split('\n')
        .filter((line) => /actor(Type|Label|Id)\s*:\s*['"`]/.test(line));
      expect(hardcoded, `${file} names an Activity actor by hand`).toEqual([]);

      // Only the files that actually record something have to read the caller —
      // `extensions-person-bar.ts` writes no Activity at all.
      if (source.includes('activityService.emit(')) {
        expect(source, `${file} writes Activity without reading the caller`).toContain(
          'readActivityActor(req, res)'
        );
      }
    }
  });
});
