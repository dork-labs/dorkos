/**
 * DOR-4315: a one-shot task runs once, as soon as it is armed, and never again,
 * across a re-sync and a restart. Its agent-set list rides that run only while
 * each program matches its pin. Real store and scheduler; made-up names.
 */
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../core/capabilities/permission-enforcement.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { writeManifest } from '@dorkos/shared/manifest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Db } from '@dorkos/db';
import { initBoundary } from '../../../lib/boundary.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { TaskSchedulerService, type SchedulerAgentManager } from '../task-scheduler-service.js';
import { TaskStore } from '../task-store.js';
import { mergePins, pinPrograms } from '../allow-list/allow-list-pins.js';
import { LEVEL_DROPPED_MESSAGE, PROGRAM_CHANGED_MESSAGE } from '../allow-list/run-allow-list.js';

const CONFIG = { maxConcurrentRuns: 2, retentionCount: 100, mayFire: true, firingReason: 'test' };

function agentManager(): SchedulerAgentManager {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(async function* () {}),
    interruptQuery: vi.fn().mockResolvedValue(true),
    getInternalSessionId: vi.fn(() => undefined),
    acquireLock: vi.fn(() => true),
    releaseLock: vi.fn(),
  } as unknown as SchedulerAgentManager;
}

describe('a one-shot task', () => {
  let db: Db;
  let store: TaskStore;
  let agent: SchedulerAgentManager;
  let dir: string;
  let services: TaskSchedulerService[];

  beforeEach(async () => {
    db = createTestDb();
    runtimeRegistry.setDb(db);
    store = new TaskStore(db);
    agent = agentManager();
    services = [];
    dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor4315-once-')));
    await initBoundary('/');
  });

  afterEach(async () => {
    for (const service of services) await service.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  function scheduler(config = CONFIG): TaskSchedulerService {
    const service = new TaskSchedulerService(store, agent, config);
    services.push(service);
    return service;
  }

  function oneShot(extra: { approvedAllow?: string[] } = {}) {
    const task = store.createTask({
      name: 'sample-backfill',
      description: 'A one-off sample backfill',
      prompt: 'Run the sample backfill once.',
      filePath: path.join(dir, 'sample-backfill', 'SKILL.md'),
      permissionMode: 'dontAsk',
    });
    store.runControls.set(task.id, { runOnce: true, ...extra });
    return store.getTask(task.id)!;
  }

  async function settled() {
    await vi.waitFor(
      () => {
        const runs = store.listRuns();
        expect(runs.length).toBeGreaterThan(0);
        expect(runs.every((run) => run.status !== 'running')).toBe(true);
      },
      { interval: 5 }
    );
  }

  it('runs once when armed, and not again on a re-sync or a restart', async () => {
    const task = oneShot();
    const first = scheduler();
    await first.start();
    await settled();
    expect(store.listRuns()).toHaveLength(1);
    expect(store.listRuns()[0]).toMatchObject({ trigger: 'scheduled' });
    expect(store.getTask(task.id)?.ranOnceAt).toEqual(expect.any(String));

    // A re-sync on the live leader, then a restart: a leader that would fire.
    first.registerTask(store.getTask(task.id)!);
    await first.stop();
    const restarted = scheduler();
    await restarted.start();
    restarted.registerTask(store.getTask(task.id)!);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.listRuns()).toHaveLength(1);
    expect(agent.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a skipped run on its row, so its one chance never vanishes', async () => {
    const task = oneShot();
    await scheduler({ ...CONFIG, maxConcurrentRuns: 0 }).start();
    await settled();
    expect(store.listRuns()).toEqual([
      expect.objectContaining({
        scheduleId: task.id,
        status: 'skipped',
        error: expect.any(String),
      }),
    ]);
    expect(agent.sendMessage).not.toHaveBeenCalled();
  });

  it('claims nothing in a process that may not fire', async () => {
    const task = oneShot();
    await scheduler({ ...CONFIG, mayFire: false }).start();
    expect(store.getTask(task.id)?.ranOnceAt ?? null).toBeNull();
    expect(store.listRuns()).toHaveLength(0);
  });

  describe('with its own pinned list', () => {
    let rule: string;
    let program: string;

    /** A one-shot task with one pinned command. */
    async function listed() {
      program = path.join(dir, 'derive-sample');
      await fs.writeFile(program, '#!/bin/sh\necho sample\n', { mode: 0o755 });
      rule = `Bash(${program} --backfill)`;
      const pinned = await pinPrograms([rule]);
      if (!pinned.ok) throw new Error('could not pin');
      const task = oneShot({ approvedAllow: [rule] });
      store.runControls.set(task.id, {
        allowListPins: mergePins(null, pinned.programs, [rule], new Date().toISOString()),
      });
      return task;
    }

    /** The task's own agent, its Files & commands stop set to `stop` now. */
    async function ownAgentAt(taskId: string, stop: 'ask' | 'act' | 'autonomy') {
      const home = path.join(dir, 'agent');
      await fs.mkdir(home, { recursive: true });
      await writeManifest(home, {
        id: 'sample-media',
        name: 'sample-media',
        description: '',
        runtime: 'claude-code',
        capabilities: [],
        behavior: { responseMode: 'always' },
        registeredAt: new Date().toISOString(),
        registeredBy: 'test',
        personaEnabled: true,
        mcpServers: [],
      } as unknown as AgentManifest);
      store.recordProposal(taskId, { proposedByAgentPath: home, proposedBySessionId: 'ses-a' });
      initPermissionGate({
        readAgentPermissions: async (agentPath) =>
          agentPath === home ? { filesAndCommands: stop } : undefined,
      });
      onTestFinished(() => resetPermissionGate());
      // A Claude Code runtime registered, so its modes can be read at fire time.
      runtimeRegistry.register(new FakeAgentRuntime('claude-code'));
    }

    it('carries its list into its one run while its agent is at Full', async () => {
      const task = await listed();
      await ownAgentAt(task.id, 'autonomy');
      await scheduler().start();
      await settled();
      const opts = vi.mocked(agent.sendMessage).mock.calls[0]![2] as {
        taskApprovedAllow?: string[];
      };
      expect(opts.taskApprovedAllow).toEqual([rule]);
    });

    it.each(['act', 'ask'] as const)(
      'fails its run, running nothing, when its agent dropped to %s before it fired',
      async (stop) => {
        const task = await listed();
        await ownAgentAt(task.id, stop);
        await scheduler().start();
        await settled();
        expect(store.listRuns()[0]).toMatchObject({
          status: 'failed',
          error: LEVEL_DROPPED_MESSAGE,
        });
        expect(agent.sendMessage).not.toHaveBeenCalled();
      }
    );

    it('fails its run, running nothing, when DorkOS can’t name its agent', async () => {
      await listed();
      await scheduler().start();
      await settled();
      expect(store.listRuns()[0]).toMatchObject({ status: 'failed', error: LEVEL_DROPPED_MESSAGE });
      expect(agent.sendMessage).not.toHaveBeenCalled();
    });

    it('fails its run, running nothing, when a pinned program changed', async () => {
      const task = await listed();
      await ownAgentAt(task.id, 'autonomy');
      await fs.writeFile(program, '#!/bin/sh\necho changed\n');
      await scheduler().start();
      await settled();
      expect(store.listRuns()[0]).toMatchObject({
        status: 'failed',
        error: PROGRAM_CHANGED_MESSAGE,
      });
      expect(agent.sendMessage).not.toHaveBeenCalled();
    });
  });
});
