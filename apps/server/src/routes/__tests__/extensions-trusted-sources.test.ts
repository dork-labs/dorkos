/**
 * Who may trust a code source (spec `flow-multiproject` §9.3, invariant 15):
 * trusting code from a new source is one of the asks only a person answers,
 * so both writes refuse a caller that names itself an agent, in every posture.
 * Also pins the one-time trust offer on the approve response.
 *
 * @module routes/__tests__/extensions-trusted-sources
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const state = vi.hoisted(() => ({
  authEnabled: false,
  extensions: {
    enabled: ['flow'],
    disabled: [] as string[],
    approvedToRun: [] as string[],
    trustedSources: [] as Array<{ source: string; trustedAt: string }>,
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: state.authEnabled } : state.extensions),
    set: (key: string, value: unknown) => {
      if (key === 'extensions') state.extensions = value as typeof state.extensions;
    },
  },
}));
vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../env.js', () => ({ env: { DORKOS_PORT: 7777 } }));
vi.stubEnv('VITE_PORT', '7779');

// CORS lets these test origins through, so each reaches the route's own
// origin bar, which judges against the server's static set and not this list.
vi.stubEnv('DORKOS_CORS_ORIGIN', 'https://evil.example');

// The session gate lets every request through: these cases are about the
// routes' own bars, and each one sets the user the gate would have proved
// (`before` below), as the Express version stubbed `res.locals.user`.
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createExtensionsRoutes } from '../extensions.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;
const SOURCE = 'dork-labs/marketplace';

afterAll(() => {
  vi.unstubAllEnvs();
});

const flowRecord: ExtensionRecord = {
  id: 'flow',
  manifest: { id: 'flow', name: 'Flow', version: '1.0.0' },
  status: 'compiled',
  scope: 'local',
  origin: 'user',
  path: '/work/a/.dork/plugins/flow/.dork/extensions/flow',
  sourcePlugin: 'flow',
  trustedOrigin: { plugin: 'flow', source: SOURCE },
  bundleReady: true,
  hasServerEntry: false,
  hasDataProxy: false,
};

describe('trusted sources', () => {
  let manager: Record<string, ReturnType<typeof vi.fn>>;
  let signedInUser: { userId: string; credential: 'cookie' } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    state.authEnabled = false;
    state.extensions = { enabled: ['flow'], disabled: [], approvedToRun: [], trustedSources: [] };
    signedInUser = undefined;
    manager = {
      get: vi.fn().mockReturnValue(flowRecord),
      approveToRun: vi.fn().mockResolvedValue({ id: 'flow' }),
      trustOfferFor: vi
        .fn()
        .mockImplementation(() =>
          state.extensions.trustedSources.some((t) => t.source === SOURCE) ? null : SOURCE
        ),
      trustSource: vi.fn().mockImplementation(async (source: string) => {
        if (source !== SOURCE) return 'unproven';
        if (state.extensions.trustedSources.some((t) => t.source === source)) return 'already';
        state.extensions = {
          ...state.extensions,
          trustedSources: [...state.extensions.trustedSources, { source, trustedAt: 'now' }],
        };
        return 'added';
      }),
      untrustSource: vi.fn().mockImplementation(async (source: string) => {
        const had = state.extensions.trustedSources.some((t) => t.source === source);
        state.extensions = {
          ...state.extensions,
          trustedSources: state.extensions.trustedSources.filter((t) => t.source !== source),
        };
        return had;
      }),
      listPublic: vi.fn().mockReturnValue([]),
      listShadowedPublic: vi.fn().mockReturnValue([]),
    };
    fixtureTarget.mount(
      honoGroupListener(
        {
          path: '/api/extensions',
          routes: createExtensionsRoutes({
            manager: manager as unknown as Parameters<typeof createExtensionsRoutes>[0]['manager'],
            dorkHome: '/tmp/dork-test',
            getCwd: () => null,
          }),
        },
        {
          before: async (c, next) => {
            if (signedInUser) c.set('user', signedInUser as never);
            await next();
          },
        }
      )
    );
  });

  it('offers to trust the source right after a person approves, and not once it is trusted', async () => {
    // A yes names the files the card showed (DOR-3068).
    const shown = { version: '1.0.0', expectedDigest: `sha256:${'a'.repeat(64)}` };
    const first = await request(fixtureServer).post('/api/extensions/flow/approve').send(shown);
    expect(first.status).toBe(200);
    expect(first.body.trustOffer).toEqual({ source: SOURCE });

    await request(fixtureServer).post('/api/extensions/trusted-sources').send({ source: SOURCE });
    const again = await request(fixtureServer).post('/api/extensions/flow/approve').send(shown);
    expect(again.body.trustOffer).toBeUndefined();
  });

  it('never offers anything to an agent: the approval itself is refused', async () => {
    const res = await request(fixtureServer)
      .post('/api/extensions/flow/approve')
      .set('x-dorkos-agent', 'agent-token')
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.trustOffer).toBeUndefined();
  });

  it('lets a person trust a proven source, normalizing how it is written', async () => {
    const res = await request(fixtureServer)
      .post('/api/extensions/trusted-sources')
      .send({ source: 'https://github.com/Dork-Labs/marketplace.git' });

    expect(res.status).toBe(200);
    expect(manager.trustSource).toHaveBeenCalledWith(SOURCE);
    expect(res.body.sources).toEqual([{ source: SOURCE, trustedAt: 'now' }]);

    const list = await request(fixtureServer).get('/api/extensions/trusted-sources');
    expect(list.body.sources).toEqual([{ source: SOURCE, trustedAt: 'now' }]);
  });

  it('refuses a source nothing installed provably comes from, and one that is not a repo', async () => {
    const unproven = await request(fixtureServer)
      .post('/api/extensions/trusted-sources')
      .send({ source: 'someone/else' });
    expect(unproven.status).toBe(409);
    expect(unproven.body.code).toBe('unproven_source');

    const junk = await request(fixtureServer)
      .post('/api/extensions/trusted-sources')
      .send({ source: 'file:///tmp/x' });
    expect(junk.status).toBe(400);
    expect(state.extensions.trustedSources).toEqual([]);
  });

  it.each(['post', 'delete'] as const)(
    'refuses an agent-headed %s in every posture, and writes nothing',
    async (method) => {
      state.extensions.trustedSources = [{ source: SOURCE, trustedAt: 'then' }];
      for (const login of [false, true]) {
        state.authEnabled = login;
        signedInUser = login ? { userId: 'u1', credential: 'cookie' } : undefined;
        const res = await request(fixtureServer)
          [method]('/api/extensions/trusted-sources')
          .set('x-dorkos-agent', 'agent-token')
          .send({ source: SOURCE });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('trusted_source_person_only');
      }
      expect(manager.trustSource).not.toHaveBeenCalled();
      expect(manager.untrustSource).not.toHaveBeenCalled();
      expect(state.extensions.trustedSources).toEqual([{ source: SOURCE, trustedAt: 'then' }]);
    }
  );

  it('refuses a page on another site', async () => {
    const res = await request(fixtureServer)
      .post('/api/extensions/trusted-sources')
      .set('Origin', 'https://evil.example')
      .send({ source: SOURCE });
    expect(res.status).toBe(403);
    expect(manager.trustSource).not.toHaveBeenCalled();
  });

  it('lets a person stop trusting, and says so when it was not trusted', async () => {
    state.extensions.trustedSources = [{ source: SOURCE, trustedAt: 'then' }];
    const res = await request(fixtureServer)
      .delete('/api/extensions/trusted-sources')
      .send({ source: SOURCE });
    expect(res.status).toBe(200);
    expect(res.body.sources).toEqual([]);

    const missing = await request(fixtureServer)
      .delete('/api/extensions/trusted-sources')
      .send({ source: SOURCE });
    expect(missing.status).toBe(404);
  });
});
