/**
 * Approval receipts for scheduled tasks (DOR-3641).
 *
 * Exercises the real create and PATCH routes over a real task file and store.
 * The stamp is a security record: every activation path must persist it, and
 * the Activity row must repeat the exact same values.
 *
 * @module routes/__tests__/tasks-approval-receipt
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { pulseSchedules, type Db } from '@dorkos/db';
import { eq } from 'drizzle-orm';
import { createTasksRoutes } from '../tasks.js';
import { personTaskApprover } from '../task-approval-actor.js';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../services/runtimes/claude-code/runtime-constants.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';
import type { ActivityService } from '../../services/activity/activity-service.js';
import type { ApiEnv } from '../../http/api-chain.js';
import type { Task } from '@dorkos/shared/types';

/** What these routes answer: a task, or a list of them for GET `/`. */
type ResponseBody = Partial<Task> & Record<string, unknown> & Pick<Task[], 'find'>;

describe('scheduled task approval receipts', () => {
  beforeAll(() => {
    // The real registry, holding one runtime that declares Claude Code's modes,
    // so an approval is judged against the modes a real install offers.
    const runtime = new FakeAgentRuntime('claude-code');
    runtime.getCapabilities.mockReturnValue(CLAUDE_CODE_CAPABILITIES);
    runtimeRegistry.register(runtime);
    runtimeRegistry.setDefault('claude-code');
  });

  let store: TaskStore;
  let db: Db;
  let dorkHome: string;
  let emitted: Array<Record<string, unknown>>;
  let routes: Hono<ApiEnv>;

  beforeEach(async () => {
    db = createTestDb();
    store = new TaskStore(db);
    dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'task-receipt-')));
    // The real config, in a throwaway home: login off, Careful, and the
    // owner's saved name, which a receipt may only use while login is off.
    initConfigManager(dorkHome);
    configManager.set('permissions', { ...configManager.get('permissions'), preset: 'careful' });
    configManager.set('profile', { ...configManager.get('profile'), displayName: 'Dorian' });
    emitted = [];
    const scheduler = {
      registerTask: vi.fn(),
      unregisterTask: vi.fn(),
      getNextRun: vi.fn().mockReturnValue(null),
      previewNextRuns: vi.fn().mockReturnValue([]),
      isRegistered: vi.fn().mockReturnValue(false),
    } as unknown as TaskSchedulerService;
    const activity = {
      emit: vi.fn((event: Record<string, unknown>) => emitted.push(event)),
    } as unknown as ActivityService;
    routes = new Hono<ApiEnv>();
    routes.use('*', async (c, next) => {
      c.set('user', { userId: 'user-1', credential: 'cookie' });
      if (c.req.method !== 'GET') c.set('body', await c.req.json());
      return next();
    });
    routes.route(
      '/',
      createTasksRoutes({
        store,
        scheduler,
        registrar: new TaskRegistrar({ store, scheduler }),
        dorkHome,
        activity,
      })
    );
  });

  /** Call the route without opening a network listener. */
  async function call(
    path: string,
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    body?: Record<string, unknown>,
    agent?: string
  ) {
    const headers = {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(agent ? { 'x-dorkos-agent': agent } : {}),
    };
    const incoming = {
      headers,
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as IncomingMessage;
    const response = await routes.request(
      path,
      {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      { incoming }
    );
    return { status: response.status, body: (await response.json()) as ResponseBody };
  }

  afterEach(async () => {
    store.close();
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  /** Make one agent proposal that waits for the operator. */
  async function parked(name: string, enabled = true) {
    const response = await call(
      '/',
      'POST',
      {
        name,
        description: name,
        prompt: `Run ${name}.`,
        cron: '0 3 * * *',
        target: 'global',
        enabled,
        reason: `${name} should run overnight.`,
      },
      'unresolved-agent-token'
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({
      status: 'pending_approval',
      approvedAt: null,
      approvedBy: null,
      approvedVia: null,
    });
    return response.body as { id: string };
  }

  /** Read the revision the approval card would send. */
  async function revision(id: string): Promise<string> {
    const listed = await call('/');
    return listed.body.find((task) => task.id === id)?.approvalRevision ?? '';
  }

  it('names the owner only when login is off, never a signed-in account', () => {
    // The saved profile name is the owner's; a signed-in account is not them.
    expect(personTaskApprover({ user: undefined })).toEqual({
      kind: 'person',
      userId: null,
      name: 'Dorian',
    });
    expect(personTaskApprover({ user: { userId: 'user-2', credential: 'cookie' } })).toEqual({
      kind: 'person',
      userId: 'user-2',
      name: null,
    });
  });

  it('stamps an operator create as its approval', async () => {
    const response = await call('/', 'POST', {
      name: 'person-made',
      description: 'person-made',
      prompt: 'Run the report.',
      cron: '0 4 * * *',
      target: 'global',
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(Number.isNaN(Date.parse(response.body.approvedAt ?? ''))).toBe(false);
    expect(response.body).toMatchObject({
      approvedBy: { kind: 'person', userId: 'user-1', name: null },
      approvedVia: 'created',
    });
  });

  it.each([
    ['inbox', false],
    ['schedules', true],
    [undefined, false],
  ] as const)('stamps PATCH approval from %s, including turn-on=%s', async (surface, turnOn) => {
    const task = await parked(`approval-${surface ?? 'unknown'}-${turnOn}`, !turnOn);
    const response = await call(`/${task.id}`, 'PATCH', {
      status: 'active',
      expectedApprovalRevision: await revision(task.id),
      ...(turnOn ? { enabled: true } : {}),
      ...(surface ? { approvalSurface: surface } : {}),
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(Number.isNaN(Date.parse(response.body.approvedAt ?? ''))).toBe(false);
    expect(response.body).toMatchObject({
      status: 'active',
      approvedBy: { kind: 'person', userId: 'user-1', name: null },
      approvedVia: surface ?? 'unknown',
      ...(turnOn ? { enabled: true } : {}),
    });
    const event = emitted.find((entry) => entry.eventType === 'tasks.task_approved');
    expect(event?.metadata).toMatchObject({
      approvedAt: response.body.approvedAt,
      approvedBy: response.body.approvedBy,
      approvedVia: response.body.approvedVia,
    });
  });

  it('fails closed at the store when no approver reaches an activation', async () => {
    const task = await parked('store-fallback');
    const updated = store.updateTask(task.id, { status: 'active' });

    expect(updated).toMatchObject({
      status: 'active',
      approvedBy: { kind: 'policy' },
      approvedVia: 'unknown',
    });
    expect(updated?.approvedAt).toEqual(expect.any(String));
    const row = db
      .select({ approvedContentKey: pulseSchedules.approvedContentKey })
      .from(pulseSchedules)
      .where(eq(pulseSchedules.id, task.id))
      .get();
    expect(row?.approvedContentKey).toEqual(expect.any(String));
  });

  it('ignores approvalSurface on an active task, and keeps the receipt it already had', async () => {
    const created = await call('/', 'POST', {
      name: 'already-active',
      description: 'already-active',
      prompt: 'Run the report.',
      cron: '0 4 * * *',
      target: 'global',
    });

    const response = await call(`/${created.body.id}`, 'PATCH', {
      status: 'active',
      approvalSurface: 'inbox',
      expectedApprovalRevision: await revision(created.body.id as string),
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    // Approving the same content again is not a new approval: the create's
    // receipt says more than "a person, somewhere" (DOR-3641 review, nit 4).
    expect(response.body).toMatchObject({
      approvedAt: created.body.approvedAt,
      approvedBy: { kind: 'person', userId: 'user-1', name: null },
      approvedVia: 'created',
    });
  });

  it('lets a re-approval of the same content fill in a receipt that said less', async () => {
    const task = await parked('policy-first');
    store.updateTask(task.id, { status: 'active' });
    expect(store.getTask(task.id)).toMatchObject({ approvedBy: { kind: 'policy' } });

    const response = await call(`/${task.id}`, 'PATCH', {
      status: 'active',
      expectedApprovalRevision: await revision(task.id),
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      approvedBy: { kind: 'person', userId: 'user-1', name: null },
      approvedVia: 'unknown',
    });
  });

  it('stamps the person whose edit changed the work, not the approver of the old work', async () => {
    const task = await parked('edited-live');
    await call(`/${task.id}`, 'PATCH', {
      status: 'active',
      approvalSurface: 'inbox',
      expectedApprovalRevision: await revision(task.id),
    });
    db.update(pulseSchedules)
      .set({ approvedBy: JSON.stringify({ kind: 'policy' }), approvedVia: 'trusted_agent' })
      .where(eq(pulseSchedules.id, task.id))
      .run();

    const response = await call(`/${task.id}`, 'PATCH', { prompt: 'Run the new report.' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      status: 'active',
      approvedBy: { kind: 'person', userId: 'user-1', name: null },
    });
  });
});
