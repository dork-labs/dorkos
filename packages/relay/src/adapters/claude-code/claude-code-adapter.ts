/**
 * Claude Code adapter for the Relay message bus.
 *
 * Routes messages between the Relay bus and Claude Agent SDK sessions.
 * Delegates agent message handling and tasks execution to focused
 * sub-modules. Runtime-level concerns (per-session serial queueing,
 * open/stream/close lifecycle) are delegated to `ClaudeCodeRuntimeAdapter`,
 * a subclass of the shared `RuntimeAdapter` base.
 *
 * @module relay/adapters/claude-code-adapter
 */

/**
 * ID GLOSSARY — three distinct IDs used in the relay pipeline:
 *
 * @example
 * agentId      — Mesh ULID (e.g., '01JN4M2X5SZMHXP3EZFM9DWRXFK')
 *                Stable across server restarts. Extracted from relay.agent.{agentId} subjects.
 *                Use this for relay_send subjects and mesh_inspect calls.
 *
 * sdkSessionId — SDK UUID (e.g., '550e8400-e29b-41d4-a716-446655440000')
 *                Assigned by Claude Agent SDK on first message. Maps to JSONL transcript file.
 *                Changes on each full session reset; persisted by AgentSessionStore.
 *
 * ccaSessionKey — CCA's internal lookup key for AgentManager
 *                 = sdkSessionId (from AgentSessionStore) if a prior mapping exists
 *                 = agentId (Mesh ULID) on first-ever message to this agent
 */
import type { RelayEnvelope, AdapterManifest } from '@dorkos/shared/relay-schemas';
import type {
  RelayAdapter,
  RelayPublisher,
  AdapterStatus,
  AdapterContext,
  DeliveryResult,
} from '../../types.js';
import { handleAgentMessage } from './agent-handler.js';
import { handleTasksMessage } from './task-handler.js';
import { ClaudeCodeRuntimeAdapter } from './claude-code-runtime-adapter.js';
import { subscribeApprovalHandler } from './approval-handler.js';
import { RunningTasks, subscribeTaskCancelHandler } from './task-cancel-handler.js';
import { extractSessionIdFromSubject } from '../../lib/subjects.js';
import { CapacityHold, type SlotOutcome } from './capacity-hold.js';
import type { ClaudeCodeAdapterConfig, ClaudeCodeAdapterDeps, ResolvedConfig } from './types.js';

// Re-export all public types from the shared types module
export type {
  ClaudeCodeAdapterConfig,
  ClaudeCodeAdapterDeps,
  AgentRuntimeLike,
  AgentSessionStoreLike,
  TasksStoreLike,
} from './types.js';

// Re-export TraceStoreLike for backward compatibility
export type { TraceStoreLike } from '../../types.js';

// === Manifest ===

/** Static adapter manifest for the Claude Code built-in adapter. */
export const CLAUDE_CODE_MANIFEST: AdapterManifest = {
  type: 'claude-code',
  displayName: 'Claude Code',
  description: 'Routes messages to Claude Agent SDK sessions. Auto-configured.',
  iconId: 'claude-code',
  category: 'internal',
  builtin: true,
  multiInstance: false,
  configFields: [
    {
      key: 'maxConcurrent',
      label: 'Max Concurrent Sessions',
      type: 'number',
      required: false,
      default: 3,
      description: 'Maximum number of concurrent agent sessions.',
    },
    {
      key: 'defaultTimeoutMs',
      label: 'Default Timeout (ms)',
      type: 'number',
      required: false,
      default: 300000,
      description: 'Default timeout for agent sessions in milliseconds.',
    },
  ],
};

// === Constants ===

/**
 * Runtime-scoped subject prefix for agent-bound messages.
 *
 * Matches subjects produced by `BindingRouter` when the runtime resolver is
 * wired (`relay.agent.<runtimeType>.<sessionId>`). Listed first so that, in a
 * future multi-adapter configuration, this specific prefix wins over the
 * broader legacy catch-all.
 */
const AGENT_SUBJECT_PREFIX_RUNTIME_SCOPED = 'relay.agent.claude-code.';

