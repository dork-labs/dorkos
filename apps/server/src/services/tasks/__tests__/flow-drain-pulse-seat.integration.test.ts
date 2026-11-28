import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initBoundary } from '../../../lib/boundary.js';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskFileWatcher } from '../task-file-watcher.js';
import { ScheduleIdentityRegistry } from '../schedule-identity.js';
import { skillsRoot } from './task-root-fixtures.js';
import { TaskRegistrar } from '../task-registrar.js';
import { FakeScheduler } from './fake-scheduler.js';
import { TaskSchedulerService } from '../task-scheduler-service.js';
import { TaskStore } from '../task-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Db } from '@dorkos/db';
import type { MeshCore } from '@dorkos/mesh';
import type { Task } from '@dorkos/shared/types';
import { registerClaudeCodeFacts } from '../../../startup/register-claude-code-facts.js';
import { onRuntime, type RuntimeDouble } from './support/runtime-task-turns.js';

// What the server's startup registers (DOR-4928): unregistered, the protected-path policy
// refuses every path and turn code knows no Claude transcript.
registerClaudeCodeFacts();

/**
 * Pulse seat for the `/flow` autonomous loop (spec §10, task 2.5): real
 * chokidar, real filesystem, croner. No model runs (a `FakeAgentRuntime`) and
 * no wall-clock cron fires (`triggerManualRun` drives `executeRun`).
 */

/**
 * A verbatim flow-drain SKILL.md fixture (spec §10 / task 2.5): a representative
 * schedulable skill for the Pulse-seat scheduler test. The live skill ships with
 * the external flow plugin, not in dorkos.
 */
const FLOW_DRAIN_SKILL = `---
name: flow-drain
display-name: /flow — drain ready queue
description: Claim the top-ranked eligible issue and carry it to its review gate.
schedule:
  cron: "*/10 * * * *"
  timezone: America/Los_Angeles
  enabled: true
  max-runtime: 2h
  permissions: acceptEdits
---

Run one tick of the /flow autonomous loop:

1. Via adapters/linear, fetch eligible work and rank it (dispatch ladder, §4).
2. Claim the top issue (durable label + state), provision its worktree.
3. Carry it through the stages to its gate — uncertainty-gated involvement (§5).
4. Stop at the human-review gate or on a genuine question (needs-input).
`;

/** A FakeAgentRuntime is structurally a RuntimeDouble. */
function asAgentManager(runtime: FakeAgentRuntime): RuntimeDouble {
  return runtime as unknown as RuntimeDouble;
}

/** Minimal MeshCore that resolves a project agent to its worktree path. */
function meshWith(pathMap: Record<string, string>): MeshCore {
  return {
    getProjectPath: vi.fn((agentId: string): string | undefined => pathMap[agentId]),
  } as unknown as MeshCore;
}

