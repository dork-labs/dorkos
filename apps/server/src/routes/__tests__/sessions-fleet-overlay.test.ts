import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
/**
 * @vitest-environment node
 *
 * The fleet fields on `GET /api/sessions` and `GET /api/sessions/:id` (spec
 * `claude-account-fleet` D7): each session's `accountId`, `status` and
 * `trackerItem`, and the list envelope's `accountUsage`. The account rules
 * themselves are covered by `session-fleet-overlay.test.ts`; this pins that
 * the routes run the overlay and put its answer on the wire.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import type { SessionLimit } from '@dorkos/shared/schemas';
import type { Session } from '@dorkos/shared/types';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

/** Shared between the `vi.mock` factory and the test body. */
let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    listRuntimes: vi.fn(() => [fakeRuntime]),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'claude-code'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'claude-code'),
    persistSessionRuntime: vi.fn(async () => true),
    has: vi.fn(() => true),
    getSessionSettings: vi.fn(async () => null),
    saveSessionSettings: vi.fn(async () => {}),
    getSessionSettingsMany: vi.fn(() => new Map()),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(async () => null),
}));

import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { createApp, finalizeApp } from '../../app.js';
import { setAccountUsageStore } from '../../services/core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../services/core/usage/account-usage-store.js';
import {
  SessionLimitStore,
  setSessionLimitStore,
} from '../../services/session/fleet/session-limit-store.js';

const app = createApp({ admission: new MainRequestAdmission() });
finalizeApp(app);
const server = listeningServer(app);

const LIMITED = '00000000-0000-4000-8000-0000000000b1';
const QUIET = '00000000-0000-4000-8000-0000000000b2';
const WORK_ROOT = '/accounts/work';

const LIMIT: SessionLimit = {
  accountId: 'work',
  window: 'five_hour',
  resetsAt: '2026-09-27T18:00:00.000Z',
  since: '2026-09-27T13:00:00.000Z',
  plan: { mode: 'ask' },
  scope: 'account',
  state: 'limited',
};

const WORK_USAGE = {
  runtime: 'claude-code',
  accountId: 'work',
  path: WORK_ROOT,
  label: 'Work',
} as unknown as AccountUsage;

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    ...overrides,
  };
}

let store: {
  peek: ReturnType<typeof vi.fn>;
  peekByRoot: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime('claude-code');
  store = {
    peek: vi.fn(() => [WORK_USAGE]),
    peekByRoot: vi.fn((_runtime: string, dir: string) =>
      dir === WORK_ROOT ? WORK_USAGE : { runtime: 'claude-code', accountId: null, path: dir }
    ),
    list: vi.fn(() => []),
  };
  setAccountUsageStore(store as unknown as AccountUsageStore);
  const limits = new SessionLimitStore(createTestDb());
  limits.upsert({ sessionId: LIMITED, limit: LIMIT, scope: 'account', accountPath: WORK_ROOT });
  setSessionLimitStore(limits);
});

afterEach(() => {
  setAccountUsageStore(undefined);
  setSessionLimitStore(undefined);
});

describe('GET /api/sessions: the fleet fields', () => {
  it('carries accountId and a stored limit on each session, and the accounts’ usage on the envelope', async () => {
    fakeRuntime.listSessions.mockResolvedValue([
      session(LIMITED, { account: WORK_ROOT }),
      session(QUIET, { account: WORK_ROOT }),
    ]);
    const res = await request(server).get('/api/sessions');

    expect(res.status).toBe(200);
    const [limited, quiet] = res.body.sessions as Session[];
    expect(limited!.accountId).toBe('work');
    expect(limited!.status).toEqual({ lifecycle: 'idle', limit: LIMIT });
    expect(quiet!.accountId).toBe('work');
    expect(quiet!.status).toBeUndefined();
    expect(res.body.accountUsage).toEqual([WORK_USAGE]);
    expect(store.peek).toHaveBeenCalledTimes(1);
    expect(store.peek).toHaveBeenCalledWith('claude-code', ['work']);
    expect(store.list).not.toHaveBeenCalled();
  });

  it('omits accountUsage when no session on the page has a known account', async () => {
    fakeRuntime.listSessions.mockResolvedValue([session(QUIET, { account: '/accounts/other' })]);
    const res = await request(server).get('/api/sessions');

    expect(res.status).toBe(200);
    expect(res.body.sessions[0].accountId).toBeUndefined();
    expect(res.body).not.toHaveProperty('accountUsage');
    expect(res.body).not.toHaveProperty('warnings');
  });
});

describe('GET /api/sessions/:id: the fleet fields', () => {
  it('carries the same accountId and status as the list', async () => {
    fakeRuntime.getSession.mockResolvedValue(session(LIMITED, { account: WORK_ROOT }));
    fakeRuntime.getSessionCwd = vi.fn(() => '/project');
    const res = await request(server).get(`/api/sessions/${LIMITED}`);

    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe('work');
    // The fleet overlay's status survives the session-open usage block after it.
    expect(res.body.status).toEqual({ lifecycle: 'idle', limit: LIMIT, accountUsage: WORK_USAGE });
  });

  it('names a session the fleet overlay could not from the account its usage resolved', async () => {
    // No transcript folder and no in-memory account: the fleet overlay names
    // nothing, and the usage block falls back to the runtime's `default`.
    fakeRuntime.getSession.mockResolvedValue(session(QUIET));
    fakeRuntime.getSessionCwd = vi.fn(() => '/project');
    const res = await request(server).get(`/api/sessions/${QUIET}`);

    expect(res.status).toBe(200);
    expect(res.body.status.accountUsage).toEqual(WORK_USAGE);
    expect(res.body.accountId).toBe('work');
  });
});
