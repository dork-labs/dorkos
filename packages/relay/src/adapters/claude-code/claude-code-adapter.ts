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
import { extractSessionIdFromSubject } from '../../lib/subject-parser.js';
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

// === ClaudeCodeAdapter ===

/**
 * Runtime adapter that bridges Relay messages to Claude Code Agent SDK sessions.
 *
 * Handles agent-directed messages (`relay.agent.>`) and Tasks scheduler
 * dispatch (`relay.system.tasks.>`). Enforces a concurrency semaphore,
 * TTL budget timeouts, and records trace spans through the delivery lifecycle.
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
  private activeCount = 0;
  /**
   * Runtime-level adapter — owns per-session serial queueing and the
   * abstract open/stream/close lifecycle. The relay-level class delegates
   * queue management to this instance so `RuntimeAdapter`'s shared
   * `enqueueForSession` replaces the former standalone `AgentQueue`.
   */
  private readonly runtimeAdapter: ClaudeCodeRuntimeAdapter;
  /** Unsubscribe function for the `relay.system.approval.>` subscription. */
  private approvalUnsub: (() => void) | null = null;
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
   * Enforces the concurrency semaphore before dispatching.
   *
   * @param subject - The target subject
   * @param envelope - The relay envelope to deliver
   * @param context - Optional context with agent directory and trace info
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

    // Semaphore: reject when at capacity
    if (this.activeCount >= this.config.maxConcurrent) {
      return {
        success: false,
        error: `Adapter at capacity (${this.config.maxConcurrent} concurrent sessions)`,
        durationMs: Date.now() - startTime,
      };
    }

    this.activeCount++;

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
      this.activeCount--;
    }
  }
}
