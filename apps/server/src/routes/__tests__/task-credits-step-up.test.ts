/** Persistent scheduled-task spending cannot be enabled by the browser cookie alone. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as creation from '../../services/tasks/lifecycle/create-task.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import { createTasksRoutes } from '../tasks.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';
import { taskRuntimeCapabilitiesFixture } from './fixtures/task-runtime-capabilities.js';

taskRuntimeCapabilitiesFixture();
describe('scheduled task credits confirmation', () => {
  let store: TaskStore;
  const home = mkdtempSync(path.join(tmpdir(), 'credits-step-up-'));
  const scheduler = {
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    getNextRun: () => null,
    previewNextRuns: () => [],
    getActiveRunCount: () => 0,
    isRegistered: () => false,
  } as unknown as TaskSchedulerService;
  const owner = frontDoorStepUpHarness(() => {
    store = new TaskStore(owner.db());
    return [
      {
        path: '/api/tasks',
        routes: createTasksRoutes({
          store,
          scheduler,
          registrar: new TaskRegistrar({ store, scheduler }),
          defaultTimezone: () => 'UTC',
          dorkHome: home,
        }),
      },
    ];
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.spyOn(creation, 'createScheduledTask').mockImplementation(async (_deps, options) => ({
      ok: true,
      parked: false,
      task: store.createTask({
        name: `confirmed-task-${store.getTasks().length}`,
        description: 'Check stock.',
        prompt: 'Check stock.',
        cron: '0 9 * * *',
        account: options.input.account,
        filePath: path.join(home, 'created', 'SKILL.md'),
      }),
    }));
  });
  it.each(['direct', 'own-tunnel', 'managed'] as const)(
    'holds creating credits spending from %s',
    async (via) => {
      const held = await owner.call('post', '/api/tasks', via).send({
        name: 'check-stock',
        prompt: 'Check stock.',
        cron: '0 9 * * *',
        account: 'dorkos-credits',
      });
      expect(held.status).toBe(428);
      expect(creation.createScheduledTask).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
        'not-your-action'
      );
      expect(creation.createScheduledTask).not.toHaveBeenCalled();
      const confirmed = await owner.confirm(held.body.heldActionId, via);
      expect(confirmed.body).toMatchObject({
        ok: true,
        status: 201,
        result: { account: 'dorkos-credits' },
      });
      expect(creation.createScheduledTask).toHaveBeenCalledOnce();
    }
  );
  it('refuses Wi-Fi and program credentials before holding', async () => {
    for (const via of ['wifi', 'own-tunnel'] as const) {
      const request = owner.call('post', '/api/tasks', via);
      if (via === 'own-tunnel') {
        const held = await owner
          .call('post', '/api/auth/api-key/create', via)
          .send({ name: 'Task test' });
        expect(held.status).toBe(428);
        const confirmed = await owner.confirm(held.body.heldActionId, via);
        request.set('Authorization', `Bearer ${confirmed.body.result.key}`).set('Cookie', '');
      }
      const response = await request.send({
        name: 'check-stock',
        prompt: 'Check stock.',
        cron: '0 9 * * *',
        account: 'dorkos-credits',
      });
      expect(response.status).toBe(403);
      expect(response.body.heldActionId).toBeUndefined();
    }
    expect(creation.createScheduledTask).not.toHaveBeenCalled();
  });
  it('binds a credits re-enable to the task that was shown', async () => {
    const dir = path.join(home, 'nightly');
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'SKILL.md');
    writeFileSync(
      filePath,
      "---\nname: nightly\ndescription: Check stock\nschedule:\n  cron: '0 9 * * *'\n  enabled: false\n---\nCheck stock.\n"
    );
    const task = store.createTask({
      name: 'nightly',
      description: 'Check stock.',
      prompt: 'Check stock.',
      cron: '0 9 * * *',
      enabled: false,
      account: 'dorkos-credits',
      filePath,
    });
    const held = await owner
      .call('patch', `/api/tasks/${task.id}`, 'own-tunnel')
      .send({ enabled: true });
    expect(held.status).toBe(428);
    expect(store.getTask(task.id)?.enabled).toBe(false);
    store.updateTask(task.id, { prompt: 'Different work.' });
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      status: 409,
      result: { code: 'TASK_CHANGED' },
    });
    expect(store.getTask(task.id)?.enabled).toBe(false);
  });
  it('does not hold an ordinary task create', async () => {
    const response = await owner
      .call('post', '/api/tasks')
      .send({ name: 'check-stock', prompt: 'Check stock.', cron: '0 9 * * *' });
    expect(response.status).toBe(201);
  });
});
