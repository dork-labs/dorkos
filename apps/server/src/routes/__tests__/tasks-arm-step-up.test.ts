/**
 * A person letting a scheduled task do more on its own waits for the owner to
 * confirm it's them (DOR-4355): a looser mode, an approval above Default, a new
 * task looser than Default, approving a changed file, or an Undo that puts back
 * a looser mode. Lowering and pausing stay immediate.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@dorkos/shared/schemas';
import * as creation from '../../services/tasks/lifecycle/create-task.js';
import * as fileCap from '../../services/tasks/agent-mode/file-cap/file-cap-person.js';
import * as undo from '../../services/tasks/agent-mode/agent-mode-undo.js';
import * as notifications from '../../services/notifications/notification-service.js';
import { agentModeRecordText } from '../../services/tasks/agent-mode/agent-mode-record-field.js';
import { taskReviewRevision } from '../../services/tasks/approvals/person-review.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import { createTasksRoutes } from '../tasks.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';
import { taskRuntimeCapabilitiesFixture } from './fixtures/task-runtime-capabilities.js';

taskRuntimeCapabilitiesFixture();
describe('letting a scheduled task do more waits for the owner', () => {
  let store: TaskStore;
  const home = mkdtempSync(path.join(tmpdir(), 'tasks-arm-step-up-'));
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
  beforeEach(() => resetHeldStepUpsForTests());
  afterEach(() => vi.restoreAllMocks());

  /** A Northwind stock check with its SKILL file, at the given mode and status. */
  function northwindTask(
    permissionMode: Task['permissionMode'],
    status: 'active' | 'pending_approval' = 'active'
  ): Task {
    const name = `northwind-${store.getTasks().length}`;
    const dir = path.join(home, name);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, 'SKILL.md');
    writeFileSync(
      filePath,
      `---\nname: ${name}\ndescription: Check Northwind stock\nschedule:\n  cron: '0 9 * * *'\n---\nCheck Northwind stock.\n`
    );
    const task = store.createTask({
      name,
      description: 'Check Northwind stock.',
      prompt: 'Check Northwind stock.',
      cron: '0 9 * * *',
      permissionMode,
      filePath,
    });
    return status === 'active' ? task : (store.updateTask(task.id, { status }) ?? task);
  }

  it('holds a looser mode until the owner confirms it', async () => {
    const task = northwindTask('default');
    const held = await owner
      .call('patch', `/api/tasks/${task.id}`, 'own-tunnel')
      .send({ permissionMode: 'acceptEdits' });
    expect(held.status).toBe(428);
    expect(store.getTask(task.id)?.permissionMode).toBe('default');
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(store.getTask(task.id)?.permissionMode).toBe('default');
    const confirmed = await owner.confirm(held.body.heldActionId, 'own-tunnel');
    expect(confirmed.body).toMatchObject({ ok: true, status: 200 });
    expect(store.getTask(task.id)?.permissionMode).toBe('acceptEdits');
  });

  it('holds approving a schedule above Default, and stamps the confirming owner', async () => {
    const task = northwindTask('acceptEdits', 'pending_approval');
    const held = await owner.call('patch', `/api/tasks/${task.id}`).send({
      status: 'active',
      expectedApprovalRevision: taskReviewRevision(store.getTask(task.id)!),
    });
    expect(held.status).toBe(428);
    expect(store.getTask(task.id)?.status).toBe('pending_approval');
    const confirmed = await owner.confirm(held.body.heldActionId);
    expect(confirmed.body).toMatchObject({ ok: true, status: 200, result: { status: 'active' } });
    expect(store.getTask(task.id)).toMatchObject({
      status: 'active',
      approvedBy: { kind: 'person', userId: expect.any(String) },
    });
  });

  it('keeps a Wi-Fi raise refused, with nothing held', async () => {
    const task = northwindTask('default');
    const res = await owner
      .call('patch', `/api/tasks/${task.id}`, 'wifi')
      .send({ permissionMode: 'bypassPermissions' });
    expect(res.status).toBe(403);
    expect(res.body.heldActionId).toBeUndefined();
    expect(store.getTask(task.id)?.permissionMode).toBe('default');
  });

  it.each([{ permissionMode: 'default' }, { enabled: false }])(
    'applies a lower or paused schedule at once: %j',
    async (patch) => {
      const task = northwindTask('acceptEdits');
      const res = await owner.call('patch', `/api/tasks/${task.id}`, 'own-tunnel').send(patch);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.heldActionId).toBeUndefined();
      expect(store.getTask(task.id)).toMatchObject(patch);
    }
  );

  describe('a new schedule', () => {
    beforeEach(() => {
      vi.spyOn(creation, 'createScheduledTask').mockImplementation(async (_deps, options) => ({
        ok: true,
        parked: false,
        task: store.createTask({
          name: `created-${store.getTasks().length}`,
          description: 'Check Northwind stock.',
          prompt: 'Check Northwind stock.',
          cron: '0 9 * * *',
          permissionMode: options.input.permissionMode ?? 'default',
          filePath: path.join(home, 'created', 'SKILL.md'),
        }),
      }));
    });
    const body = { name: 'check-stock', prompt: 'Check Northwind stock.', cron: '0 9 * * *' };

    it('holds one looser than Default until the owner confirms it', async () => {
      const held = await owner
        .call('post', '/api/tasks', 'managed')
        .send({ ...body, permissionMode: 'bypassPermissions' });
      expect(held.status).toBe(428);
      expect(creation.createScheduledTask).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, 'managed', true)).body.code).toBe(
        'not-your-action'
      );
      expect(creation.createScheduledTask).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, 'managed')).body).toMatchObject({
        ok: true,
        status: 201,
        result: { permissionMode: 'bypassPermissions' },
      });
      expect(creation.createScheduledTask).toHaveBeenCalledOnce();
    });

    it('makes one at Default at once', async () => {
      const res = await owner
        .call('post', '/api/tasks', 'own-tunnel')
        .send({ ...body, permissionMode: 'default' });
      expect(res.status).toBe(201);
      expect(res.body.heldActionId).toBeUndefined();
    });
  });

  it('holds approving a changed file until the owner confirms it', async () => {
    const task = northwindTask('acceptEdits');
    const approve = vi
      .spyOn(fileCap, 'approveCappedFile')
      .mockImplementation(async () => ({ ok: true, task: store.getTask(task.id)! }));
    const held = await owner
      .call('post', `/api/tasks/${task.id}/approve-file`, 'own-tunnel')
      .send({ capAt: '2026-11-03T03:00:00.000Z', hash: 'sha256:northwind' });
    expect(held.status).toBe(428);
    expect(approve).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(approve).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 200,
    });
    expect(approve).toHaveBeenCalledExactlyOnceWith(
      store,
      task.id,
      '2026-11-03T03:00:00.000Z',
      'sha256:northwind'
    );
  });

  describe('undoing an agent’s mode change', () => {
    /** A task an agent moved from `previousMode` to `mode`, and the notice naming it. */
    function agentMoved(previousMode: Task['permissionMode'], mode: Task['permissionMode']) {
      const task = northwindTask(mode);
      const at = new Date().toISOString();
      store.approvals.recordAgentModeChange(
        task.id,
        agentModeRecordText({
          kind: 'set_mode',
          agentPath: '/northwind/agent',
          at,
          mode,
          previousMode,
        })
      );
      vi.spyOn(notifications, 'storedNotificationPayload').mockImplementation((id) =>
        id === 'northwind-notice'
          ? { kind: 'schedule.armed_by_agent', payload: { taskId: task.id, modeChange: { at } } }
          : null
      );
      const restore = vi.spyOn(undo, 'undoAgentModeChange').mockImplementation(async () => ({
        ok: true,
        task: store.getTask(task.id)!,
        restored: previousMode,
      }));
      return { task, restore };
    }

    it('holds putting back a looser mode until the owner confirms it', async () => {
      const { task, restore } = agentMoved('acceptEdits', 'default');
      const held = await owner
        .call('post', `/api/tasks/${task.id}/undo-agent-mode`, 'own-tunnel')
        .send({ notificationId: 'northwind-notice' });
      expect(held.status).toBe(428);
      expect(restore).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
        'not-your-action'
      );
      expect(restore).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
        ok: true,
        status: 200,
      });
      expect(restore).toHaveBeenCalledOnce();
    });

    it('puts back a stricter mode at once', async () => {
      const { task, restore } = agentMoved('acceptEdits', 'bypassPermissions');
      const res = await owner
        .call('post', `/api/tasks/${task.id}/undo-agent-mode`, 'own-tunnel')
        .send({ notificationId: 'northwind-notice' });
      expect(res.status).toBe(200);
      expect(res.body.heldActionId).toBeUndefined();
      expect(restore).toHaveBeenCalledOnce();
    });
  });
});
