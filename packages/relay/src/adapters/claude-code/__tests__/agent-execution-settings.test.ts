/**
 * What model a relay-triggered turn runs on.
 *
 * The adapter itself knows nothing about manifests or config — it asks the
 * {@link ExecutionSettingsResolver} its host wired in and passes the answer
 * through. These tests pin the three things that are the adapter's own job:
 * asking with the right session key and directory, forwarding the answer to
 * both `ensureSession` and `sendMessage`, and never letting that answer touch
 * the permission mode the relay resolved for itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { ClaudeCodeAdapter } from '../index.js';
import type {
  AgentRuntimeLike,
  AgentSessionStoreLike,
  ExecutionSettingsResolver,
  TraceStoreLike,
  ClaudeCodeAdapterDeps,
} from '../index.js';
import type { RelayPublisher, AdapterContext } from '../../../types.js';

function createMockAgentManager(): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
  };
}

function createMockTraceStore(): TraceStoreLike {
  return { insertSpan: vi.fn(), updateSpan: vi.fn() };
}

function createMockRelay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'resp-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function createTestEnvelope(overrides?: Partial<RelayEnvelope>): RelayEnvelope {
  return {
    id: 'msg-001',
    subject: 'relay.agent.agent-ulid-1',
    from: 'agent:01ANOTHERAGENT',
    replyTo: 'relay.inbox.01ANOTHERAGENT',
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 300_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload: { content: 'What is the status?' },
    ...overrides,
  };
}

/** The Mesh context the adapter manager builds for `relay.agent.*`. */
const MESH_CONTEXT: AdapterContext = {
  agent: { directory: '/projects/ana', runtime: 'claude-code' },
};

