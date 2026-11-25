import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DEFAULT_CWD } from '../../../../lib/resolve-root.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { TaskSchedulerService, singleRuntimeSource } from '../../task-scheduler-service.js';
import type { RelayRuntimePredicate, SchedulerAgentManager } from '../../task-scheduler-service.js';
import { assessTaskDispatch } from '../../../relay/task-dispatch/readiness.js';
import { AdapterRegistry } from '@dorkos/relay';
import type { AdapterStatus, RelayAdapter, RelayPublisher, RelayCore } from '@dorkos/relay';
import { taskDispatchSubject, TASK_DISPATCH_SUBJECT_PREFIX } from '@dorkos/shared/relay-schemas';
import type { TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import { TaskStore } from '../../task-store.js';
import { setRelayEnabled } from '../../../relay/relay-state.js';
import type { ActivityService } from '../../../activity/activity-service.js';
import { isRegisteredClaudeAccount } from '../../../runtimes/claude-code/claude-config-dir.js';
import {
  SESSION_UUID_RE,
  waitFor,
  taskInput,
  DEFAULT_CONFIG,
  createMockMeshCore,
  freshHarness,
  relayStub,
  runtimeHarness,
  writeAgentHome,
  meshAt,
  HOLDS_EVERYTHING,
  holdsOnly,
} from './task-scheduler.fixtures.js';
import type { MockRelay, RuntimeHarness, Dispatchable } from './task-scheduler.fixtures.js';
import { registerClaudeCodeFacts } from '../../../../startup/register-claude-code-facts.js';

// What the server's startup registers (DOR-4928): unregistered, the protected-path policy
// refuses every path and turn code knows no Claude transcript.
registerClaudeCodeFacts();

vi.mock('../../../runtimes/claude-code/claude-config-dir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../runtimes/claude-code/claude-config-dir.js')>()),
  // "Nobody can say" by default, which reports nothing; the DOR-2384 case
  // answers for itself.
  isRegisteredClaudeAccount: vi.fn(() => undefined),
}));

const TICK = new Date(1_700_000_000_000);

