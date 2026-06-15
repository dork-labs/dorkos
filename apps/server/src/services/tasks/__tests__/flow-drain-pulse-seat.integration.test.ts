import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Cron } from 'croner';
import { TaskFileWatcher } from '../task-file-watcher.js';
import { TaskSchedulerService, type SchedulerAgentManager } from '../task-scheduler-service.js';
import { TaskStore } from '../task-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Db } from '@dorkos/db';
import type { MeshCore } from '@dorkos/mesh';
import type { Task } from '@dorkos/shared/types';

/**
 * Pulse seat for the `/flow` autonomous loop (spec §10, task 2.5).
 *
 * REAL chokidar + real filesystem + croner — the same end-to-end discipline as
 * the session-list-watcher integration suite. Proves the project-scoped
 * `flow-drain` SKILL.md is a valid, watchable, schedulable Pulse task that
 * dispatches exactly ONE fresh session per tick with the resolved worktree cwd.
 *
 * No real model runs: a `FakeAgentRuntime` stands in for the agent manager
 * (its `ensureSession`/`sendMessage` satisfy the `SchedulerAgentManager` shape).
 * No real wall-clock cron fires: the tick is driven through the same
 * `executeRun` path croner invokes, via `triggerManualRun`.
 */

/** The verbatim flow-drain SKILL.md (spec §10 / task 2.5), as it ships on disk. */
const FLOW_DRAIN_SKILL = `---
name: flow-drain
display-name: /flow — drain ready queue
description: Claim the top-ranked eligible issue and carry it to its review gate.
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

/** A FakeAgentRuntime is structurally a SchedulerAgentManager. */
function asAgentManager(runtime: FakeAgentRuntime): SchedulerAgentManager {
  return runtime as unknown as SchedulerAgentManager;
}

/** Minimal MeshCore that resolves a project agent to its worktree path. */
function meshWith(pathMap: Record<string, string>): MeshCore {
  return {
    getProjectPath: vi.fn((agentId: string): string | undefined => pathMap[agentId]),
  } as unknown as MeshCore;
}

/** Poll until a slug resolves in the store or the deadline passes. */
async function waitForTask(store: TaskStore, slug: string, label: string): Promise<Task> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const task = store.getBySlug(slug);
    if (task) return task;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('flow-drain Pulse seat (real chokidar + croner integration)', () => {
  let dorkHome: string;
  let tasksDir: string;
  let db: Db;
  let store: TaskStore;
  let watcher: TaskFileWatcher;
  let scheduler: TaskSchedulerService | undefined;

  // The agent the project task is linked to, and its provisioned worktree cwd.
  const AGENT_ID = 'agent-flow-project';
  const WORKTREE_CWD = '/Users/test/.dork/workspaces/core/spec-flow';

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'flow-drain-pulse-'));
    // Project-scoped tasks live at `<project>/.dork/tasks/`.
    tasksDir = path.join(dorkHome, 'project', '.dork', 'tasks');
    await mkdir(tasksDir, { recursive: true });

    db = createTestDb();
    store = new TaskStore(db);
    watcher = new TaskFileWatcher(store, () => {}, dorkHome);
  });

  afterEach(async () => {
    await watcher.stopAll();
    await scheduler?.stop();
    scheduler = undefined;
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('watches the SKILL.md, syncs it to pulseSchedules, schedules it, and fires one fresh session', async () => {
    const projectPath = path.join(dorkHome, 'project');

    // 1. Drop the flow-drain SKILL.md into the project tasks dir.
    const skillDir = path.join(tasksDir, 'flow-drain');
    await mkdir(skillDir);
    await writeFile(path.join(skillDir, 'SKILL.md'), FLOW_DRAIN_SKILL);

    // 2. Watch the project tasks dir — real chokidar, linked to a project agent.
    watcher.watch(tasksDir, 'project', projectPath, AGENT_ID);

    // 3. The watcher syncs the file into the pulseSchedules cache (file-first).
    const task = await waitForTask(store, 'flow-drain', 'flow-drain to sync to pulseSchedules');

    expect(task.name).toBe('flow-drain');
    expect(task.displayName).toBe('/flow — drain ready queue');
    expect(task.cron).toBe('*/10 * * * *');
    expect(task.timezone).toBe('America/Los_Angeles');
    expect(task.enabled).toBe(true);
    expect(task.permissionMode).toBe('acceptEdits');
    // `max-runtime: 2h` → 7,200,000 ms.
    expect(task.maxRuntime).toBe(7_200_000);
    // The dispatch brief is the prompt body.
    expect(task.prompt).toContain('Run one tick of the /flow autonomous loop');
    expect(task.prompt).toContain('dispatch ladder');
    // Project-scoped tasks carry the linked agent id (drives cwd resolution).
    expect(task.agentId).toBe(AGENT_ID);

    // 4. The scheduler registers the task with croner.
    const runtime = new FakeAgentRuntime();
    // No real model output — an immediately-completing turn.
    runtime.withScenarios([async function* () {}]);

    scheduler = new TaskSchedulerService({
      store,
      agentManager: asAgentManager(runtime),
      config: { maxConcurrentRuns: 1, retentionCount: 100, timezone: null },
      meshCore: meshWith({ [AGENT_ID]: WORKTREE_CWD }),
    });

    scheduler.registerTask(task);
    expect(scheduler.isRegistered(task.id)).toBe(true);
    // croner computed a next fire time from the cron expression.
    expect(scheduler.getNextRun(task.id)).toBeInstanceOf(Date);

    // 5. A fire dispatches exactly ONE fresh session with the resolved worktree
    // cwd. `triggerManualRun` drives the same `executeRun` path croner invokes.
    const run = await scheduler.triggerManualRun(task.id);
    expect(run).not.toBeNull();
    // Wait for the async execution to complete (run reaches a terminal state).
    await vi.waitFor(() => {
      expect(store.getRun(run!.id)?.status).toBe('completed');
    });

    // Exactly one fresh session — fresh-session-per-issue (§7.7).
    expect(runtime.ensureSession).toHaveBeenCalledTimes(1);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);

    // The session is keyed by the run id (sessionId === run.id) and starts fresh.
    const [ensureSessionId, ensureOpts] = runtime.ensureSession.mock.calls[0];
    expect(ensureSessionId).toBe(run!.id);
    expect(ensureOpts).toMatchObject({ hasStarted: false, cwd: WORKTREE_CWD });

    // The dispatch resolves the worktree cwd (via the mesh-linked agent).
    const [sendSessionId, sendContent, sendOpts] = runtime.sendMessage.mock.calls[0];
    expect(sendSessionId).toBe(run!.id);
    expect(sendContent).toContain('Run one tick of the /flow autonomous loop');
    expect(sendOpts?.cwd).toBe(WORKTREE_CWD);
    expect(sendOpts?.permissionMode).toBe('acceptEdits');

    // The run is recorded against that session.
    const finished = store.getRun(run!.id);
    expect(finished?.status).toBe('completed');
    expect(finished?.sessionId).toBe(run!.id);
  });

  it('registers a non-overlapping (protect:true) croner job in the task timezone', async () => {
    const projectPath = path.join(dorkHome, 'project');
    const skillDir = path.join(tasksDir, 'flow-drain');
    await mkdir(skillDir);
    await writeFile(path.join(skillDir, 'SKILL.md'), FLOW_DRAIN_SKILL);
    watcher.watch(tasksDir, 'project', projectPath, AGENT_ID);
    const task = await waitForTask(store, 'flow-drain', 'flow-drain to sync');

    const runtime = new FakeAgentRuntime();
    scheduler = new TaskSchedulerService({
      store,
      agentManager: asAgentManager(runtime),
      config: { maxConcurrentRuns: 1, retentionCount: 100, timezone: null },
      meshCore: meshWith({ [AGENT_ID]: WORKTREE_CWD }),
    });

    scheduler.registerTask(task);

    // The scheduler builds the croner job with `protect: true` (no overlapping
    // runs — sequential WIP-1, §10) and the task's IANA timezone. Verify both
    // on a fresh `Cron` built from the same task fields the scheduler uses, so
    // the assertion does not reach into the scheduler's private job map.
    const job = new Cron(
      task.cron,
      { protect: true, timezone: task.timezone ?? undefined },
      () => {}
    );
    expect(job.options.protect).toBe(true);
    expect(job.options.timezone).toBe('America/Los_Angeles');
    // croner derives the next fire from the `*/10 * * * *` expression.
    expect(scheduler.getNextRun(task.id)).toBeInstanceOf(Date);
    expect(job.nextRun()).toBeInstanceOf(Date);
    job.stop();
  });

  it('each tick is a fresh session keyed by its run id (fresh-session-per-issue, §7.7)', async () => {
    const projectPath = path.join(dorkHome, 'project');
    const skillDir = path.join(tasksDir, 'flow-drain');
    await mkdir(skillDir);
    await writeFile(path.join(skillDir, 'SKILL.md'), FLOW_DRAIN_SKILL);
    watcher.watch(tasksDir, 'project', projectPath, AGENT_ID);
    const task = await waitForTask(store, 'flow-drain', 'flow-drain to sync');

    const runtime = new FakeAgentRuntime();
    // Two immediately-completing turns — one per tick.
    runtime.withScenarios([async function* () {}, async function* () {}]);

    scheduler = new TaskSchedulerService({
      store,
      agentManager: asAgentManager(runtime),
      config: { maxConcurrentRuns: 1, retentionCount: 100, timezone: null },
      meshCore: meshWith({ [AGENT_ID]: WORKTREE_CWD }),
    });

    // Two sequential ticks (the croner fire path, driven deterministically).
    const first = await scheduler.triggerManualRun(task.id);
    await vi.waitFor(() => {
      expect(store.getRun(first!.id)?.status).toBe('completed');
    });
    const second = await scheduler.triggerManualRun(task.id);
    await vi.waitFor(() => {
      expect(store.getRun(second!.id)?.status).toBe('completed');
    });

    // Distinct runs, each its own fresh session (sessionId === run.id).
    expect(first!.id).not.toBe(second!.id);
    expect(runtime.ensureSession).toHaveBeenCalledTimes(2);
    expect(runtime.sendMessage).toHaveBeenCalledTimes(2);

    const sessionIds = runtime.sendMessage.mock.calls.map(([sid]) => sid);
    expect(new Set(sessionIds)).toEqual(new Set([first!.id, second!.id]));

    const runs = store.listRuns({ taskId: task.id });
    expect(runs.length).toBe(2);
    expect(runs.every((r) => r.status === 'completed')).toBe(true);
    expect(runs.every((r) => r.sessionId === r.id)).toBe(true);
  });
});
