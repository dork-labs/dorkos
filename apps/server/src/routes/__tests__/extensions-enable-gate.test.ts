/**
 * Who may turn an extension on or off (DOR-1507) — the question "can an agent
 * change which code this copy of DorkOS runs?", answered by reproduction rather
 * than by reading the route.
 *
 * `extensions.enabled` and `extensions.disabled` are `operator-only` in
 * `config-write-policy.ts`, so `PATCH /api/config` and the `config_patch`
 * operator tool both refuse an agent the write. `POST /api/extensions/:id/enable`
 * and `/disable` write the same two leaves through `ExtensionManager` — a
 * purpose-built writer, which is allowed, on the bargain that the writer's own
 * door carries the gate. That door ran nothing at all, which is the defect this
 * file pins: the classification existed and no code enforced it, so the friendly
 * route was the cheap way round the strict one. Same shape as the tunnel route
 * before DOR-1738, one router over.
 *
 * ## Severity, stated rather than inflated
 *
 * Turning an extension ON does not by itself run its code:
 * `extension-server-lifecycle.ts` re-asks `mayRunExtensionCode` against
 * `extensions.approvedToRun`, which only a person writes (DOR-516), and the
 * browser bundle is withheld the same way. What an ungated enable DOES do is
 * re-arm an extension whose code a person approved once and later switched off —
 * approval survives a disable — so it reverses a human decision without being an
 * arbitrary code-execution primitive. The `re-arms an extension` case below is
 * the one that makes that concrete.
 *
 * The residual is the same one every operator-only surface has and is reproduced
 * below rather than described: with login OFF, a caller that simply omits its
 * `X-DorkOS-Agent` header IS the operator as far as DorkOS can tell. Do not
 * describe these routes as "only a person can" without that qualifier.
 *
 * @module routes/__tests__/extensions-enable-gate
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/** Mutable posture + stored config the mocked config manager reports. */
const state = vi.hoisted(() => ({
  authEnabled: false,
  extensions: { enabled: [] as string[], disabled: [] as string[], approvedToRun: [] as string[] },
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

/**
 * Pins the port `resolveTrustedOrigins()` builds its allowlist from, so the
 * origin cases below test the route's comparison rather than testing that the
 * route and this file read the same environment variable. Same reasoning, and
 * the same two-variable stub, as `extensions-load-approval.test.ts` — read the
 * long note there before changing either half.
 */
vi.mock('../../env.js', () => ({ env: { DORKOS_PORT: 7777 } }));
vi.stubEnv('VITE_PORT', '7779');

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import express from 'express';
import type { ExtensionRecord, ExtensionRecordPublic } from '@dorkos/extension-api';
import { createExtensionsRouter } from '../extensions.js';
import {
  findOperatorOnlyPaths,
  OPERATOR_ONLY_CONFIG_CODE,
} from '../../services/core/operator/config-write-policy.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** The literal port `resolveTrustedOrigins()` is pinned to above. */
const TRUSTED_PORT = 7777;

afterAll(() => {
  vi.unstubAllEnvs();
});

const DORK_HOME = '/tmp/dork-test-enable-gate';

function stubRecord(overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id: 'my-ext',
    manifest: { id: 'my-ext', name: 'My Extension', version: '1.0.0' },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    path: '/fake/extensions/my-ext',
    bundleReady: true,
    hasServerEntry: true,
    hasDataProxy: false,
    ...overrides,
  };
}

function stubPublic(): ExtensionRecordPublic {
  return {
    id: 'my-ext',
    manifest: { id: 'my-ext', name: 'My Extension', version: '1.0.0' },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: true,
    hasDataProxy: false,
    approvedToRun: state.extensions.approvedToRun.includes('my-ext'),
  };
}

describe('who may turn an extension on or off', () => {
  let app: express.Application;
  let manager: {
    get: ReturnType<typeof vi.fn>;
    enable: ReturnType<typeof vi.fn>;
    disable: ReturnType<typeof vi.fn>;
    listPublic: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
    updateCwd: ReturnType<typeof vi.fn>;
  };
  /** Stands in for `sessionGate`'s resolved user, when login is on. */
  let signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;
  /** Every Activity event the router emitted during one case. */
  let emitted: Array<{ actorType: string; actorLabel: string }>;

  beforeEach(() => {
    vi.clearAllMocks();
    state.authEnabled = false;
    state.extensions = { enabled: [], disabled: [], approvedToRun: [] };
    signedInUser = undefined;
    emitted = [];

    manager = {
      get: vi.fn().mockReturnValue(stubRecord()),
      // Both mutate the same stored shape the real manager does, so every
      // refusal case below can assert on the CONFIG rather than only on the
      // spy — a route that refused after writing would pass the spy assertion.
      enable: vi.fn().mockImplementation(async (id: string) => {
        state.extensions = {
          ...state.extensions,
          enabled: [...state.extensions.enabled, id],
          disabled: state.extensions.disabled.filter((e) => e !== id),
        };
        return { extension: stubPublic(), reloadRequired: true };
      }),
      disable: vi.fn().mockImplementation(async (id: string) => {
        state.extensions = {
          ...state.extensions,
          enabled: state.extensions.enabled.filter((e) => e !== id),
          disabled: [...state.extensions.disabled, id],
        };
        return { extension: stubPublic(), reloadRequired: true };
      }),
      listPublic: vi.fn().mockReturnValue([]),
      reload: vi.fn().mockResolvedValue([]),
      updateCwd: vi.fn().mockResolvedValue({ added: [], removed: [] }),
    };

    app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      if (signedInUser) res.locals.user = signedInUser;
      next();
    });
    // Wired so the refusal cases can assert what the FEED was told, not only
    // what the config holds. A route that refused the write but still recorded
    // "You turned this on" would pass every other assertion in this file
    // (DOR-1801).
    app.locals.activityService = {
      emit: vi.fn(async (event: { actorType: string; actorLabel: string }) => {
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

    fixtureTarget.mount(app);
  });

  /**
   * The claim underneath every case below. If somebody reclassified these two
   * leaves as preferences, the whole gate would become the wrong shape rather
   * than merely untested, and this says so first.
   */
  it('writes settings the config policy calls operator-only', () => {
    expect(findOperatorOnlyPaths({ extensions: { enabled: ['x'] } })).toEqual([
      'extensions.enabled',
    ]);
    expect(findOperatorOnlyPaths({ extensions: { disabled: ['x'] } })).toEqual([
      'extensions.disabled',
    ]);
  });

  describe('an agent that names itself', () => {
    it('CANNOT turn an extension on, and nothing is written', async () => {
      const res = await request(fixtureServer)
        .post('/api/extensions/my-ext/enable')
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(OPERATOR_ONLY_CONFIG_CODE);
      expect(manager.enable).not.toHaveBeenCalled();
      expect(state.extensions.enabled).toEqual([]);
      // And the feed is told NOTHING — a refused attempt must not leave a line
      // claiming the person did it. This is the half a spy on `enable` cannot
      // see: the emission sits after the write, so a bar that let the request
      // reach it would record a lie about an effect that never happened.
      expect(emitted).toEqual([]);
    });

    it('CANNOT turn one off either — operator-only reads paths, never values', async () => {
      state.extensions = { ...state.extensions, enabled: ['my-ext'] };

      const res = await request(fixtureServer)
        .post('/api/extensions/my-ext/disable')
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({});

      expect(res.status).toBe(403);
      expect(manager.disable).not.toHaveBeenCalled();
      expect(state.extensions.enabled).toEqual(['my-ext']);
      expect(state.extensions.disabled).toEqual([]);
    });

    it('cannot re-arm an extension a person approved and then switched off', async () => {
      // The case that carries the real severity. An approval survives a disable
      // on purpose — a person who turns something off has not withdrawn their
      // judgement of its code — so an ungated enable would put an approved
      // extension's server half back into the process, which is exactly what
      // `serverLifecycle.initialize` does when `mayRunExtensionCode` says yes.
      state.extensions = { enabled: [], disabled: ['my-ext'], approvedToRun: ['my-ext'] };

      const res = await request(fixtureServer)
        .post('/api/extensions/my-ext/enable')
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({});

      expect(res.status).toBe(403);
      expect(manager.enable).not.toHaveBeenCalled();
      expect(state.extensions.disabled).toEqual(['my-ext']);
    });

    it('is refused the same way when login is ON and it holds a cookie', async () => {
      state.authEnabled = true;
      signedInUser = { userId: 'u1', credential: 'cookie' };

      const res = await request(fixtureServer)
        .post('/api/extensions/my-ext/enable')
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({});

      // The two bars are AND, not OR: a real person's cookie does not launder a
      // caller that names itself an agent.
      expect(res.status).toBe(403);
      expect(state.extensions.enabled).toEqual([]);
    });
  });

  describe('a caller that strips its agent header', () => {
    it('IS ALLOWED while login is off — the documented residual, not an oversight', async () => {
      const res = await request(fixtureServer).post('/api/extensions/my-ext/enable').send({});

      expect(res.status).toBe(200);
      expect(state.extensions.enabled).toEqual(['my-ext']);
      // With no accounts there is no cookie, so nothing distinguishes the app
      // from any other loopback caller and refusing would lock a person out of
      // their own extensions. Identical to `auth.enabled` on `PATCH /api/config`
      // (DOR-505). Turning on Require login closes it — see the next case.
    });

    it('is REFUSED once login is on and it has no session cookie', async () => {
      state.authEnabled = true;
      signedInUser = undefined;

      const res = await request(fixtureServer).post('/api/extensions/my-ext/enable').send({});

      // 403 rather than 401: the answer is "only a person signed in to DorkOS
      // can change this", which is true of an unauthenticated caller and of one
      // authenticated by some other means alike.
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('operator_cookie_required');
      expect(manager.enable).not.toHaveBeenCalled();
      expect(state.extensions.enabled).toEqual([]);
    });

    it('is REFUSED with login on when it holds only an API key', async () => {
      state.authEnabled = true;
      signedInUser = { userId: 'u1', credential: 'api-key' };

      const res = await request(fixtureServer).post('/api/extensions/my-ext/enable').send({});

      // An API key is something a program can hold. A session cookie is the one
      // signal a header-stripping caller cannot fake.
      expect(res.status).toBe(403);
      expect(state.extensions.enabled).toEqual([]);
    });
  });

  describe('a person in the app', () => {
    it('turns an extension on with one click while login is off', async () => {
      const res = await request(fixtureServer).post('/api/extensions/my-ext/enable').send({});

      expect(res.status).toBe(200);
      expect(manager.enable).toHaveBeenCalledWith('my-ext');
      // The positive half of the refusal assertions above: the feed DOES record
      // this one, as the person. Without it, `expect(emitted).toEqual([])` would
      // pass just as happily against a spy that was never wired up at all.
      expect(emitted).toEqual([expect.objectContaining({ actorType: 'user', actorLabel: 'You' })]);
    });

    it('turns one off with a session cookie while login is on', async () => {
      state.authEnabled = true;
      signedInUser = { userId: 'u1', credential: 'cookie' };
      state.extensions = { ...state.extensions, enabled: ['my-ext'] };

      const res = await request(fixtureServer).post('/api/extensions/my-ext/disable').send({});

      expect(res.status).toBe(200);
      expect(state.extensions.disabled).toEqual(['my-ext']);
    });

    it('is allowed from the app own origin, which the bar must not refuse', async () => {
      // The positive control for the origin bar: a bar that refused everything
      // would pass every case above and lock the person out of their own app.
      const res = await request(fixtureServer)
        .post('/api/extensions/my-ext/enable')
        .set('origin', `http://localhost:${TRUSTED_PORT}`)
        .send({});

      expect(res.status).toBe(200);
      expect(state.extensions.enabled).toEqual(['my-ext']);
    });
  });

  /**
   * The caller neither of the other two bars sees: a page the person is visiting,
   * POSTing through their own browser. With login off it needs no cookie at all,
   * and CORS does not help — it withholds the RESPONSE, by which time the write
   * has happened.
   */
  describe('a page on another site, posting through the person browser', () => {
    it('is refused on enable, and nothing is written', async () => {
      const res = await request(fixtureServer)
        .post('/api/extensions/my-ext/enable')
        .set('origin', 'https://evil.example')
        .send({});

      expect(res.status).toBe(403);
      expect(manager.enable).not.toHaveBeenCalled();
      expect(state.extensions.enabled).toEqual([]);
    });

    it('is refused on disable too, so nothing can be silently switched off', async () => {
      state.extensions = { ...state.extensions, enabled: ['my-ext'] };

      const res = await request(fixtureServer)
        .post('/api/extensions/my-ext/disable')
        .set('origin', 'https://evil.example')
        .send({});

      expect(res.status).toBe(403);
      expect(state.extensions.enabled).toEqual(['my-ext']);
    });

    it('is still refused when login is on and it holds a real session cookie', async () => {
      // The cookie is exactly what a cross-site request rides on, so the origin
      // bar has to be independent of it rather than a fallback for its absence.
      state.authEnabled = true;
      signedInUser = { userId: 'u1', credential: 'cookie' };

      const res = await request(fixtureServer)
        .post('/api/extensions/my-ext/enable')
        .set('origin', 'https://evil.example')
        .send({});

      expect(res.status).toBe(403);
      expect(state.extensions.enabled).toEqual([]);
    });

    it('cannot talk its way in by controlling the Host header (DNS rebinding)', async () => {
      // An expected origin derived from `req.headers.host` matches whatever the
      // attacker sets, so the bar would skip itself. The allowlist has to be the
      // server's own — `middleware/mcp-origin.ts` names this attack outright.
      const res = await request(fixtureServer)
        .post('/api/extensions/my-ext/enable')
        .set('host', 'evil.example')
        .set('origin', 'http://evil.example')
        .send({});

      expect(res.status).toBe(403);
      expect(state.extensions.enabled).toEqual([]);
    });

    it('is not fooled by a host that merely starts with a trusted one', async () => {
      const res = await request(fixtureServer)
        .post('/api/extensions/my-ext/enable')
        .set('origin', `http://localhost:${TRUSTED_PORT}.evil.example`)
        .send({});

      expect(res.status).toBe(403);
      expect(state.extensions.enabled).toEqual([]);
    });
  });

  /**
   * The routes on this router that are NOT writes stay open, and that is a
   * decision rather than an omission: listing extensions and re-scanning the
   * filesystem move no config, so barring them would break the agent tooling
   * (`list_extensions`, `reload_extensions`) for nothing. If one of them ever
   * starts writing, it needs the bar and this case is where the reader finds out
   * it did not have one.
   */
  describe('the read and rescan routes', () => {
    it('still answer an agent, because they write no config', async () => {
      const list = await request(fixtureServer)
        .get('/api/extensions')
        .set('x-dorkos-agent', 'agent-token-abc');
      expect(list.status).toBe(200);

      const reload = await request(fixtureServer)
        .post('/api/extensions/reload')
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({});
      expect(reload.status).toBe(200);
    });
  });
});
