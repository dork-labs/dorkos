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
