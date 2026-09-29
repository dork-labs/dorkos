/**
 * Starting work obeys the account rules (spec `flow-multiproject` §7.7, §8.4):
 * a project no account may work in refuses the start with
 * `account_not_allowed_here` and the plain §8.3 sentence, through
 * `ctx.sessions.start` and `POST /api/extensions/:id/start-work` alike, and
 * nothing is launched or recorded. The real Claude Code ladder decides; only
 * the config it reads and the launch service are stand-ins.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const rules = vi.hoisted(() => ({ claudeCode: {} as Record<string, unknown> }));
const launches = vi.hoisted(() => [] as Array<{ sessionId: string }>);

vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'runtimes'
        ? { claudeCode: rules.claudeCode }
        : key === 'auth'
          ? { enabled: false }
          : { enabled: [], disabled: [], approvedToRun: [] },
    set: () => {},
  },
}));
vi.mock('../../../env.js', () => ({ env: { DORKOS_PORT: 7777 } }));
vi.stubEnv('VITE_PORT', '7779');
vi.mock('../../session/launch/launch-session.js', () => ({
  AGENT_LAUNCH_CAP_MESSAGE: 'Too many agent-started sessions are running (8).',
  isSessionLaunchRefusal: (result: object) => 'refused' in result,
  dispatchSessionMessage: vi.fn(async (opts: { sessionId: string }) => {
    launches.push(opts);
    return { accepted: true, canonicalId: opts.sessionId, queued: false, queuePosition: 1 };
  }),
}));

import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import type { ProjectInfo } from '@dorkos/extension-api/server';
import { createExtensionsRouter } from '../../../routes/extensions.js';
import { SessionStartedByStore } from '../../session/origin/session-started-by-store.js';
import { StartWorkService, setStartWorkService } from '../start-work.js';
import { createDataProviderContext } from '../extension-server-api-factory.js';

const target = swappableServer();
const server = target.server;

afterAll(() => vi.unstubAllEnvs());

const DORKOS: ProjectInfo = {
  root: '/repos/dorkos',
  name: 'dorkos',
  originRepo: null,
  lastSeenAt: '',
};

const INPUT = {
  project: '/repos/dorkos',
  prompt: 'Sort the new ideas.',
  title: 'Sorting 12 new ideas in dorkos',
  reason: '12 new ideas were waiting to be sorted',
};

let store: SessionStartedByStore;

beforeEach(() => {
  launches.length = 0;
  rules.claudeCode = {
    accounts: [{ id: 'work', path: '/accounts/work', label: 'Work', onlyProjects: null }],
    defaultAccountOnlyProjects: null,
    // dorkos may use no account at all.
    projectAccounts: { [DORKOS.root]: { allow: [] } },
  };
  store = new SessionStartedByStore(createTestDb());
  setStartWorkService(
    new StartWorkService({
      store,
      projects: {
        rootWithin: async (dir: string) => (dir.startsWith(DORKOS.root) ? DORKOS.root : null),
        listForExtension: async () => [DORKOS],
        list: async () => [DORKOS],
      },
      extensionName: () => 'Flow',
      runningSessionIds: () => [],
      // The runtime with accounts, and the real account check (the default).
      defaultRuntime: () => 'claude-code',
      rename: async () => undefined,
    })
  );
  const manager = {
    get: (id: string) =>
      id === 'flow'
        ? { id, status: 'active', manifest: { id, name: 'Flow', version: '1.0.0' } }
        : undefined,
    listPublic: () => [],
  };
  const app = express();
  app.use(express.json());
  app.use(
    '/api/extensions',
    createExtensionsRouter(manager as never, '/tmp/unused', () => null)
  );
  target.mount(app);
});

afterEach(() => {
  setStartWorkService(undefined);
});

const SENTENCE = /No account is allowed to work in dorkos\./;

describe('starting work where no account may work', () => {
  it('refuses ctx.sessions.start with account_not_allowed_here, and launches nothing', async () => {
    const dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'start-work-eligibility-'));
    const { ctx, releaseListeners } = createDataProviderContext({
      extensionId: 'flow',
      extensionDir: dorkHome,
      dorkHome,
      extensionName: 'Flow',
    });
    try {
      const err = await ctx.sessions.start(INPUT).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'account_not_allowed_here', name: 'StartWorkError' });
      expect((err as Error).message).toMatch(SENTENCE);
    } finally {
      releaseListeners();
      fs.rmSync(dorkHome, { recursive: true, force: true });
    }
    expect(launches).toHaveLength(0);
    expect(store.countSince('flow', '1970-01-01T00:00:00.000Z')).toBe(0);
  });

  it('refuses api.startWork’s route with 409 account_not_allowed_here, and launches nothing', async () => {
    const res = await request(server).post('/api/extensions/flow/start-work').send(INPUT);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('account_not_allowed_here');
    expect(res.body.error).toMatch(SENTENCE);
    expect(launches).toHaveLength(0);
    expect(store.countSince('flow', '1970-01-01T00:00:00.000Z')).toBe(0);
  });

  it('starts once the project may use an account', async () => {
    rules.claudeCode = {
      ...rules.claudeCode,
      projectAccounts: { [DORKOS.root]: { allow: ['work'] } },
    };
    const res = await request(server).post('/api/extensions/flow/start-work').send(INPUT);

    expect(res.status).toBe(200);
    expect(launches).toHaveLength(1);
  });
});
