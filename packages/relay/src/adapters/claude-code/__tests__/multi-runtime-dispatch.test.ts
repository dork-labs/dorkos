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
 *
 * Plus the one shape that names nothing to take: a mesh `relay.agent.<ns>.<id>`
 * subject addresses an AGENT, so the agent's own manifest answers for it
 * (DOR-1627). Without that, an agent-to-agent DM was the one door left where a
 * Codex agent got a Claude Code answer. And once such a conversation has
 * started, the adapter records who owns it and asks about the SESSION from then
 * on (DOR-1774) — otherwise the manifest was re-read every turn and an edit
 * mid-conversation moved it to a program holding none of its transcript.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayEnvelope, TaskDispatchPayload } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { ClaudeCodeAdapter } from '../index.js';
import type {
  AgentRuntimeLike,
  ClaudeCodeAdapterDeps,
  ExecutionSettingsResolver,
  SessionRuntimeBinder,
  TasksStoreLike,
  TraceStoreLike,
  TurnRuntimeTypeResolver,
} from '../index.js';
import type { AdapterContext, RelayPublisher } from '../../../types.js';

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

    it('runs a mesh agent-scoped subject on the default runtime when nothing says otherwise', async () => {
      // No context, so no agent directory, so no manifest to read (DOR-1627).
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

    it('runs an opencode task on opencode when this build registered it', async () => {
      // The receiving half of the scheduler handshake, and not codex-shaped: the
      // scheduler sets `payload.runtime` to whatever the run resolved to, and
      // routing here is by name, so a third runtime needs no code of its own.
      const opencode = mockRuntime('opencode');
      const wide = new ClaudeCodeAdapter(
        'claude-code',
        {},
        {
          ...deps,
          agentRuntimes: new Map([
            ['claude-code', claude],
            ['opencode', opencode],
          ]),
        }
      );
      await wide.start(mockRelay());
      const envelope = taskEnvelope(taskPayload({ runtime: 'opencode', runId: 'run-f' }));

      const result = await wide.deliver(envelope.subject, envelope);

      expect(result.success).toBe(true);
      expect(opencode.sendMessage).toHaveBeenCalledOnce();
      expect(claude.sendMessage).not.toHaveBeenCalled();
      expect(taskStore.updateRun).toHaveBeenCalledWith(
        'run-f',
        expect.objectContaining({ status: 'completed' })
      );
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

  describe('a runtime type outside the built-in literal list', () => {
    // `RUNTIME_TYPES` in `lib/subjects.ts` is a literal list; the adapter's map
    // is open. While the parse read that list, a runtime registered under a type
    // missing from it had its prefix CLAIMED here and its subject read as a mesh
    // namespace — so the turn ran silently on the default runtime, the wrong
    // program answering under the right agent's name. `test-mode-b` is the type
    // that is real today (`DORKOS_TEST_RUNTIME` registers it); any fourth
    // runtime added without editing that list would be the next one.
    let extra: AgentRuntimeLike;
    let wide: ClaudeCodeAdapter;

    beforeEach(async () => {
      extra = mockRuntime('test-mode-b');
      wide = new ClaudeCodeAdapter(
        'claude-code',
        {},
        {
          ...deps,
          agentRuntimes: new Map([
            ['claude-code', claude],
            ['test-mode-b', extra],
          ]),
        }
      );
      await wide.start(mockRelay());
    });

    it('claims a prefix for it', () => {
      expect(wide.subjectPrefix).toContain('relay.agent.test-mode-b.');
    });

    it('routes its session to ITSELF, never silently to the default', async () => {
      const envelope = agentEnvelope('relay.agent.test-mode-b.sess-1');

      const result = await wide.deliver(envelope.subject, envelope);

      expect(result.success).toBe(true);
      expect(extra.sendMessage).toHaveBeenCalledOnce();
      expect(claude.sendMessage).not.toHaveBeenCalled();
    });

    it('asks the settings resolver about it by name', async () => {
      await wide.deliver('relay.agent.test-mode-b.sess-1', agentEnvelope('x'));

      expect(resolveExecutionSettings).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeType: 'test-mode-b' })
      );
    });

    it('still reads a namespace it holds no runtime for as a mesh subject', async () => {
      // The widening is exactly the claimed set and nothing more: a direct
      // agent-to-agent send to `ns-a` names no runtime and takes the default,
      // exactly as before.
      const envelope = agentEnvelope('relay.agent.ns-a.01AGENTULID');

      await wide.deliver(envelope.subject, envelope);

      expect(claude.sendMessage).toHaveBeenCalledOnce();
      expect(extra.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("an agent-to-agent send takes the target agent's own runtime (DOR-1627)", () => {
    // `relay.agent.<namespace>.<agentId>` is the shape one agent's `relay_send`
    // to another arrives on, and it names no runtime. Taking the default for it
    // meant a Codex agent DM'd by another agent was answered by Claude Code —
    // the wrong program under the right agent's name, which is the exact failure
    // DOR-1614 closed for Telegram and Slack.
    const AGENT_ID = '01AGENTULID';
    const MESH_SUBJECT = `relay.agent.ana.${AGENT_ID}`;
    const AGENT_DIR = '/agents/ana';

    /** The context `AdapterManager.buildContext` builds for a mesh subject. */
    function meshContext(directory = AGENT_DIR): AdapterContext {
      return { agent: { directory, runtime: 'claude-code' } };
    }

    let resolveTurnRuntimeType: ReturnType<typeof vi.fn<TurnRuntimeTypeResolver>>;
    let withManifest: ClaudeCodeAdapter;

    beforeEach(async () => {
      resolveTurnRuntimeType = vi.fn<TurnRuntimeTypeResolver>().mockResolvedValue('codex');
      withManifest = new ClaudeCodeAdapter('claude-code', {}, { ...deps, resolveTurnRuntimeType });
      await withManifest.start(mockRelay());
    });

    it('answers on the runtime the target agent runs on, not the default', async () => {
      const envelope = agentEnvelope(MESH_SUBJECT);

      const result = await withManifest.deliver(envelope.subject, envelope, meshContext());

      expect(result.success).toBe(true);
      expect(resolveTurnRuntimeType).toHaveBeenCalledWith({
        agentDirectory: AGENT_DIR,
        // The key this turn will run under — asked with the SESSION, not just
        // the agent, so a conversation's recorded owner can win (DOR-1774).
        sessionId: AGENT_ID,
      });
      expect(codex.sendMessage).toHaveBeenCalledOnce();
      expect(claude.sendMessage).not.toHaveBeenCalled();
    });

    it('asks the settings resolver about that runtime too', async () => {
      // Model and effort live in one runtime's namespace, so a turn routed to
      // codex and priced against claude-code defaults is still half wrong.
      await withManifest.deliver(MESH_SUBJECT, agentEnvelope(MESH_SUBJECT), meshContext());

      expect(resolveExecutionSettings).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeType: 'codex' })
      );
    });

    it('lets the runtime a subject NAMES win over the manifest', async () => {
      // The subject segment comes from a session's own ownership row — the
      // recorded owner of a conversation that already exists, which outranks a
      // preference expressed about the agent (ADR-0255).
      const envelope = agentEnvelope('relay.agent.claude-code.session-2');

      await withManifest.deliver(envelope.subject, envelope, meshContext());

      expect(claude.sendMessage).toHaveBeenCalledOnce();
      expect(codex.sendMessage).not.toHaveBeenCalled();
      expect(resolveTurnRuntimeType).not.toHaveBeenCalled();
    });

    it('leaves a legacy three-token session subject on the default runtime', async () => {
      // That subject names a SESSION, not an agent. Reading a manifest for it
      // would hand a running conversation to a program holding none of it.
      const envelope = agentEnvelope('relay.agent.01AGENTULID');

      await withManifest.deliver(envelope.subject, envelope, meshContext());

      expect(claude.sendMessage).toHaveBeenCalledOnce();
      expect(resolveTurnRuntimeType).not.toHaveBeenCalled();
    });

    it('still refuses a subject naming a runtime this build did not register', async () => {
      // The refusal path must not become reachable-by-manifest: a named runtime
      // is answered by that runtime or by nobody.
      const envelope = agentEnvelope('relay.agent.opencode.session-3');

      const result = await withManifest.deliver(envelope.subject, envelope, meshContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('opencode');
      expect(claude.sendMessage).not.toHaveBeenCalled();
      expect(codex.sendMessage).not.toHaveBeenCalled();
    });

    it('refuses when the agent runs on a runtime the relay does not hold', async () => {
      // A wiring mismatch — the composition root passes every registered runtime
      // — and answering it on another program is the failure this ladder exists
      // to prevent, so it refuses rather than substituting.
      resolveTurnRuntimeType.mockResolvedValue('opencode');
      const envelope = agentEnvelope(MESH_SUBJECT);

      const result = await withManifest.deliver(envelope.subject, envelope, meshContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain('opencode');
      expect(claude.sendMessage).not.toHaveBeenCalled();
      expect(codex.sendMessage).not.toHaveBeenCalled();
    });

    it('answers on the default runtime when the manifest cannot be read', async () => {
      // Tolerant by contract: an unreadable manifest is not a reason to drop
      // somebody's message.
      resolveTurnRuntimeType.mockRejectedValue(new Error('EACCES'));
      const envelope = agentEnvelope(MESH_SUBJECT);

      const result = await withManifest.deliver(envelope.subject, envelope, meshContext());

      expect(result.success).toBe(true);
      expect(claude.sendMessage).toHaveBeenCalledOnce();
    });

    it('does not ask when nothing resolved an agent directory', async () => {
      // A mesh agent the registry does not know: `buildContext` returns nothing,
      // and there is no manifest to look for.
      await withManifest.deliver(MESH_SUBJECT, agentEnvelope(MESH_SUBJECT));

      expect(resolveTurnRuntimeType).not.toHaveBeenCalled();
      expect(claude.sendMessage).toHaveBeenCalledOnce();
    });

    describe('a started conversation keeps the runtime it started on (DOR-1774)', () => {
      // Until this, the host was asked about the AGENT and nothing recorded the
      // answer, so the manifest was re-read every turn: flip it mid-conversation
      // and turn two went to a program handed the id its predecessor minted,
      // holding no transcript for it — the DOR-764 shape, on the one subject
      // family nothing else binds (a chat binding writes an owner when it
      // creates a session; a mesh endpoint creates none).
      //
      // The host ladder is faked here — bind writes a row, resolve prefers it —
      // because what the ADAPTER owes is narrow and mechanical: ask with the key
      // this turn runs under, and record the DURABLE key once the turn has run.
      // That the write and the read are the same row is the host's half, and it
      // is proven against real SQLite in
      // `apps/server/src/services/relay/__tests__/agent-subject-target-runtime.integration.test.ts`.
      const SDK_ID = 'sdk-id-minted-by-codex';

      /** Which runtime each session is recorded as running on. */
      let bound: Map<string, string>;
      let bindSessionRuntime: ReturnType<typeof vi.fn<SessionRuntimeBinder>>;

      /**
       * An adapter whose codex renames its own sessions, so the key turn two
       * resumes under is unambiguously the one codex created.
       */
      function stickyAdapter(codexRuntime: AgentRuntimeLike = codex): ClaudeCodeAdapter {
        const store = new Map<string, string>();
        return new ClaudeCodeAdapter(
          'claude-code',
          {},
          {
            ...deps,
            resolveTurnRuntimeType,
            bindSessionRuntime,
            agentRuntimes: new Map([
              ['claude-code', claude],
              ['codex', { ...codexRuntime, getSdkSessionId: () => SDK_ID }],
            ]),
            agentSessionStore: {
              get: (agentId: string) => store.get(agentId),
              set: (agentId: string, sdkSessionId: string) => void store.set(agentId, sdkSessionId),
            },
          }
        );
      }

      beforeEach(() => {
        bound = new Map<string, string>();
        // First-write-wins, exactly as `persistSessionRuntime` is.
        bindSessionRuntime = vi
          .fn<SessionRuntimeBinder>()
          .mockImplementation(async ({ sessionId, runtimeType }) => {
            if (!bound.has(sessionId)) bound.set(sessionId, runtimeType);
          });
        // The host ladder: the conversation's recorded owner, else the manifest.
        resolveTurnRuntimeType.mockImplementation(async ({ sessionId }) =>
          sessionId ? (bound.get(sessionId) ?? 'codex') : 'codex'
        );
      });

      it('an edit made mid-conversation does not move it to another program', async () => {
        const sticky = stickyAdapter();
        await sticky.start(mockRelay());

        await sticky.deliver(MESH_SUBJECT, agentEnvelope(MESH_SUBJECT), meshContext());
        expect(codex.sendMessage).toHaveBeenCalledWith(
          AGENT_ID,
          expect.anything(),
          expect.anything()
        );

        // The manifest now says claude-code — and turn two is on codex anyway,
        // because turn one recorded who owns this conversation.
        resolveTurnRuntimeType.mockImplementation(async ({ sessionId }) =>
          sessionId ? (bound.get(sessionId) ?? 'claude-code') : 'claude-code'
        );
        await sticky.deliver(MESH_SUBJECT, agentEnvelope(MESH_SUBJECT), meshContext());

        expect(codex.sendMessage).toHaveBeenCalledWith(
          SDK_ID,
          expect.anything(),
          expect.anything()
        );
        expect(claude.sendMessage).not.toHaveBeenCalled();
      });

      it('records the id the NEXT turn resumes under, not the one this turn ran on', async () => {
        // The whole reason the write waits for the end of the turn. Turn one
        // runs under the agent key and the runtime renames the session
        // mid-flight; binding the pre-rename key would bind an id nothing ever
        // looks up again, and the manifest would decide every later turn.
        const sticky = stickyAdapter();
        await sticky.start(mockRelay());

        await sticky.deliver(MESH_SUBJECT, agentEnvelope(MESH_SUBJECT), meshContext());

        expect(bindSessionRuntime).toHaveBeenCalledWith({
          sessionId: SDK_ID,
          runtimeType: 'codex',
          agentDirectory: AGENT_DIR,
        });
      });

      it('records nothing for a first turn that never ran', async () => {
        // The orphan-row hazard `room-turn-runner.ts` documents: a write made on
        // arrival mints one row per message that reached no runtime, and
        // afterwards nothing can tell those from real bindings. `sendMessage`
        // hands back a lazy generator, so a turn thrown out of on the first pull
        // produced no transcript for anyone to be bound to.
        const brokenCodex: AgentRuntimeLike = {
          ...codex,
          sendMessage: vi.fn().mockImplementation(() =>
            (async function* (): AsyncGenerator<StreamEvent> {
              throw new Error('the runtime fell over before it said anything');
            })()
          ),
        };
        const sticky = stickyAdapter(brokenCodex);
        await sticky.start(mockRelay());

        const result = await sticky.deliver(
          MESH_SUBJECT,
          agentEnvelope(MESH_SUBJECT),
          meshContext()
        );

        expect(result.success).toBe(false);
        expect(bindSessionRuntime).not.toHaveBeenCalled();
        expect(bound.size).toBe(0);
      });

      it('records a turn that streamed and then failed, because its transcript is real', async () => {
        // Not gated on the turn SUCCEEDING, deliberately. A turn that spoke and
        // then crashed still wrote a transcript under this id, so who owns it is
        // a fact — and leaving it unbound would expose the conversation most
        // likely to be resumed to exactly the reroute this closes.
        const crashingCodex: AgentRuntimeLike = {
          ...codex,
          sendMessage: vi.fn().mockImplementation(() =>
            (async function* (): AsyncGenerator<StreamEvent> {
              yield { type: 'text_delta', data: { text: 'on it' } } as StreamEvent;
              throw new Error('and then it fell over');
            })()
          ),
        };
        const sticky = stickyAdapter(crashingCodex);
        await sticky.start(mockRelay());

        const result = await sticky.deliver(
          MESH_SUBJECT,
          agentEnvelope(MESH_SUBJECT),
          meshContext()
        );

        expect(result.success).toBe(false);
        expect(bound.get(SDK_ID)).toBe('codex');
      });

      it('leaves the turn standing when the binding write fails', async () => {
        // Bookkeeping about a turn whose answer has already gone out. A
        // `SQLITE_BUSY` on this row must not turn an answered turn into a failed
        // delivery — what is lost is one attribution row, which the next turn on
        // this conversation writes again.
        bindSessionRuntime.mockRejectedValue(new Error('SQLITE_BUSY'));
        const sticky = stickyAdapter();
        await sticky.start(mockRelay());

        const result = await sticky.deliver(
          MESH_SUBJECT,
          agentEnvelope(MESH_SUBJECT),
          meshContext()
        );

        expect(result.success).toBe(true);
        expect(codex.sendMessage).toHaveBeenCalledOnce();
      });

      it('records nothing for a subject that names its own runtime', async () => {
        // That id is a session somebody else created and bound — the cockpit,
        // or the chat binding that minted it. A second opinion written from here
        // is a write about a conversation this shape does not own.
        const sticky = stickyAdapter();
        await sticky.start(mockRelay());

        await sticky.deliver(
          'relay.agent.codex.session-9',
          agentEnvelope('relay.agent.codex.session-9'),
          meshContext()
        );

        expect(codex.sendMessage).toHaveBeenCalledOnce();
        expect(bindSessionRuntime).not.toHaveBeenCalled();
      });
    });

    it('leaves a host that wires no resolver exactly as it was', async () => {
      const envelope = agentEnvelope(MESH_SUBJECT);

      await adapter.deliver(envelope.subject, envelope, meshContext());

      expect(claude.sendMessage).toHaveBeenCalledOnce();
      expect(codex.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe('a refusal costs nothing', () => {
    it('never eats a concurrency slot', async () => {
      // The refusal has to happen BEFORE `capacity.acquire`. If it moves below,
      // a message nothing here can run takes a slot and the next real message
      // queues behind it — one unregistered runtime would throttle the adapter
      // for every agent on it.
      const one = new ClaudeCodeAdapter('claude-code', { maxConcurrent: 1 }, deps);
      await one.start(mockRelay());

      const refused = await one.deliver(
        'relay.agent.opencode.x',
        agentEnvelope('relay.agent.opencode.x')
      );
      expect(refused.success).toBe(false);

      // No await in between, no slot released — if the refusal spent the only
      // slot, this one cannot be served.
      const served = await one.deliver(
        'relay.agent.claude-code.y',
        agentEnvelope('relay.agent.claude-code.y')
      );

      expect(served.success).toBe(true);
      expect(claude.sendMessage).toHaveBeenCalledOnce();
    });
  });
});