describe('a relay turn runs on the agent it addressed', () => {
  let agentManager: AgentRuntimeLike;
  let deps: ClaudeCodeAdapterDeps;
  let relay: RelayPublisher;
  let adapter: ClaudeCodeAdapter;
  let resolveExecutionSettings: ReturnType<typeof vi.fn<ExecutionSettingsResolver>>;

  beforeEach(() => {
    agentManager = createMockAgentManager();
    relay = createMockRelay();
    resolveExecutionSettings = vi.fn<ExecutionSettingsResolver>().mockResolvedValue({
      model: 'claude-haiku-4-5',
    });
    deps = {
      agentManager,
      traceStore: createMockTraceStore(),
      resolveExecutionSettings,
    };
    adapter = new ClaudeCodeAdapter('claude-code', {}, deps);
  });

  it("starts the session on the agent's own model", async () => {
    // The reported break: an agent pinned to one model answered agent-to-agent
    // messages on whatever the server defaulted to, because nothing on this
    // path ever read the manifest. `ensureSession` is where it has to land —
    // the claude-code runtime reads `session.model` at launch, and that field
    // is written once, when the session is created.
    await adapter.start(relay);
    const envelope = createTestEnvelope();

    await adapter.deliver(envelope.subject, envelope, MESH_CONTEXT);

    expect(agentManager.ensureSession).toHaveBeenCalledWith(
      'agent-ulid-1',
      expect.objectContaining({ model: 'claude-haiku-4-5' })
    );
    const sendCall = vi.mocked(agentManager.sendMessage).mock.calls[0];
    expect(sendCall[2]).toEqual(expect.objectContaining({ model: 'claude-haiku-4-5' }));
  });

  it('carries the effort through too', async () => {
    resolveExecutionSettings.mockResolvedValue({ model: 'opus', effort: 'high' });
    await adapter.start(relay);
    const envelope = createTestEnvelope();

    await adapter.deliver(envelope.subject, envelope, MESH_CONTEXT);

    expect(agentManager.ensureSession).toHaveBeenCalledWith(
      'agent-ulid-1',
      expect.objectContaining({ model: 'opus', effort: 'high' })
    );
  });

  it('asks about the session it is about to run, and the directory that holds the manifest', async () => {
    await adapter.start(relay);
    const envelope = createTestEnvelope();

    await adapter.deliver(envelope.subject, envelope, MESH_CONTEXT);

    expect(resolveExecutionSettings).toHaveBeenCalledWith({
      sessionId: 'agent-ulid-1',
      agentDirectory: '/projects/ana',
    });
  });

  it('asks about the directory the turn will actually run in', async () => {
    // A binding that names its own cwd moves the whole turn there, so that is
    // the project whose manifest applies — the same directory the server would
    // record as this session's `agentPath`.
    await adapter.start(relay);
    const envelope = createTestEnvelope({
      payload: { content: 'What is the status?', cwd: '/projects/other' },
    });

    await adapter.deliver(envelope.subject, envelope, MESH_CONTEXT);

    expect(resolveExecutionSettings).toHaveBeenCalledWith({
      sessionId: 'agent-ulid-1',
      agentDirectory: '/projects/other',
    });
  });

  it('asks with no directory at all when nothing resolved one', async () => {
    await adapter.start(relay);
    const envelope = createTestEnvelope();

    await adapter.deliver(envelope.subject, envelope, undefined);

    expect(resolveExecutionSettings).toHaveBeenCalledWith({ sessionId: 'agent-ulid-1' });
  });

  it('asks about the SDK session a second message resumes, not the agent id', async () => {
    // The session key is the persisted SDK id once one exists, and that is the
    // id a stored setting is filed under — asking with the agent id would miss
    // the row and re-seed the manifest over the person's own choice.
    const agentSessionStore: AgentSessionStoreLike = {
      get: vi.fn().mockReturnValue('sdk-uuid-42'),
      set: vi.fn(),
    };
    adapter = new ClaudeCodeAdapter('claude-code', {}, { ...deps, agentSessionStore });
    await adapter.start(relay);
    const envelope = createTestEnvelope();

    await adapter.deliver(envelope.subject, envelope, MESH_CONTEXT);

    expect(resolveExecutionSettings).toHaveBeenCalledWith({
      sessionId: 'sdk-uuid-42',
      agentDirectory: '/projects/ana',
    });
    expect(agentManager.ensureSession).toHaveBeenCalledWith(
      'sdk-uuid-42',
      expect.objectContaining({ model: 'claude-haiku-4-5' })
    );
  });

  it('leaves the relay permission mode alone', async () => {
    // The relay's own permission handling is not this resolver's business:
    // absence is not consent (DOR-604), so the binding's mode — or `default` —
    // stays exactly what it was.
    await adapter.start(relay);
    const envelope = createTestEnvelope({
      payload: {
        content: 'What is the status?',
        __bindingPermissions: { permissionMode: 'bypassPermissions' },
      },
    });

    await adapter.deliver(envelope.subject, envelope, MESH_CONTEXT);

    expect(agentManager.ensureSession).toHaveBeenCalledWith(
      'agent-ulid-1',
      expect.objectContaining({ permissionMode: 'bypassPermissions', model: 'claude-haiku-4-5' })
    );
  });

  it('runs the turn anyway when nothing can answer', async () => {
    // A host that wired no resolver — every test double in this package, and
    // any embedder — behaves exactly as before: no model key at all, so the
    // runtime picks.
    adapter = new ClaudeCodeAdapter(
      'claude-code',
      {},
      { ...deps, resolveExecutionSettings: undefined }
    );
    await adapter.start(relay);
    const envelope = createTestEnvelope();

    await adapter.deliver(envelope.subject, envelope, MESH_CONTEXT);

    const ensureCall = vi.mocked(agentManager.ensureSession).mock.calls[0];
    expect(ensureCall[1]).not.toHaveProperty('model');
    expect(ensureCall[1]).not.toHaveProperty('effort');
  });

  it('still answers when the settings lookup fails', async () => {
    // A settings problem is a reason to fall through to the runtime's own
    // default, never a reason to drop somebody's message.
    resolveExecutionSettings.mockRejectedValue(new Error('database is locked'));
    await adapter.start(relay);
    const envelope = createTestEnvelope();

    const result = await adapter.deliver(envelope.subject, envelope, MESH_CONTEXT);

    expect(result.success).toBe(true);
    const ensureCall = vi.mocked(agentManager.ensureSession).mock.calls[0];
    expect(ensureCall[1]).not.toHaveProperty('model');
  });
});
