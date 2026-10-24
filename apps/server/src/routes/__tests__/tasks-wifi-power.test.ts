/**
 * From Wi-Fi a schedule runs at Default at most (DOR-3037): one made there
 * with no mode gets Default rather than the operator's trust stop, naming a
 * mode above Default is refused, and so is approving, editing or running now a
 * schedule that runs above Default. Pausing one and lowering its mode stay
 * allowed. At this computer nothing changes.
 *
 * The operator sits at Full autonomy, so a schedule that names no mode would
 * otherwise be made at `bypassPermissions`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { CLAUDE_CODE_CAPABILITIES } from '../../services/runtimes/claude-code/runtime-constants.js';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => {
      if (key === 'auth') return { enabled: false };
      if (key === 'runtimes')
        return { ...USER_CONFIG_DEFAULTS.runtimes, defaultTrustStop: 'autonomy' };
      return undefined;
    },
  },
}));
vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    getNativeSessionCwd: vi.fn(() => null),
    getDefaultType: () => 'claude-code',
    has: (type: string) => type === 'claude-code',
    getAllCapabilities: () => ({ 'claude-code': CLAUDE_CODE_CAPABILITIES }),
  },
}));
vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: vi.fn().mockResolvedValue(true),
}));

import { createTasksRoutes } from '../tasks.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import { NOT_FROM_WIFI } from '../../services/core/auth/sessions/wifi-level.js';
import { WIFI_RAISE_REFUSAL } from '../../services/core/auth/sessions/wifi-raise-guard.js';

const target = swappableServer();
const server = target.server;
let store: TaskStore;
let scheduler: TaskSchedulerService;
let dorkHome: string;

/** A schedule's body, with whatever a case adds. */
function body(overrides: Record<string, unknown> = {}) {
  return {
    name: `nightly-${Math.random().toString(36).slice(2, 8)}`,
    description: 'sweep the repo',
    prompt: 'sweep it',
    cron: '0 3 * * *',
    target: 'global',
    ...overrides,
  };
}

/** Make a schedule at this computer, at `permissionMode`, and return its id. */
async function madeHere(permissionMode: string): Promise<string> {
  const res = await request(server).post('/api/tasks').send(body({ permissionMode }));
  expect(res.status).toBe(201);
  return res.body.id as string;
}

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-task-wifi-'));
  store = new TaskStore(createTestDb());
  scheduler = {
    isStarted: true,
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    triggerManualRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
    cancelRun: vi.fn().mockResolvedValue({ state: 'not_found' }),
    getNextRun: vi.fn().mockReturnValue(null),
    previewNextRuns: vi.fn().mockReturnValue([]),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as TaskSchedulerService;
  target.mount(
    honoGroupListener(
      {
        path: '/api/tasks',
        routes: createTasksRoutes({
          store,
          scheduler,
          registrar: new TaskRegistrar({ store, scheduler }),
          dorkHome,
        }),
      },
      {
        before: async (c, next) => {
          // A Wi-Fi sign-in is always a session cookie.
          if (c.req.header('x-test-via') === 'wifi') {
            markIngress(c.env.incoming, 'wifi');
            c.set('user', { userId: 'owner', credential: 'cookie' });
          }
          await next();
        },
      }
    )
  );
});

afterEach(() => {
  store.close();
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

const REFUSED = { error: WIFI_RAISE_REFUSAL, code: NOT_FROM_WIFI };

describe('making a schedule from Wi-Fi', () => {
  it('gives one that names no mode Default, not the operator’s Full autonomy', async () => {
    const wifi = await request(server).post('/api/tasks').set('x-test-via', 'wifi').send(body());
    expect(wifi.status).toBe(201);
    expect(store.getTask(wifi.body.id)?.permissionMode).toBe('default');

    const here = await request(server).post('/api/tasks').send(body());
    expect(store.getTask(here.body.id)?.permissionMode).toBe('bypassPermissions');
  });

  it('refuses a mode above Default, and takes Plan', async () => {
    const raise = await request(server)
      .post('/api/tasks')
      .set('x-test-via', 'wifi')
      .send(body({ permissionMode: 'acceptEdits' }));
    expect(raise.status).toBe(403);
    expect(raise.body).toEqual(REFUSED);
    expect(store.getTasks()).toHaveLength(0);

    const lower = await request(server)
      .post('/api/tasks')
      .set('x-test-via', 'wifi')
      .send(body({ permissionMode: 'plan' }));
    expect(lower.status).toBe(201);
  });
});

describe('changing a schedule from Wi-Fi', () => {
  it('refuses raising its mode, and takes lowering it', async () => {
    const id = await madeHere('default');
    const raise = await request(server)
      .patch(`/api/tasks/${id}`)
      .set('x-test-via', 'wifi')
      .send({ permissionMode: 'bypassPermissions' });
    expect(raise.status).toBe(403);
    expect(raise.body).toEqual(REFUSED);
    expect(store.getTask(id)?.permissionMode).toBe('default');

    const full = await madeHere('bypassPermissions');
    const lower = await request(server)
      .patch(`/api/tasks/${full}`)
      .set('x-test-via', 'wifi')
      .send({ permissionMode: 'default' });
    expect(lower.status).toBe(200);
    expect(store.getTask(full)?.permissionMode).toBe('default');
  });

  it('refuses rewording or approving one that runs above Default, and takes pausing it', async () => {
    const id = await madeHere('bypassPermissions');
    const reword = await request(server)
      .patch(`/api/tasks/${id}`)
      .set('x-test-via', 'wifi')
      .send({ prompt: 'delete everything' });
    expect(reword.status).toBe(403);
    const approve = await request(server)
      .patch(`/api/tasks/${id}`)
      .set('x-test-via', 'wifi')
      .send({ status: 'active' });
    expect(approve.status).toBe(403);

    const pause = await request(server)
      .patch(`/api/tasks/${id}`)
      .set('x-test-via', 'wifi')
      .send({ enabled: false });
    expect(pause.status).toBe(200);
  });
});

describe('running a schedule now from Wi-Fi', () => {
  it('refuses one that runs above Default, and runs one at Default', async () => {
    const full = await madeHere('bypassPermissions');
    const refused = await request(server)
      .post(`/api/tasks/${full}/trigger`)
      .set('x-test-via', 'wifi');
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual(REFUSED);
    expect(scheduler.triggerManualRun).not.toHaveBeenCalled();

    const plain = await madeHere('default');
    const ran = await request(server).post(`/api/tasks/${plain}/trigger`).set('x-test-via', 'wifi');
    expect(ran.status).not.toBe(403);
    expect(scheduler.triggerManualRun).toHaveBeenCalledWith(plain);
  });

  it('runs one above Default at this computer', async () => {
    const full = await madeHere('bypassPermissions');
    await request(server).post(`/api/tasks/${full}/trigger`);
    expect(scheduler.triggerManualRun).toHaveBeenCalledWith(full);
  });
});
