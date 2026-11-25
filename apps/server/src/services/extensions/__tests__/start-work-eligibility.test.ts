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
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StartTurnInput } from '@dorkos/shared/turn-port';
import { createRunRecord, type RunRecord } from '../../runs/index.js';
import type { ProjectInfo } from '@dorkos/extension-api/server';
import { createExtensionsRoutes } from '../../../routes/extensions.js';
import { honoGroupListener } from '../../../http/__tests__/hono-group-listener.js';
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
let record: RunRecord;
/** Every start the turn port was asked for. */
let launches: StartTurnInput[];

beforeEach(() => {
  const db = createTestDb();
  record = createRunRecord(db, { epoch: '01BOOTEPOCHROUTESTART00000' });
  launches = [];
  const start = record.port.start.bind(record.port);
  vi.spyOn(record.port, 'start').mockImplementation((input) => {
    launches.push(input);
    return start(input);
  });
  rules.claudeCode = {
    accounts: [{ id: 'work', path: '/accounts/work', label: 'Work', onlyProjects: null }],
    defaultAccountOnlyProjects: null,
    // dorkos may use no account at all.
    projectAccounts: { [DORKOS.root]: { allow: [] } },
  };
  store = new SessionStartedByStore(createTestDb());
  setStartWorkService(
    new StartWorkService({
      port: () => record.port,
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
  target.mount(
    honoGroupListener({
      path: '/api/extensions',
      routes: createExtensionsRoutes({
        manager: manager as never,
        dorkHome: '/tmp/unused',
        getCwd: () => null,
      }),
    })
  );
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

  it('refuses api.startWork’s route with 409 conflict (account_not_allowed_here), and launches nothing', async () => {
    const res = await request(server).post('/api/extensions/flow/start-work').send(INPUT);

    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ code: 'account_not_allowed_here' });
    // A fixed sentence: the service's own words name the project, so they stay in the log.
    expect(res.body.detail).toMatch(/^That account can’t be used in this pr/);
    expect(res.body.detail).not.toMatch(SENTENCE);
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
