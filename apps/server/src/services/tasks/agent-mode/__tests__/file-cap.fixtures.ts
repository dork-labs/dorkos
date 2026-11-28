/**
 * Shared setup for the file-cap suites (DOR-3703, Security's ruling of Nov 3,
 * round 6): a real store, a real reconciler over an agent's skills folder and a
 * global one, a real audit trail, and helpers that edit a SKILL file behind the
 * task tools and read the task as its next run would run it.
 *
 * The module mocks live here, once, so every piece shares them: importing this
 * file first registers them before the modules under test load.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { MeshCore } from '@dorkos/mesh';
import type { StreamEvent, Task } from '@dorkos/shared/types';

// Hoisted state cannot be exported directly, so it is exported below by reference.
const hoisted = vi.hoisted(() => ({
  flag: { on: true },
  notices: [] as Record<string, unknown>[],
}));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'tasks' ? { agentModeControl: hoisted.flag.on } : undefined),
  },
}));
vi.mock('../../../notifications/emitters/schedule-armed.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../notifications/emitters/schedule-armed.js')>()),
  postScheduleArmed: async (payload: Record<string, unknown>) => {
    hoisted.notices.push(payload);
    return true;
  },
}));

import { TaskStore } from '../../task-store.js';
import { TaskRegistrar } from '../../task-registrar.js';
import { TaskReconciler } from '../../task-reconciler.js';
import { ScheduleIdentityRegistry } from '../../schedule-identity.js';
import { FakeScheduler } from '../../__tests__/fake-scheduler.js';
import { skillsRoot } from '../../__tests__/task-root-fixtures.js';
import { capRunIfFileChanged } from '../file-cap/run-cap.js';
import { AuditLog } from '../../../audit/audit-log.js';
import { AccountIds } from '../../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../../audit/audit-trail.js';
import { TaskSchedulerService } from '../../task-scheduler-service.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { isTerminalRunStatus } from '../../lifecycle/run-statuses.js';
import { initBoundary } from '../../../../lib/boundary.js';
import { onRuntime, type RuntimeDouble } from '../../__tests__/support/runtime-task-turns.js';

/** The experiment's switch, flipped per test. */
export const flag = hoisted.flag;
/** Every `schedule.armed_by_agent` notice posted, as its payload. */
export const notices = hoisted.notices;

/** A SKILL.md with a schedule. */
export const skill = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name}\nschedule:\n  cron: '0 3 * * *'\n  permissions: acceptEdits\n---\n${body}`;

/** The live handles for the current test, replaced before each one. */
export const env = {} as {
  tmp: string;
  /** The agent's folder (`agent-a`). */
  home: string;
  globalDir: string;
  store: TaskStore;
  auditDb: Db;
  meshCore: MeshCore;
};

/** Register the per-test setup and teardown. */
export function useFileCapEnv(): void {
  beforeEach(async () => {
    flag.on = true;
    notices.length = 0;
    env.tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'file-cap-')));
    env.home = path.join(env.tmp, 'agents', 'a');
    env.globalDir = path.join(env.tmp, 'global-skills');
    await fs.mkdir(path.join(env.home, '.agents', 'skills'), { recursive: true });
    await fs.mkdir(env.globalDir, { recursive: true });
    const db = createTestDb();
    env.store = new TaskStore(db);
    runtimeRegistry.setDb(db);
    env.meshCore = {
      getProjectPath: (id: string) => (id === 'agent-a' ? env.home : undefined),
    } as never;
    env.auditDb = createTestDb();
    initAuditTrail({
      log: new AuditLog(env.auditDb),
      accounts: new AccountIds({
        db: env.auditDb,
        installId: 'inst',
        readOwnerAccount: () => null,
      }),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetAuditTrail();
    env.store.close();
    await fs.rm(env.tmp, { recursive: true, force: true });
  });
}

/** One reconcile pass over the agent's skills and the global ones. */
export async function reconcile(): Promise<void> {
  const { store } = env;
  const rec = new TaskReconciler(
    store,
    new TaskRegistrar({ store, scheduler: new FakeScheduler() }),
    new ScheduleIdentityRegistry()
  );
  rec.addRoot(skillsRoot(path.join(env.home, '.agents', 'skills'), 'project', env.home, 'agent-a'));
  rec.addRoot(skillsRoot(env.globalDir, 'global'));
  try {
    await rec.reconcile();
  } finally {
    rec.stop();
  }
}

/** A task a person approved, live, from a file in the agent's folder or the global one. */
export async function approvedTask(
  where: 'agent' | 'global' = 'agent',
  name = 'sweep'
): Promise<string> {
  const dir = path.join(
    where === 'agent' ? path.join(env.home, '.agents', 'skills') : env.globalDir,
    name
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), skill(name, 'sweep the backlog'));
  await reconcile();
  const task = env.store.getTasks().find((t) => t.name === name)!;
  env.store.approvals.recordApproval(task.id);
  env.store.approvals.recordPersonApproval(task.id);
  await reconcile();
  expect(env.store.getTask(task.id)?.status).toBe('active');
  return task.id;
}

/** Rewrite the task's SKILL file behind the task tools. */
export async function rawEdit(id: string, body: string, name = 'sweep'): Promise<void> {
  await fs.writeFile(env.store.getTask(id)!.filePath!, skill(name, body));
}

/** The task as its next run would run it. */
export async function nextRun(id: string, ordinary = true) {
  const { store } = env;
  const run = store.createRun(id, 'scheduled');
  const ran = await capRunIfFileChanged(
    store.getTask(id)!,
    run,
    store,
    env.meshCore,
    undefined,
    async () => ordinary
  );
  return { ran, run: store.getRun(run.id)! };
}

/** A fake runtime manager that records what each turn was sent. */
export function fakeAgentManager(events: StreamEvent[] = []) {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(async function* () {
      for (const event of events) yield event;
    }),
    interruptQuery: vi.fn().mockResolvedValue(true),
    getInternalSessionId: vi.fn(() => undefined),
    acquireLock: vi.fn(() => true),
    releaseLock: vi.fn(),
  } as unknown as RuntimeDouble;
}

/** Fire the task's schedule once through the real dispatch, and wait for the run to end. */
export async function fire(
  id: string,
  agentManager: RuntimeDouble,
  at = '2023-11-14T03:00:00.000Z'
) {
  const { store } = env;
  await initBoundary('/');
  const service = new TaskSchedulerService({
    store,
    ...onRuntime(agentManager),
    config: { maxConcurrentRuns: 5, retentionCount: 100, mayFire: true, firingReason: 'test' },
    meshCore: env.meshCore,
  });
  const dispatch = (service as unknown as { dispatch(t: Task, at: Date): Promise<void> }).dispatch;
  await dispatch.call(service, store.getTask(id)!, new Date(at));
  const run = store.listRuns({ taskId: id })[0]!;
  await vi.waitFor(() => expect(isTerminalRunStatus(store.getRun(run.id)!.status)).toBe(true));
  await service.stop();
  return store.getRun(run.id)!;
}
