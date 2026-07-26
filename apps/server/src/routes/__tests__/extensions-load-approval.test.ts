/**
 * Who may record the approval that lets an extension run code inside DorkOS
 * (DOR-516) — the question "can an agent approve its own extension?", answered by
 * reproduction rather than by reading the code.
 *
 * Three write paths reach `extensions.approvedToRun`, and every one is exercised
 * here against an adversary, because a gate that covers two of three is a gate an
 * agent routes around:
 *
 * 1. `POST /api/extensions/:id/approve` — the cockpit's own button (this file).
 * 2. `PATCH /api/config` — the general operator-only config write. Its bars are
 *    pinned in `config.test.ts`; what THIS file adds is that the new field is
 *    actually in the guarded set, which is a different claim from "the guard
 *    works".
 * 3. `operator.config_patch` — the capability tool, which refuses operator-only
 *    paths unconditionally with no posture to argue about.
 *
 * ## The residual, reproduced rather than described
 *
 * With login OFF — the shipped default — a caller that simply omits its
 * `X-DorkOS-Agent` header IS the local operator as far as DorkOS can tell, and it
 * can approve an extension. That is DOR-505's documented residual, it reaches this
 * field exactly as it reaches `auth.enabled`, and there is a test below that says
 * so out loud rather than leaving a reader to assume the gate is tighter than it
 * is. Do not describe this route as "only a person can" without the qualifier.
 *
 * @module routes/__tests__/extensions-load-approval
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Mutable posture + stored config the mocked config manager reports. */
const state = vi.hoisted(() => ({
  authEnabled: false,
  extensions: { enabled: ['my-ext'], disabled: [] as string[], approvedToRun: [] as string[] },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'auth' ? { enabled: state.authEnabled } : state.extensions),
    set: (key: string, value: unknown) => {
      if (key === 'extensions') state.extensions = value as typeof state.extensions;
    },
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import request from 'supertest';
import express from 'express';
import type { ExtensionRecord, ExtensionRecordPublic } from '@dorkos/extension-api';
import { createExtensionsRouter } from '../extensions.js';
import {
  findOperatorOnlyPaths,
  OPERATOR_ONLY_CONFIG_PATHS,
} from '../../services/core/operator/config-write-policy.js';
import { env } from '../../env.js';

/**
 * The cockpit's own trusted port. Read from `env` rather than hardcoded 4242:
 * a worktree checkout runs on an alternate `DORKOS_PORT` to avoid colliding
 * with other worktrees, and `resolveTrustedOrigins()` (which the route under
 * test calls for real) trusts whatever port is actually configured, not 4242.
 */
const TRUSTED_PORT = env.DORKOS_PORT;

const DORK_HOME = '/tmp/dork-test';

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

function stubPublic(approvedToRun: boolean): ExtensionRecordPublic {
  return {
    id: 'my-ext',
    manifest: { id: 'my-ext', name: 'My Extension', version: '1.0.0' },
    status: 'compiled',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: true,
    hasDataProxy: false,
    approvedToRun,
  };
}

describe('POST /api/extensions/:id/approve', () => {
  let app: express.Application;
  let manager: {
    get: ReturnType<typeof vi.fn>;
    approveToRun: ReturnType<typeof vi.fn>;
    revokeRunApproval: ReturnType<typeof vi.fn>;
    listPublic: ReturnType<typeof vi.fn>;
    readBundle: ReturnType<typeof vi.fn>;
  };
  /** Stands in for `sessionGate`'s resolved user, when login is on. */
  let signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    state.authEnabled = false;
    state.extensions = { enabled: ['my-ext'], disabled: [], approvedToRun: [] };
    signedInUser = undefined;

    manager = {
      get: vi.fn().mockReturnValue(stubRecord()),
      approveToRun: vi.fn().mockImplementation(async (id: string) => {
        state.extensions = {
          ...state.extensions,
          approvedToRun: [...state.extensions.approvedToRun, id],
        };
        return stubPublic(true);
      }),
      revokeRunApproval: vi.fn().mockResolvedValue(stubPublic(false)),
      listPublic: vi.fn().mockReturnValue([]),
      readBundle: vi.fn().mockImplementation(async (id: string) =>
        // Mirrors the real `ExtensionManager.readBundle` gate: an extension a
        // person has not approved has no bundle to serve.
        state.extensions.approvedToRun.includes(id) ? 'export function activate() {}' : null
      ),
    };

    app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      if (signedInUser) res.locals.user = signedInUser;
      next();
    });
    app.use(
      '/api/extensions',
      createExtensionsRouter(
        manager as unknown as Parameters<typeof createExtensionsRouter>[0],
        DORK_HOME,
        () => null
      )
    );
  });

  describe('an agent that names itself', () => {
    it('CANNOT approve its own extension, and nothing is written', async () => {
      const res = await request(app)
        .post('/api/extensions/my-ext/approve')
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('extension_not_approved_to_run');
      expect(manager.approveToRun).not.toHaveBeenCalled();
      // The decisive assertion: the stored list is untouched, so a refused call
      // leaves nothing behind that a later load could read as consent.
      expect(state.extensions.approvedToRun).toEqual([]);
    });

    it('CANNOT withdraw an approval either', async () => {
      state.extensions = { ...state.extensions, approvedToRun: ['my-ext'] };

      const res = await request(app)
        .post('/api/extensions/my-ext/revoke')
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({});

      expect(res.status).toBe(403);
      expect(manager.revokeRunApproval).not.toHaveBeenCalled();
      expect(state.extensions.approvedToRun).toEqual(['my-ext']);
    });

    it('is refused the same way when login is ON', async () => {
      state.authEnabled = true;
      signedInUser = { userId: 'u1', credential: 'cookie' };

      const res = await request(app)
        .post('/api/extensions/my-ext/approve')
        .set('x-dorkos-agent', 'agent-token-abc')
        .send({});

      // Even holding a real person's cookie, a caller that names itself an agent
      // is refused. The two bars are AND, not OR.
      expect(res.status).toBe(403);
      expect(state.extensions.approvedToRun).toEqual([]);
    });
  });

  describe('a caller that strips its agent header', () => {
    it('IS ALLOWED while login is off — the documented residual, not an oversight', async () => {
      const res = await request(app).post('/api/extensions/my-ext/approve').send({});

      expect(res.status).toBe(200);
      expect(state.extensions.approvedToRun).toEqual(['my-ext']);
      // This is the honest state of the default posture: with no accounts there is
      // no cookie, so nothing distinguishes the cockpit from any other loopback
      // caller, and refusing would lock a person out of their own extensions.
      // Identical to `auth.enabled` on `PATCH /api/config` (DOR-505). Turning on
      // Require login closes it — see the next test.
    });

    it('is REFUSED once login is on and it has no session cookie', async () => {
      state.authEnabled = true;
      signedInUser = undefined;

      const res = await request(app).post('/api/extensions/my-ext/approve').send({});

      // 403, not 401: `requireOperatorCookieUnderLogin` answers "only a person
      // signed in to DorkOS can change this" for every non-cookie caller, whether
      // it is unauthenticated or authenticated by some other means.
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('operator_cookie_required');
      expect(manager.approveToRun).not.toHaveBeenCalled();
      expect(state.extensions.approvedToRun).toEqual([]);
    });

    it('is REFUSED with login on when it holds only an API key, not a cookie', async () => {
      state.authEnabled = true;
      signedInUser = { userId: 'u1', credential: 'api-key' };

      const res = await request(app).post('/api/extensions/my-ext/approve').send({});

      // An API key is something a program can hold. A session cookie is the one
      // signal a header-stripping caller cannot fake.
      expect(res.status).toBe(403);
      expect(state.extensions.approvedToRun).toEqual([]);
    });
  });

  describe('a person in the cockpit', () => {
    it('approves with one click while login is off', async () => {
      const res = await request(app).post('/api/extensions/my-ext/approve').send({});

      expect(res.status).toBe(200);
      expect(res.body.extension.approvedToRun).toBe(true);
      expect(manager.approveToRun).toHaveBeenCalledWith('my-ext');
    });

    it('approves with a session cookie while login is on', async () => {
      state.authEnabled = true;
      signedInUser = { userId: 'u1', credential: 'cookie' };

      const res = await request(app).post('/api/extensions/my-ext/approve').send({});

      expect(res.status).toBe(200);
      expect(state.extensions.approvedToRun).toEqual(['my-ext']);
    });
  });

  /**
   * A cross-site POST is the one caller that is neither an agent nor the person,
   * and neither of the two bars above sees it. With login off it needs no cookie at
   * all, and CORS does not help: it withholds the RESPONSE, by which time the write
   * has happened. So the routes require a trusted `Origin` whenever a browser sends
   * one.
   */
  describe('a page on another site, posting through the person browser', () => {
    it('is refused, and nothing is written', async () => {
      const res = await request(app)
        .post('/api/extensions/my-ext/approve')
        .set('origin', 'https://evil.example')
        .send({});

      expect(res.status).toBe(403);
      expect(manager.approveToRun).not.toHaveBeenCalled();
      expect(state.extensions.approvedToRun).toEqual([]);
    });

    it('is refused on revoke too, so nothing can be silently switched off', async () => {
      state.extensions = { ...state.extensions, approvedToRun: ['my-ext'] };

      const res = await request(app)
        .post('/api/extensions/my-ext/revoke')
        .set('origin', 'https://evil.example')
        .send({});

      expect(res.status).toBe(403);
      expect(state.extensions.approvedToRun).toEqual(['my-ext']);
    });

    it('is still refused when login is on and it holds a real session cookie', async () => {
      // The cookie is exactly what a cross-site request would ride on, so the origin
      // bar has to be independent of it rather than a fallback for when it is absent.
      state.authEnabled = true;
      signedInUser = { userId: 'u1', credential: 'cookie' };

      const res = await request(app)
        .post('/api/extensions/my-ext/approve')
        .set('origin', 'https://evil.example')
        .send({});

      expect(res.status).toBe(403);
      expect(state.extensions.approvedToRun).toEqual([]);
    });

    it('cannot talk its way in by controlling the Host header (DNS rebinding)', async () => {
      // The bar originally computed the expected origin from `req.headers.host`,
      // which the attacker sets. Under DNS rebinding the browser sends BOTH
      // `Host: evil.example` and `Origin: http://evil.example` — they match, the
      // "same origin as this very request" shortcut fires, and the bar is skipped.
      // An expected value derived from the request cannot judge the request. The
      // allowlist has to be the server's own, which is what `validateMcpOrigin`
      // does, and its docstring names this attack.
      const res = await request(app)
        .post('/api/extensions/my-ext/approve')
        .set('host', 'evil.example')
        .set('origin', 'http://evil.example')
        .send({});

      expect(res.status).toBe(403);
      expect(state.extensions.approvedToRun).toEqual([]);
    });

    it('is not fooled by a host that merely starts with a trusted one', async () => {
      // `http://localhost:<port>.evil.example` is a host the attacker owns. Exact
      // `.includes()` membership refuses it; a prefix comparison would not, and a
      // prefix comparison is the natural way to write this wrong.
      const res = await request(app)
        .post('/api/extensions/my-ext/approve')
        .set('origin', `http://localhost:${TRUSTED_PORT}.evil.example`)
        .send({});

      expect(res.status).toBe(403);
      expect(state.extensions.approvedToRun).toEqual([]);
    });

    it('refuses the opaque `null` origin a sandboxed frame sends', async () => {
      // A sandboxed iframe or a `data:` URL sends the literal string `null`. It is
      // an Origin header, so it is judged, and it is in no allowlist.
      const res = await request(app)
        .post('/api/extensions/my-ext/approve')
        .set('origin', 'null')
        .send({});

      expect(res.status).toBe(403);
      expect(state.extensions.approvedToRun).toEqual([]);
    });

    it('lets the cockpit through on its own origin', async () => {
      const res = await request(app)
        .post('/api/extensions/my-ext/approve')
        .set('origin', `http://127.0.0.1:${TRUSTED_PORT}`)
        .send({});

      expect(res.status).toBe(200);
      expect(state.extensions.approvedToRun).toEqual(['my-ext']);
    });

    it('lets a caller with no Origin header through, because only browsers send one', async () => {
      // curl, the CLI, and the desktop shell send no Origin. Refusing them would
      // block the person without stopping the attack, since the header is set by the
      // browser and cannot be forged by the page.
      const res = await request(app).post('/api/extensions/my-ext/approve').send({});

      expect(res.status).toBe(200);
    });
  });

  describe('inputs that are not an approvable extension', () => {
    it('rejects an id that is not a valid extension id', async () => {
      const res = await request(app).post('/api/extensions/..%2Fetc/approve').send({});
      expect(res.status).toBe(400);
      expect(manager.approveToRun).not.toHaveBeenCalled();
    });

    it('404s an extension that does not exist', async () => {
      manager.get.mockReturnValue(undefined);
      const res = await request(app).post('/api/extensions/my-ext/approve').send({});
      expect(res.status).toBe(404);
    });

    it('409s a core extension, which is exempt by origin and has nothing to approve', async () => {
      manager.get.mockReturnValue(stubRecord({ origin: 'core' }));
      const res = await request(app).post('/api/extensions/my-ext/approve').send({});
      expect(res.status).toBe(409);
      expect(manager.approveToRun).not.toHaveBeenCalled();
    });
  });
});