/**
 * Legacy subject prefix for agent-bound messages.
 *
 * Matches subjects produced by `BindingRouter` when no runtime resolver is
 * configured or when resolution fails — the three-part shape
 * `relay.agent.<sessionId>`. Also matches direct agent-to-agent relay sends
 * addressed by mesh agentId, which historically share the same prefix.
 * Retained so legacy / fallback routing keeps working; downstream parsing
 * uses `parseAgentSubject` to extract the sessionId from either shape.
 */
const AGENT_SUBJECT_PREFIX_LEGACY = 'relay.agent.';

/** Subject prefix for Tasks dispatch messages. */
const TASKS_SUBJECT_PREFIX = 'relay.system.tasks.';

/**
 * What the adapter reports when it never got a slot.
 *
 * Every one of these is a real failure the delivery pipeline dead-letters. Only
 * the two capacity outcomes carry `at_capacity`: a stop is not the runtime being
 * busy, and reporting it as one would put "the agent was busy" in a chat whose
 * server was shutting down.
 *
 * @param outcome - How the slot request ended. `'acquired'` never reaches here.
 * @param config - The resolved adapter config, for the numbers in the message.
 * @param durationMs - How long the caller spent, including any wait.
 * @param ceilingMs - The hold ceiling that actually applied to this delivery:
 *   the shorter of the adapter's own and what was left of the envelope's TTL.
 */
function slotRefusal(
  outcome: Exclude<SlotOutcome, 'acquired'>,
  config: ResolvedConfig,
  durationMs: number,
  ceilingMs: number
): DeliveryResult {
  switch (outcome) {
    case 'line_full':
      return {
        success: false,
        // The code, not the prose, is what downstream reacts to: the chat
        // notice for a busy runtime must not hinge on this sentence's wording.
        code: 'at_capacity',
        // Covers all three reasons a delivery took no slot and did not wait:
        // the line was full, nobody licensed it to wait, or its own TTL was
        // already spent. All of them are this sentence.
        error: `Adapter at capacity (${config.maxConcurrent} concurrent sessions) and this message could not wait`,
        durationMs,
      };
    case 'held_too_long':
      return {
        success: false,
        code: 'at_capacity',
        // The ceiling that actually applied, which is the message's own
        // remaining TTL whenever that was shorter than the adapter's — quoting
        // `defaultTimeoutMs` here reported a wait that never happened.
        error: `Waited up to ${ceilingMs}ms for a free session slot and none came free`,
        durationMs,
      };
    case 'stopped':
      return {
        success: false,
        error: 'Adapter stopped while this message was waiting for a free session slot',
        durationMs,
      };
  }
}

// === ClaudeCodeAdapter ===

/**
 * Runtime adapter that bridges Relay messages to Claude Code Agent SDK sessions.
 *
 * Handles agent-directed messages (`relay.agent.>`) and Tasks scheduler
 * dispatch (`relay.system.tasks.>`). Enforces a concurrency ceiling — one an
 * agent message **waits** on rather than being refused by (`capacity-hold.ts`)
 * — TTL budget timeouts, and records trace spans through the delivery lifecycle.
 *
 * Two control signals arrive by SUBSCRIPTION rather than delivery — tool
 * approvals and run stop requests — because each must reach a turn that is
 * already holding one of those concurrency slots.
 */
export class ClaudeCodeAdapter implements RelayAdapter {
  readonly id: string;
  readonly subjectPrefix = [
    AGENT_SUBJECT_PREFIX_RUNTIME_SCOPED,
    AGENT_SUBJECT_PREFIX_LEGACY,
    TASKS_SUBJECT_PREFIX,
  ] as const;
  readonly displayName = 'Claude Code';