describe('TaskSchedulerService — per-task runtime, model and effort (DOR-1615)', () => {
  let store: TaskStore;
  let rt: RuntimeHarness;

  beforeEach(async () => {
    ({ store } = await freshHarness());
    rt = runtimeHarness(store);
  });

  afterEach(() => {
    vi.mocked(isRegisteredClaudeAccount).mockReturnValue(undefined);
  });

  it('a sticky task moved to another runtime mints a FRESH session, across the real store', async () => {
    // No injected lookup: the first version passed six tests against a stub
    // while doing nothing in production (DOR-1615 review).
    const task = store.createTask(
      taskInput({ name: 'Sticky move', sticky: true, runtime: 'claude-code' })
    );
    const service = rt.scheduler(['claude-code', 'codex']);

    const first = await rt.runToCompletion(service, task.id);
    expect(first.sessionId).toMatch(SESSION_UUID_RE);
    expect(store.latestStickyRun(task.id)).toEqual({
      sessionId: first.sessionId,
      runtime: 'claude-code',
    });

    // The same runtime resumes: the control that makes the move mean something.
    await rt.runToCompletion(service, task.id);
    expect(
      vi.mocked(rt.managers['claude-code']!.ensureSession).mock.calls.at(-1)![1]
    ).toMatchObject({
      hasStarted: true,
    });

    store.updateTask(task.id, { runtime: 'codex' });
    const third = await rt.runToCompletion(service, task.id);

    const [sessionId, opts] = vi.mocked(rt.managers['codex']!.ensureSession).mock.calls.at(-1)!;
    expect(opts).toMatchObject({ hasStarted: false });
    expect(sessionId).toMatch(SESSION_UUID_RE);
    expect(sessionId).toBe(third.sessionId);
    expect(third.resolvedRuntime).toBe('codex');
    await service.stop();
  });

  it('runs on the runtime the task names, and stamps the resolved runtime and model', async () => {
    const task = store.createTask(
      taskInput({ name: 'On codex', runtime: 'codex', model: 'gpt-5.5' })
    );
    const service = rt.scheduler(['claude-code', 'codex']);

    const row = await rt.runToCompletion(service, task.id);

    expect(rt.managers['codex']!.sendMessage).toHaveBeenCalledOnce();
    expect(rt.managers['claude-code']!.sendMessage).not.toHaveBeenCalled();
    expect(row).toMatchObject({ resolvedRuntime: 'codex', resolvedModel: 'gpt-5.5' });
    await service.stop();
  });

  it('fails the run loudly when the named runtime is not turned on, and starts no turn', async () => {
    const task = store.createTask(taskInput({ name: 'On nothing', runtime: 'codex' }));
    const service = rt.scheduler(['claude-code']);

    const row = await rt.runToCompletion(service, task.id);

    expect(row.status).toBe('failed');
    expect(row.error).toContain('not turned on');
    expect(rt.managers['claude-code']!.sendMessage).not.toHaveBeenCalled();
    await service.stop();
  });

  it('starts the turn with the model, effort and account on BOTH agent calls (DOR-2384)', async () => {
    // claude-code reads the session record at launch; a runtime that holds no
    // sessions in memory only ever sees the send.
    const task = store.createTask(
      taskInput({ name: 'Settings', model: 'claude-opus-4-6', effort: 'xhigh', account: 'work' })
    );
    const service = rt.scheduler(['claude-code']);

    await rt.runToCompletion(service, task.id);

    const settings = expect.objectContaining({
      model: 'claude-opus-4-6',
      effort: 'xhigh',
      accountHint: 'work',
    });
    expect(rt.managers['claude-code']!.ensureSession).toHaveBeenCalledWith(
      expect.any(String),
      settings
    );
    expect(rt.managers['claude-code']!.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      settings
    );
    await service.stop();
  });

  it('passes an approved allow rule only on that task turn', async () => {
    const rule = 'Bash(/abs/path/script.sh --once)';
    const task = store.createTask(taskInput({ name: 'Scoped allow' }));
    store.updateTask(task.id, { approvedAllow: [rule] });
    const service = rt.scheduler(['claude-code']);

    await rt.runToCompletion(service, task.id);

    expect(rt.managers['claude-code']!.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ taskApprovedAllow: [rule] })
    );
    expect(rt.managers['claude-code']!.ensureSession).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ taskApprovedAllow: expect.anything() })
    );
    await service.stop();
  });

  /**
   * The run-time half of DOR-2100: a schedule approved at the operator's level
   * LAUNCHES at it. The approval writes one column (as `PATCH /api/tasks/:id`
   * does), and that column is the only place a scheduled run's power lives.
   * The un-raised row is the control.
   */
  it.each([
    ['bypassPermissions', 'bypassPermissions'],
    [undefined, 'acceptEdits'],
  ] as const)(
    'launches a schedule approved at %s at the mode the row holds',
    async (raised, expected) => {
      const task = store.createTask(taskInput({ name: 'Approved' }));
      expect(task.permissionMode).toBe('acceptEdits');
      store.updateTask(task.id, {
        status: 'active',
        ...(raised ? { permissionMode: raised } : {}),
      });
      const service = rt.scheduler(['claude-code']);

      await rt.runToCompletion(service, task.id);

      const mode = expect.objectContaining({ permissionMode: expected });
      expect(rt.managers['claude-code']!.ensureSession).toHaveBeenCalledWith(
        expect.any(String),
        mode
      );
      expect(rt.managers['claude-code']!.sendMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        mode
      );
      await service.stop();
    }
  );

  it('says in Activity that a run on an unregistered account fell through to the usual one (DOR-2384)', async () => {
    vi.mocked(isRegisteredClaudeAccount).mockReturnValue(false);
    const emit = vi.fn();
    const task = store.createTask(taskInput({ name: 'Gone', account: 'old-client' }));
    const service = new TaskSchedulerService({
      store,
      runtimes: rt.runtimesWith(['claude-code']),
      config: { ...DEFAULT_CONFIG },
      activityService: { emit } as unknown as ActivityService,
    });

    await rt.runToCompletion(service, task.id);

    const summaries = emit.mock.calls
      .map(([event]) => event as { eventType: string; summary: string })
      .filter((event) => event.eventType === 'tasks.account_unavailable')
      .map((event) => event.summary);
    expect(summaries).toEqual([
      'Gone ran on the usual Claude account, because the account "old-client" it names is not set up in DorkOS',
    ]);
    await service.stop();
  });
});

