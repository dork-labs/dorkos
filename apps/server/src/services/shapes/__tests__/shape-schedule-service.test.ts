/**
 * Integration tests for {@link ShapeScheduleService} against a real in-memory
 * TaskStore + a real tmpdir on disk (fakes only for the scheduler + mesh).
 *
 * The load-bearing behavior is `rebindSchedule`: a global/disabled schedule must
 * physically move from the global `tasks/` dir into the agent's `.dork/tasks/`,
 * flip enabled, register with the scheduler, and leave exactly one schedule
 * (no orphaned global duplicate). This is what turns a Shape's tick on when its
 * agent is finally created.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MeshCore } from '@dorkos/mesh';
import type { Logger } from '@dorkos/shared/logger';
import type { CreateTaskRequest } from '@dorkos/shared/schemas';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { TaskStore } from '../../tasks/task-store.js';
import type { TaskSchedulerService } from '../../tasks/task-scheduler-service.js';
import { ShapeScheduleService } from '../shape-schedule-service.js';

/** A global, disabled inbox-tick request (agent missing at apply time). */
function globalDisabledTick(): CreateTaskRequest {
  return {
    name: 'inbox-tick',
    description: 'poll the inbox',
    prompt: 'run one tick',
    cron: '*/15 * * * *',
    timezone: null,
    target: 'global',
    enabled: false,
    permissionMode: 'acceptEdits',
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('ShapeScheduleService.rebindSchedule (integration)', () => {
  let db: Db;
  let store: TaskStore;
  let dorkHome: string;
  let agentDir: string;
  let registerTask: ReturnType<typeof vi.fn>;
  let unregisterTask: ReturnType<typeof vi.fn>;
  let scheduler: TaskSchedulerService;
  let service: ShapeScheduleService;

  beforeEach(async () => {
    db = createTestDb();
    store = new TaskStore(db);
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dork-shape-sched-'));
    agentDir = path.join(dorkHome, 'agents', 'linear-tender');
    await fs.mkdir(agentDir, { recursive: true });

    registerTask = vi.fn();
    unregisterTask = vi.fn();
    scheduler = { registerTask, unregisterTask } as unknown as TaskSchedulerService;

    const meshCore = {
      getProjectPath: (id: string) => (id === 'agent-tender' ? agentDir : undefined),
    } as unknown as MeshCore;

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;

    service = new ShapeScheduleService({ taskStore: store, scheduler, meshCore, dorkHome, logger });
  });

  afterEach(async () => {
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  it('moves a global/disabled schedule to the agent, enables it, and removes the old copy', async () => {
    await service.createSchedule(globalDisabledTick());

    // Precondition: one global, disabled schedule, on disk at the global path.
    expect(service.listSchedules()).toEqual([
      { name: 'inbox-tick', agentId: null, enabled: false },
    ]);
    const globalFile = path.join(dorkHome, 'tasks', 'inbox-tick', 'SKILL.md');
    expect(await exists(globalFile)).toBe(true);
    expect(registerTask).not.toHaveBeenCalled(); // disabled → never registered

    // The agent is created; re-bind the waiting schedule to it.
    await service.rebindSchedule('inbox-tick', { agentId: 'agent-tender', enabled: true });

    // Exactly one schedule remains — now agent-bound and enabled.
    const after = service.listSchedules();
    expect(after).toEqual([{ name: 'inbox-tick', agentId: 'agent-tender', enabled: true }]);
    expect(store.getTasks()).toHaveLength(1);

    // The file physically moved into the agent's workspace; the global copy is gone.
    const agentFile = path.join(agentDir, '.dork', 'tasks', 'inbox-tick', 'SKILL.md');
    expect(await exists(agentFile)).toBe(true);
    expect(await exists(globalFile)).toBe(false);

    // The newly-enabled schedule was registered; the old copy was unregistered.
    expect(registerTask).toHaveBeenCalledTimes(1);
    expect(registerTask.mock.calls[0][0]).toMatchObject({
      name: 'inbox-tick',
      agentId: 'agent-tender',
      enabled: true,
    });
    expect(unregisterTask).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on a schedule that is already agent-bound (respects a user disable)', async () => {
    // Seed a schedule already living in the agent's workspace but disabled.
    await service.createSchedule({ ...globalDisabledTick(), target: 'agent-tender' });
    const seeded = service.listSchedules();
    expect(seeded).toEqual([{ name: 'inbox-tick', agentId: 'agent-tender', enabled: false }]);

    await service.rebindSchedule('inbox-tick', { agentId: 'agent-tender', enabled: true });

    // Untouched — still bound, still disabled.
    expect(service.listSchedules()).toEqual([
      { name: 'inbox-tick', agentId: 'agent-tender', enabled: false },
    ]);
    expect(store.getTasks()).toHaveLength(1);
    expect(registerTask).not.toHaveBeenCalled();
  });

  it('leaves the schedule global when the agent has no resolvable project path', async () => {
    await service.createSchedule(globalDisabledTick());

    // 'ghost' resolves to no project path → the fake meshCore returns undefined.
    await service.rebindSchedule('inbox-tick', { agentId: 'ghost', enabled: true });

    // Unchanged: still global, still disabled, no duplicate.
    expect(service.listSchedules()).toEqual([
      { name: 'inbox-tick', agentId: null, enabled: false },
    ]);
    expect(store.getTasks()).toHaveLength(1);
    expect(await exists(path.join(dorkHome, 'tasks', 'inbox-tick', 'SKILL.md'))).toBe(true);
  });
});