  private readonly config: ResolvedConfig;
  private readonly deps: ClaudeCodeAdapterDeps;
  private relay: RelayPublisher | null = null;
  /**
   * The concurrency ceiling, and the line of deliveries waiting on it.
   *
   * A message that arrives with every slot taken **waits** rather than being
   * turned away (ADR `260819-034718`, following `260818-234541`'s shape for
   * rooms). See
   * `capacity-hold.ts` for what makes that promise keepable.
   */
  private readonly capacity: CapacityHold;
  /**
   * Runtime-level adapter — owns per-session serial queueing and the
   * abstract open/stream/close lifecycle. The relay-level class delegates
   * queue management to this instance so `RuntimeAdapter`'s shared
   * `enqueueForSession` replaces the former standalone `AgentQueue`.
   */
  private readonly runtimeAdapter: ClaudeCodeRuntimeAdapter;
  /** Unsubscribe function for the `relay.system.approval.>` subscription. */
  private approvalUnsub: (() => void) | null = null;
  /** Unsubscribe function for the run stop-request subscription (DOR-808). */
  private taskCancelUnsub: (() => void) | null = null;
  /** The task runs this adapter is executing, so a stop can reach them. */
  private readonly runningTasks = new RunningTasks();
  private status: AdapterStatus = {
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };

