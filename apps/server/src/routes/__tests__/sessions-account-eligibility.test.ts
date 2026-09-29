/**
 * @vitest-environment node
 *
 * The first message of a session whose picked account may not work in the
 * folder's project (spec `flow-multiproject` §8.3, §8.4): `POST
 * /api/sessions/:id/messages` answers `409 account_not_allowed_here` with the
 * plain sentence, and nothing is bound or started, so the next send may still
 * pick another account.
 *
 * The runtime is a fake, but its `checkLaunchAccount` runs the real launch
 * ladder over a real git repository, so the refusal the route maps is the one
 * production computes, not a stub's.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';

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

let fakeRuntime: FakeAgentRuntime & { checkLaunchAccount?: unknown };

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    listRuntimes: vi.fn(() => [fakeRuntime]),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'claude-code'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    resolveSessionRuntime: vi.fn(async () => ({ type: 'claude-code', bound: false })),
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

import { createServer } from 'node:http';
import { once } from 'node:events';
import request from '@dorkos/test-utils/supertest';
import { createApp, finalizeApp } from '../../app.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { disposeProjector } from '../../services/session/session-state-projector.js';
import { resolveLaunchAccountRoot } from '../../services/runtimes/claude-code/claude-config-dir.js';
import { projectOfFolder } from '../../services/core/usage/account-eligibility.js';

const app = createApp({ admission: new MainRequestAdmission() });
finalizeApp(app);
const server = createServer(app);

const S1 = '00000000-0000-4000-8000-0000000000e1';

let tmp: string;
let repo: string;

/** The account rules the fake runtime's ladder reads: Work is kept to `other`. */
function rulesConfig(): { get<K extends keyof UserConfig>(key: K): UserConfig[K] } {
  const runtimes: UserConfig['runtimes'] = {
    ...USER_CONFIG_DEFAULTS.runtimes,
    claudeCode: {
      defaultAccount: null,
      accounts: [
        {
          id: 'work',
          path: '/staged/claude-work',
          label: 'Work',
          color: null,
          onlyProjects: ['/somewhere/else'],
        },
        { id: 'personal', path: '/staged/claude-personal', label: 'Personal', color: null },
      ],
      defaultAccountColor: null,
      defaultAccountOnlyProjects: null,
      projectAccounts: {},
      dismissedFolders: [],
      defaultModel: null,
      defaultEffort: null,
      defaultTrustStop: null,
      persistentSession: false,
    } as UserConfig['runtimes']['claudeCode'],
  };
  return {
    get: (<K extends keyof UserConfig>(key: K) =>
      key === 'runtimes' ? runtimes : USER_CONFIG_DEFAULTS[key]) as <K extends keyof UserConfig>(
      key: K
    ) => UserConfig[K],
  };
}

beforeAll(async () => {
  server.listen(0);
  await once(server, 'listening');
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'acct-elig-send-')));
  repo = path.join(tmp, 'client-app');
  await fs.mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime('claude-code');
  vi.clearAllMocks();
  fakeRuntime.acquireLock.mockReturnValue(true);
  fakeRuntime.getLockInfo.mockReturnValue(null);
  fakeRuntime.getInternalSessionId.mockReturnValue(undefined);
  fakeRuntime.checkLaunchAccount = vi.fn(async (_sid: string, cwd: string, hintId?: string) =>
    resolveLaunchAccountRoot({
      hintId,
      project: await projectOfFolder(cwd),
      config: rulesConfig(),
    })
  );
  vi.mocked(runtimeRegistry.resolveForSession).mockReset().mockResolvedValue(fakeRuntime);
  vi.mocked(runtimeRegistry.persistSessionRuntime).mockReset().mockResolvedValue(true);
  vi.mocked(runtimeRegistry.resolveSessionRuntime)
    .mockReset()
    .mockResolvedValue({ type: 'claude-code', bound: false });
  disposeProjector(S1);
});

describe('POST /:id/messages — an account that may not work in this project', () => {
  it('answers 409 with the sentence, the project and the account, and binds nothing', async () => {
    const res = await request(server)
      .post(`/api/sessions/${S1}/messages`)
      .send({ content: 'hi', cwd: repo, account: 'work' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: expect.stringContaining("Work can't be used in client-app"),
      message: res.body.error,
      code: 'account_not_allowed_here',
      project: { root: repo, name: 'client-app' },
      accountId: 'work',
    });
    expect(fakeRuntime.checkLaunchAccount).toHaveBeenCalledWith(S1, repo, 'work');
    expect(runtimeRegistry.persistSessionRuntime).not.toHaveBeenCalled();
    expect(fakeRuntime.sendMessage).not.toHaveBeenCalled();
  });

  it('accepts an eligible pick (202) and reaches the runtime', async () => {
    const res = await request(server)
      .post(`/api/sessions/${S1}/messages`)
      .send({ content: 'hi', cwd: repo, account: 'personal' });

    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(fakeRuntime.sendMessage).toHaveBeenCalled());
    expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalled();
  });

  it('does not re-judge a session that is already bound', async () => {
    vi.mocked(runtimeRegistry.resolveSessionRuntime).mockResolvedValue({
      type: 'claude-code',
      bound: true,
    });
    const res = await request(server)
      .post(`/api/sessions/${S1}/messages`)
      .send({ content: 'hi', cwd: repo, account: 'work' });

    expect(res.status).toBe(202);
    expect(fakeRuntime.checkLaunchAccount).not.toHaveBeenCalled();
  });
});