/** Poll until the task defined by `filePath` resolves in the store. */
async function waitForTask(store: TaskStore, filePath: string, label: string): Promise<Task> {
  const deadline = Date.now() + 5000;
  // By the REAL path: a row discovered in a skills root is keyed on the file
  // with its symlinks resolved, and every macOS temp directory is under one.
  const identity = await realpath(filePath);
  while (Date.now() < deadline) {
    const task = store.fileSync.getByFilePath(identity);
    if (task) return task;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('flow-drain Pulse seat (real chokidar + croner integration)', () => {
  let dorkHome: string;
  let skillsDir: string;
  let db: Db;
  let store: TaskStore;
  let watcher: TaskFileWatcher;
  let scheduler: TaskSchedulerService | undefined;
  /** Stands in for the scheduler behind the WATCHER's registrar; the real one
   * this test drives is built inside each case. */
  let watcherScheduler: FakeScheduler;

  // The agent the project task is linked to, and its provisioned worktree cwd.
  const AGENT_ID = 'agent-flow-project';
  /**
   * The worktree the linked agent works in. Assigned per case, under the test's
   * own temp root: the agent-cwd chain boundary-checks the directory a turn
   * resolves to, so a fixed path off in `/Users/test` would be refused.
   */
  let WORKTREE_CWD: string;

  beforeEach(async () => {
    // The agent-cwd chain (`services/workspace/resolve-session-cwd.ts`)
    // boundary-checks the directory a turn resolves to. Everything this test
    // builds lives under the temp root, so that is the boundary — and the temp
    // dir is realpath'd, because the chain returns canonical paths and macOS
    // spells `/var` as a symlink to `/private/var`.
    await initBoundary(await realpath(tmpdir()));
    dorkHome = await realpath(await mkdtemp(path.join(tmpdir(), 'flow-drain-pulse-')));
    WORKTREE_CWD = path.join(dorkHome, 'workspaces', 'core', 'spec-flow');
    // Project-scoped tasks live at `<project>/.dork/tasks/`.
    skillsDir = path.join(dorkHome, 'project', '.agents', 'skills');
    await mkdir(skillsDir, { recursive: true });

    db = createTestDb();
    store = new TaskStore(db);
    watcherScheduler = new FakeScheduler();
    watcher = new TaskFileWatcher(
      store,
      new TaskRegistrar({ store, scheduler: watcherScheduler }),
      new ScheduleIdentityRegistry()
    );
  });

  afterEach(async () => {
    await watcher.stopAll();
    await scheduler?.stop();
    scheduler = undefined;
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('watches the SKILL.md, syncs it, schedules it, and fires one fresh session per tick', async () => {
    const projectPath = path.join(dorkHome, 'project');
    const skillDir = path.join(skillsDir, 'flow-drain');
    await mkdir(skillDir);
    await writeFile(path.join(skillDir, 'SKILL.md'), FLOW_DRAIN_SKILL);
    watcher.watch(skillsRoot(skillsDir, 'project', projectPath, AGENT_ID));

    const task = await waitForTask(
      store,
      path.join(skillsDir, 'flow-drain', 'SKILL.md'),
      'flow-drain to sync to pulseSchedules'
    );
    expect(task).toMatchObject({
      name: 'flow-drain',
      displayName: '/flow — drain ready queue',
      cron: '*/10 * * * *',
      timezone: 'America/Los_Angeles',
      enabled: true,
      permissionMode: 'acceptEdits',
      maxRuntime: 7_200_000,
      agentId: AGENT_ID,
    });

    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([async function* () {}, async function* () {}]);
    scheduler = new TaskSchedulerService({
      store,
      ...onRuntime(asAgentManager(runtime)),
      config: {
        maxConcurrentRuns: 1,
        retentionCount: 100,
        timezone: null,
        mayFire: true,
        firingReason: 'test',
      },
      meshCore: meshWith({ [AGENT_ID]: WORKTREE_CWD }),
    });
    scheduler.registerTask(task);
    expect(scheduler.getNextRun(task.id)).toBeInstanceOf(Date);

    // Two ticks, through the same `executeRun` path croner invokes.
    for (let tick = 0; tick < 2; tick++) {
      const run = await scheduler.triggerManualRun(task.id);
      await vi.waitFor(() => expect(store.getRun(run!.id)?.status).toBe('completed'));
    }

    // Each tick is a fresh session of its own (§7.7), named by a UUID so a
    // person can open it, in the agent's resolved worktree.
    const [ensureSessionId, ensureOpts] = runtime.ensureSession.mock.calls[0];
    expect(ensureSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(ensureOpts).toMatchObject({ hasStarted: false, cwd: WORKTREE_CWD });
    const [, sendContent, sendOpts] = runtime.sendMessage.mock.calls[0];
    expect(sendContent).toContain('Run one tick of the /flow autonomous loop');
    expect(sendOpts).toMatchObject({ cwd: WORKTREE_CWD, permissionMode: 'acceptEdits' });
    const sessionIds = runtime.sendMessage.mock.calls.map(([sid]) => sid);
    expect(new Set(sessionIds).size).toBe(2);
    const runs = store.listRuns({ taskId: task.id });
    expect(new Set(runs.map((r) => r.sessionId))).toEqual(new Set(sessionIds));
  });
});