  /**
   * Create a Claude Code relay adapter.
   *
   * @param id - Unique adapter identifier (e.g., 'claude-code')
   * @param config - Adapter configuration (concurrency, timeout, default cwd)
   * @param deps - Injected dependencies (agentManager, traceStore, taskStore)
   */
  constructor(id: string, config: ClaudeCodeAdapterConfig, deps: ClaudeCodeAdapterDeps) {
    this.id = id;
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 3,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 300_000,
      defaultCwd: config.defaultCwd ?? process.cwd(),
    };
    this.deps = deps;
    this.capacity = new CapacityHold({
      maxConcurrent: this.config.maxConcurrent,
      // NOT the ceiling on the turn that is in the way: that turn runs to its
      // own envelope's TTL (an hour by default), so a hold can expire while the
      // agent is still legitimately busy. This is the longest we are willing to
      // hold a person's message without an answer, reusing the only duration
      // this adapter already has rather than inventing a setting.
      holdCeilingMs: this.config.defaultTimeoutMs,
    });
    this.runtimeAdapter = new ClaudeCodeRuntimeAdapter(
      { runtimeType: 'claude-code', ...(deps.logger ? { logger: deps.logger } : {}) },
      deps.agentManager
    );
  }

  /**
   * Start the adapter — store relay publisher and mark as connected.
   *
   * @param relay - The RelayPublisher used to publish response events
   */
  async start(relay: RelayPublisher): Promise<void> {
    this.relay = relay;
    this.approvalUnsub = subscribeApprovalHandler(
      relay,
      this.deps.agentManager,
      this.deps.logger ?? console,
      this.deps.approvalAuthorizer
    );
    this.taskCancelUnsub = subscribeTaskCancelHandler(
      relay,
      this.runningTasks,
      this.deps.logger ?? console
    );
    this.status = {
      state: 'connected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
      startedAt: new Date().toISOString(),
    };
  }

  /**
   * Stop the adapter — clear relay reference, drain in-flight queue entries, and mark as disconnected.
   */
  async stop(): Promise<void> {
    // Unsubscribe from approval responses before clearing relay reference
    this.approvalUnsub?.();
    this.approvalUnsub = null;
    this.taskCancelUnsub?.();
    this.taskCancelUnsub = null;
    // The runs themselves are finalized by their own handlers; only the
    // registry is torn down here, so a stop request arriving after a restart
    // is answered with the truth instead of aborting a stranger's run.
    this.runningTasks.clear();
    // A hold is a promise that a turn will run, and this adapter is about to
    // stop being able to keep it. Every waiter settles now, as a failed
    // delivery, so an ADAPTER restart tells the chats that were waiting. On a
    // whole-server stop the bus and the chat adapters are already down by the
    // time this runs, and the message is simply dropped.
    this.capacity.drain();
    this.relay = null;
    this.runtimeAdapter.reset();
    this.status = { ...this.status, state: 'disconnected' };
  }

  /**
   * Return the current adapter status snapshot.
   */
  getStatus(): AdapterStatus {
    return { ...this.status, queuedMessages: this.runtimeAdapter.queueSize };
  }

  /**
   * Deliver a Relay message to an agent session or Tasks runner.
   *
   * Routes to handleAgentMessage or handleTasksMessage based on subject prefix.
   * Takes a concurrency slot before dispatching, **waiting** for one when every
   * slot is busy rather than turning the message away.
   *
   * @param subject - The target subject
   * @param envelope - The relay envelope to deliver
   * @param context - Optional context with agent directory, trace info, and the
   *   {@link AdapterContext.onHeld} callback that tells a waiting chat it is
   *   waiting.
   */
  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    context?: AdapterContext
  ): Promise<DeliveryResult> {
    const startTime = Date.now();
    this.status = {
      ...this.status,
      messageCount: {
        ...this.status.messageCount,
        inbound: this.status.messageCount.inbound + 1,
      },
    };

    // A hold may not outlive the message it holds. `handleAgentMessage` gives
    // the turn whatever is left of the envelope's TTL, and falls back to
    // `defaultTimeoutMs` when nothing is — so a wait that ate the whole TTL
    // would start the turn on a FRESH full budget, an hour-old message running
    // as if it had just arrived. The wait stops when the message's own time is
    // up, and a message with no time left never waits at all.
    const ttlRemainingMs = envelope.budget.ttl - Date.now();
    const slot = await this.capacity.acquire({
      // Only a delivery the pipeline licensed may wait, and the pipeline is the
      // only thing that can tell which those are: it sets `onHeld` when a
      // person in a bridged chat is the reader, and on nothing else (see
      // {@link AdapterContext.onHeld}). Deciding this from the subject here
      // instead would put the same rule in two modules — and an awaited caller
      // parked in this line loses its reply rather than waiting for it.
      mayWait: context?.onHeld !== undefined && ttlRemainingMs > 0,
      ceilingMs: ttlRemainingMs,
      ...(context?.onHeld ? { onHeld: context.onHeld } : {}),
    });
    if (slot !== 'acquired') {
      return slotRefusal(
        slot,
        this.config,
        Date.now() - startTime,
        Math.min(this.config.defaultTimeoutMs, Math.max(ttlRemainingMs, 0))
      );
    }

    try {
      if (subject.startsWith(TASKS_SUBJECT_PREFIX)) {
        return await handleTasksMessage(
          subject,
          envelope,
          context,
          startTime,
          { defaultCwd: this.config.defaultCwd },
          {
            agentManager: this.deps.agentManager,
            traceStore: this.deps.traceStore,
            taskStore: this.deps.taskStore,
            runningTasks: this.runningTasks,
            logger: this.deps.logger,
          },
          this.relay
        );
      }

      // Extract agentId/sessionId for queue key via the shared parser so both
      // the legacy (`relay.agent.<sessionId>`) and runtime-scoped
      // (`relay.agent.<runtimeType>.<sessionId>`) subject shapes produce the
      // same queue key. If extraction fails we still fall through so
      // handleAgentMessage can return the proper error (keeping pre-parser
      // behavior for malformed inputs).
      const queueKey = extractSessionIdFromSubject(subject) ?? subject;
      return await this.runtimeAdapter.enqueue(queueKey, () =>
        handleAgentMessage(
          subject,
          envelope,
          context,
          startTime,
          { defaultTimeoutMs: this.config.defaultTimeoutMs },
          {
            agentManager: this.deps.agentManager,
            traceStore: this.deps.traceStore,
            agentSessionStore: this.deps.agentSessionStore,
            resolveExecutionSettings: this.deps.resolveExecutionSettings,
            logger: this.deps.logger,
          },
          this.relay
        )
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.status = {
        ...this.status,
        errorCount: this.status.errorCount + 1,
        lastError: errorMsg,
        lastErrorAt: new Date().toISOString(),
      };
      return {
        success: false,
        error: errorMsg,
        durationMs: Date.now() - startTime,
      };
    } finally {
      // The one release seam. A turn that answered, threw, timed out or was
      // stopped all arrive here, which is what makes the waiting line's promise
      // keepable: the next held delivery starts from inside this call.
      this.capacity.release();
    }
  }
}