describe('TaskSchedulerService — which path a run takes', () => {
  let store: TaskStore;
  let rt: RuntimeHarness;
  let relay: MockRelay;

  beforeEach(async () => {
    ({ store } = await freshHarness());
    rt = runtimeHarness(store);
    setRelayEnabled(true);
    relay = relayStub('m-1');
  });

  afterEach(() => {
    setRelayEnabled(false);
  });

  const fire = (service: TaskSchedulerService, task: ReturnType<TaskStore['createTask']>) =>
    (service as unknown as Dispatchable).dispatch(task, TICK);

  it('carries the resolved runtime, model and effort in the envelope when the relay holds it (DOR-1614)', async () => {
    // Without `runtime` the receiver falls back to ITS default and a codex
    // task runs on claude-code. Model and effort resolve on THIS side only.
    const task = store.createTask(
      taskInput({ name: 'Codex on the bus', runtime: 'codex', model: 'haiku', effort: 'low' })
    );
    const service = rt.scheduler(
      ['claude-code', 'codex'],
      relay as unknown as RelayCore,
      HOLDS_EVERYTHING
    );

    await fire(service, task);
    await waitFor(() => expect(relay.publish).toHaveBeenCalledOnce());

    expect(rt.managers['codex']!.sendMessage).not.toHaveBeenCalled();
    const [, payload] = relay.publish.mock.calls[0] as [string, TaskDispatchPayload];
    expect(payload).toMatchObject({ runtime: 'codex', model: 'haiku', effort: 'low' });
    await service.stop();
  });

  it('keeps a run DIRECT when the relay does not hold its runtime (DOR-1614)', async () => {
    // A false positive strands the run on a bus that would refuse it.
    const task = store.createTask(taskInput({ name: 'Not held', runtime: 'codex' }));
    const service = rt.scheduler(
      ['claude-code', 'codex'],
      relay as unknown as RelayCore,
      holdsOnly('claude-code')
    );

    await rt.runToCompletion(service, task.id);

    expect(rt.managers['codex']!.sendMessage).toHaveBeenCalledOnce();
    expect(relay.publish).not.toHaveBeenCalled();
    await service.stop();
  });

  describe('routing reads LIVE adapter state, not a boot-time map (DOR-1636)', () => {
    // The predicate is the PRODUCTION rule over a real `AdapterRegistry`. The
    // bug was in the FACT it read: a boot-time map that adapter lifecycle never
    // touched, so a disabled adapter still read as deliverable.
    let registry: AdapterRegistry;

    /** A stand-in for the built-in Claude Code adapter's claim on task dispatch. */
    function tasksReceiver(state: AdapterStatus['state'] = 'connected'): RelayAdapter {
      return {
        id: 'claude-code',
        subjectPrefix: ['relay.agent.', TASK_DISPATCH_SUBJECT_PREFIX],
        displayName: 'Claude Code',
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 0 }),
        getStatus: () => ({ state, messageCount: { inbound: 0, outbound: 0 }, errorCount: 0 }),
      };
    }

    const asked: string[] = [];
    const livePredicate: RelayRuntimePredicate = (runtimeType, subject) => {
      asked.push(subject);
      return assessTaskDispatch(registry.getBySubject(subject), runtimeType === 'claude-code');
    };

    beforeEach(() => {
      asked.length = 0;
      registry = new AdapterRegistry();
      registry.setLogger({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
      registry.setRelay({} as RelayPublisher);
    });

    it('rides the bus while the receiver is registered, asking about the subject it publishes to', async () => {
      // The healthy control: the case below asserts a NEGATIVE.
      await registry.register(tasksReceiver());
      const task = store.createTask(taskInput({ name: 'Healthy bus', runtime: 'claude-code' }));
      const service = rt.scheduler(['claude-code'], relay as unknown as RelayCore, livePredicate);

      await fire(service, task);
      await waitFor(() => expect(relay.publish).toHaveBeenCalledOnce());

      expect(rt.managers['claude-code']!.sendMessage).not.toHaveBeenCalled();
      expect(asked).toEqual([taskDispatchSubject(task.id)]);
      expect(relay.publish.mock.calls[0]![0]).toBe(taskDispatchSubject(task.id));
      await service.stop();
    });

    it('runs DIRECT and COMPLETES once the adapter is unregistered, as disable does', async () => {
      await registry.register(tasksReceiver());
      await registry.unregister('claude-code');
      // What the bus answers with nothing claiming the subject.
      relay.publish.mockResolvedValue({ messageId: 'm-1', deliveredTo: 0 });
      const task = store.createTask(taskInput({ name: 'Disabled bus', runtime: 'claude-code' }));
      const service = rt.scheduler(['claude-code'], relay as unknown as RelayCore, livePredicate);

      const row = await rt.runToCompletion(service, task.id);

      expect(row).toMatchObject({ status: 'completed', error: null });
      expect(relay.publish).not.toHaveBeenCalled();
      expect(rt.managers['claude-code']!.sendMessage).toHaveBeenCalledOnce();
      await service.stop();
    });
  });
});

