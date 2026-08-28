/**
 * The relay drives every runtime, not just Claude Code (DOR-1614).
 *
 * Everything under the adapter — the agent handler, the task handler — speaks
 * `AgentRuntimeLike` and `StreamEvent` alone, so the only Claude-specific thing
 * about the relay was the single runtime its host injected. These tests pin the
 * three things the adapter itself now decides: WHICH runtime answers a message,
 * that it is taken from what the message NAMES rather than guessed, and that a
 * message for a runtime this build did not register is refused out loud rather
 * than quietly answered by a different program.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayEnvelope, TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { ClaudeCodeAdapter } from '../index.js';
import type {
  AgentRuntimeLike,
  ClaudeCodeAdapterDeps,
  ExecutionSettingsResolver,
  TasksStoreLike,
  TraceStoreLike,
} from '../index.js';
import type { RelayPublisher } from '../../../types.js';

/** A runtime double that finishes a turn immediately. */
function mockRuntime(type: string): AgentRuntimeLike {
  return {
    type,
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(() =>
      (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(false),
    interruptQuery: vi.fn().mockResolvedValue(true),
  };
}

function mockRelay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'r-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function agentEnvelope(subject: string): RelayEnvelope {
  return {
    id: 'msg-001',
    subject,
    from: 'adapter:telegram',
    replyTo: 'relay.human.telegram.tg-main.42',
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 300_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload: { content: 'are you there?' },
  } as unknown as RelayEnvelope;
}

function taskPayload(overrides: Partial<TaskDispatchPayload> = {}): TaskDispatchPayload {
  return {
    type: 'task_dispatch',
    taskId: 'task-1',
    runId: 'run-1',
    prompt: 'do the nightly thing',
    cwd: '/tmp/project',
    permissionMode: 'acceptEdits',
    taskName: 'Nightly',
    cron: '0 2 * * *',
    trigger: 'scheduled',
    ...overrides,
  };
}

function taskEnvelope(payload: TaskDispatchPayload): RelayEnvelope {
  return {
    id: 'msg-task-001',
    subject: `relay.system.tasks.${payload.taskId}`,
    from: 'system:tasks',
    budget: {
      hopCount: 0,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 300_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload,
  } as unknown as RelayEnvelope;
}

describe('the relay adapter picks the runtime a message names', () => {
  let claude: AgentRuntimeLike;
  let codex: AgentRuntimeLike;
  let taskStore: TasksStoreLike;
  let resolveExecutionSettings: ReturnType<typeof vi.fn<ExecutionSettingsResolver>>;
  let deps: ClaudeCodeAdapterDeps;
  let adapter: ClaudeCodeAdapter;
  let relay: RelayPublisher;

  beforeEach(async () => {
    claude = mockRuntime('claude-code');
    codex = mockRuntime('codex');
    taskStore = { updateRun: vi.fn() };
    resolveExecutionSettings = vi.fn<ExecutionSettingsResolver>().mockResolvedValue({});
    deps = {
      agentManager: claude,
      agentRuntimes: new Map([
        ['claude-code', claude],
        ['codex', codex],
      ]),
      approvalAuthorizer: () => true,
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() } as unknown as TraceStoreLike,
      taskStore,
      resolveExecutionSettings,
    };
    adapter = new ClaudeCodeAdapter('claude-code', {}, deps);
    relay = mockRelay();
    await adapter.start(relay);
  });

  describe('agent messages', () => {
    it('runs a codex session on the codex runtime, not the default', async () => {
      // The whole feature. Before this, `relay.agent.codex.<id>` matched the
      // adapter's legacy `relay.agent.` claim and was answered by claude-code —
      // the wrong program, under the right agent's name.
      const envelope = agentEnvelope('relay.agent.codex.session-9');

      const result = await adapter.deliver(envelope.subject, envelope);

      expect(result.success).toBe(true);
      expect(codex.sendMessage).toHaveBeenCalledOnce();
      expect(claude.sendMessage).not.toHaveBeenCalled();
    });

    it('asks the settings resolver about the RESOLVED runtime', async () => {
      // Every tier below the session row is a per-runtime answer, so a resolver
      // asked about the adapter's boot runtime hands a codex turn a Claude
      // model alias.
      const envelope = agentEnvelope('relay.agent.codex.session-9');

      await adapter.deliver(envelope.subject, envelope);

      expect(resolveExecutionSettings).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeType: 'codex' })
      );
    });

    it('runs a claude-code session on claude-code', async () => {
      const envelope = agentEnvelope('relay.agent.claude-code.session-2');

      await adapter.deliver(envelope.subject, envelope);

      expect(claude.sendMessage).toHaveBeenCalledOnce();
      expect(codex.sendMessage).not.toHaveBeenCalled();
    });

    it('runs a legacy three-token subject on the default runtime', async () => {
      // A subject that names no runtime is not a routing failure — it is the
      // shape every relay_send to a mesh agent has always had, and the host's
      // default is what ran it before this existed.
      const envelope = agentEnvelope('relay.agent.01AGENTULID');

      await adapter.deliver(envelope.subject, envelope);

      expect(claude.sendMessage).toHaveBeenCalledOnce();
      expect(codex.sendMessage).not.toHaveBeenCalled();
    });

    it('runs a mesh agent-scoped subject on the default runtime', async () => {
      const envelope = agentEnvelope('relay.agent.ana.01AGENTULID');

      await adapter.deliver(envelope.subject, envelope);

      expect(claude.sendMessage).toHaveBeenCalledOnce();
    });

    it('refuses a session whose runtime this build did not register', async () => {
      // Loudly, and without touching any runtime. Substituting the default here
      // is what "silently wrong" looks like: an answer arrives, in the right
      // chat, from the wrong program, with nothing anywhere saying so.
      const envelope = agentEnvelope('relay.agent.opencode.session-3');

      const result = await adapter.deliver(envelope.subject, envelope);

      expect(result.success).toBe(false);
      expect(result.error).toContain('opencode');
      expect(claude.sendMessage).not.toHaveBeenCalled();
      expect(codex.sendMessage).not.toHaveBeenCalled();
    });

    it('records the refusal on the adapter status', async () => {
      const envelope = agentEnvelope('relay.agent.opencode.session-3');

      await adapter.deliver(envelope.subject, envelope);

      const status = adapter.getStatus();
      expect(status.errorCount).toBe(1);
      expect(status.lastError).toContain('opencode');
    });
  });

  describe('task dispatch', () => {
    it('runs a task on the runtime its payload names', async () => {
      const envelope = taskEnvelope(taskPayload({ runtime: 'codex', runId: 'run-c' }));

      await adapter.deliver(envelope.subject, envelope);

      expect(codex.sendMessage).toHaveBeenCalledOnce();
      expect(claude.sendMessage).not.toHaveBeenCalled();
      expect(taskStore.updateRun).toHaveBeenCalledWith(
        'run-c',
        expect.objectContaining({ status: 'completed' })
      );
    });

    it('runs a task naming no runtime on the default one', async () => {
      const envelope = taskEnvelope(taskPayload({ runId: 'run-d' }));

      await adapter.deliver(envelope.subject, envelope);

      expect(claude.sendMessage).toHaveBeenCalledOnce();
      expect(codex.sendMessage).not.toHaveBeenCalled();
    });

    it('refuses a task naming a runtime this build did not register', async () => {
      const envelope = taskEnvelope(taskPayload({ runtime: 'opencode', runId: 'run-e' }));

      const result = await adapter.deliver(envelope.subject, envelope);

      expect(result.success).toBe(false);
      expect(result.error).toContain('opencode');
      expect(claude.sendMessage).not.toHaveBeenCalled();
      expect(codex.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('what the adapter claims', () => {
    it('claims a runtime-scoped prefix for every runtime it holds', () => {
      // The registry routes by longest matching prefix, so these are what let a
      // future second internal adapter take one runtime without stealing the
      // rest from this one.
      expect(adapter.subjectPrefix).toContain('relay.agent.claude-code.');
      expect(adapter.subjectPrefix).toContain('relay.agent.codex.');
      expect(adapter.subjectPrefix).toContain('relay.agent.');
      expect(adapter.subjectPrefix).toContain('relay.system.tasks.');
    });

    it('holds its default runtime even when the map omits it', () => {
      // A host that passed a map without its own default runtime in it would
      // otherwise route this adapter's unnamed messages nowhere.
      const solo = new ClaudeCodeAdapter(
        'claude-code',
        {},
        { ...deps, agentRuntimes: new Map([['codex', codex]]) }
      );
      expect(solo.subjectPrefix).toContain('relay.agent.claude-code.');
    });
  });

  describe('a host that wires exactly one runtime (every caller before DOR-1614)', () => {
    it('answers every agent subject on that runtime', async () => {
      const solo = new ClaudeCodeAdapter('claude-code', {}, { ...deps, agentRuntimes: undefined });
      await solo.start(mockRelay());

      const envelope = agentEnvelope('relay.agent.claude-code.session-1');
      const result = await solo.deliver(envelope.subject, envelope);

      expect(result.success).toBe(true);
      expect(claude.sendMessage).toHaveBeenCalledOnce();
    });
  });
});