describe('GET /api/extensions/:id/bundle', () => {
  /**
   * The client bundle is the second way extension code runs, and serving it before
   * the person decided handed an agent same-origin JavaScript on the cockpit page —
   * which carries the person's session, and can therefore POST the approval for the
   * agent's OWN server code. The gate is inside `ExtensionManager.readBundle`
   * because this route is the only way a bundle reaches a browser; what this test
   * pins is that the route honours it rather than falling back to something else.
   */
  let app: express.Application;
  let manager: { readBundle: ReturnType<typeof vi.fn>; listPublic: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    state.extensions = { enabled: ['my-ext'], disabled: [], approvedToRun: [] };

    manager = {
      readBundle: vi
        .fn()
        .mockImplementation(async (id: string) =>
          state.extensions.approvedToRun.includes(id) ? 'export function activate() {}' : null
        ),
      listPublic: vi.fn().mockReturnValue([]),
    };

    app = express();
    app.use(
      '/api/extensions',
      createExtensionsRouter(
        manager as unknown as Parameters<typeof createExtensionsRouter>[0],
        DORK_HOME,
        () => null
      )
    );
  });

  it('serves nothing for an extension the person has not approved', async () => {
    const res = await request(app).get('/api/extensions/my-ext/bundle');

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('activate');
  });

  it('serves it once the person approves', async () => {
    state.extensions = { ...state.extensions, approvedToRun: ['my-ext'] };

    const res = await request(app).get('/api/extensions/my-ext/bundle');

    expect(res.status).toBe(200);
    expect(res.text).toContain('activate');
  });
});

describe('the config side door', () => {
  it('classifies extensions.approvedToRun as operator-only', () => {
    // Without this, `PATCH /api/config` and `operator.config_patch` would both let
    // an agent write the field directly and the route bars above would be theater.
    expect(OPERATOR_ONLY_CONFIG_PATHS).toContain('extensions.approvedToRun');
  });

  it('catches a patch aimed at the field, however it is spelled', () => {
    expect(findOperatorOnlyPaths({ extensions: { approvedToRun: ['my-ext'] } })).toContain(
      'extensions.approvedToRun'
    );
    // Stopping short of the leaf must not slip past: replacing the whole
    // `extensions` subtree would drop every approval just as effectively.
    expect(findOperatorOnlyPaths({ extensions: {} })).toContain('extensions.approvedToRun');
    expect(findOperatorOnlyPaths({ extensions: true })).toContain('extensions.approvedToRun');
  });
});