describe('TaskSchedulerService — the agent a run stands in', () => {
  let store: TaskStore;
  let rt: RuntimeHarness;

  beforeEach(async () => {
    ({ store } = await freshHarness());
    rt = runtimeHarness(store);
  });

  // The agent tier reads the agent's PROJECT directory, not the run's cwd: a
  // `none` agent's cwd falls through to DEFAULT_CWD, which holds no manifest
  // for it, so reading the cwd silently lost its runtime and model.
  it("reads a `none` agent's manifest from its home, not the cwd (DOR-1615 review)", async () => {
    const dir = await writeAgentHome({ mode: 'none' });
    const task = store.createTask(taskInput({ name: 'Agent none', agentId: 'a-1' }));
    const service = new TaskSchedulerService({
      store,
      runtimes: rt.runtimesWith(['claude-code', 'codex']),
      config: { ...DEFAULT_CONFIG },
      meshCore: meshAt(dir),
    });

    const row = await rt.runToCompletion(service, task.id);

    expect(row).toMatchObject({ resolvedRuntime: 'codex', resolvedModel: 'gpt-5.5' });
    await service.stop();
  });

  it('refuses a `none` agent whose default folder is ANOTHER agent`s home', async () => {
    // Spec `agent-home-desk` §3.4: in a dev checkout the default folder is the
    // repo root, the `dorkos` agent's own home.
    const dir = await writeAgentHome({ mode: 'none' });
    registerTestHomes([dir, DEFAULT_CWD]);
    try {
      const task = store.createTask(taskInput({ name: 'Borrowed desk', agentId: 'a-1' }));
      const service = new TaskSchedulerService({
        store,
        runtimes: rt.runtimesWith(['claude-code', 'codex']),
        config: { ...DEFAULT_CONFIG },
        meshCore: meshAt(dir),
      });

      const row = await rt.runToCompletion(service, task.id);

      expect(row.status).toBe('failed');
      expect(row.error).toContain('belongs to another agent');
      expect(row.error).toContain('Set a default folder');
      for (const manager of Object.values(rt.managers)) {
        expect(manager!.sendMessage).not.toHaveBeenCalled();
      }
      await service.stop();
    } finally {
      clearTestHomes();
    }
  });
});

describe('agent CWD resolution (via triggerManualRun)', () => {
  let store: TaskStore;
  let mockAgent: SchedulerAgentManager;
  let agentDir: string;

  beforeEach(async () => {
    // The cwd chain boundary-checks the directory, so the agent sits under a
    // real temp root and that root is the boundary.
    const root = await realpath(tmpdir());
    agentDir = path.join(root, 'projects', 'agent-dir');
    ({ store, mockAgent } = await freshHarness(root));
  });

  /** A scheduler over the mock agent, with a mesh (or none). */
  function withMesh(meshAgents: Record<string, string> | null): TaskSchedulerService {
    return new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(mockAgent),
      config: DEFAULT_CONFIG,
      meshCore: meshAgents ? createMockMeshCore(meshAgents) : null,
    });
  }

  it('records a failed run when the agent is not in the registry', async () => {
    const task = store.createTask(
      taskInput({ name: 'Missing', cron: '0 * * * *', agentId: 'missing-agent' })
    );
    const service = withMesh({});

    const run = await service.triggerManualRun(task.id);
    await waitFor(() => expect(store.getRun(run!.id)!.status).toBe('failed'));

    expect(store.getRun(run!.id)!.error).toContain('not found in registry');
    await service.stop();
  });

  it('leaves a failed direct run pointing at its own transcript (DOR-1567)', async () => {
    // A failed run is exactly when somebody wants to read what it was saying.
    const task = store.createTask(taskInput({ name: 'Boom', cron: '0 * * * *' }));
    vi.mocked(mockAgent.sendMessage).mockImplementation((() => {
      throw new Error('the runtime fell over');
    }) as unknown as SchedulerAgentManager['sendMessage']);
    const service = withMesh(null);

    const run = await service.triggerManualRun(task.id);
    await waitFor(() => expect(store.getRun(run!.id)!.status).toBe('failed'));

    const sessionId = vi.mocked(mockAgent.ensureSession).mock.calls[0]![0];
    expect(sessionId).toMatch(SESSION_UUID_RE);
    expect(store.getRun(run!.id)).toMatchObject({
      sessionId,
      error: expect.stringContaining('the runtime fell over'),
    });
    await service.stop();
  });

  it('runs in the agent projectPath and names the agent on the turn (DOR-2355)', async () => {
    const task = store.createTask(
      taskInput({ name: 'Agent CWD', cron: '0 * * * *', agentId: 'agent-123' })
    );
    const service = withMesh({ 'agent-123': agentDir });

    await service.triggerManualRun(task.id);
    // The turn's own call is the signal; a fixed sleep raced it (DOR-1840).
    await waitFor(() =>
      expect(mockAgent.sendMessage).toHaveBeenCalledWith(
        expect.any(String),
        'test',
        expect.objectContaining({ forAgent: agentDir, cwd: agentDir })
      )
    );
    await service.stop();
  });

  it('falls back to process.cwd() with an agentId but no mesh', async () => {
    const task = store.createTask(
      taskInput({ name: 'CWD Fallback', cron: '0 * * * *', agentId: 'some-agent' })
    );
    const service = withMesh(null);

    await service.triggerManualRun(task.id);
    await waitFor(() =>
      expect(mockAgent.ensureSession).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ cwd: process.cwd() })
      )
    );
    await service.stop();
  });
});
