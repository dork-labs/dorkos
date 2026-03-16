/**
 * Claude Code adapter for the Relay message bus.
 *
 * Routes messages between the Relay bus and Claude Agent SDK sessions.
 * Delegates agent message handling, pulse execution, and queue management
 * to focused sub-modules.
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
import { handlePulseMessage } from './pulse-handler.js';
import { AgentQueue } from './queue.js';
import type {
  ClaudeCodeAdapterConfig,
  ClaudeCodeAdapterDeps,
  ResolvedConfig,
} from './types.js';

// Re-export all public types from the shared types module
export type {
  ClaudeCodeAdapterConfig,
  ClaudeCodeAdapterDeps,
  AgentRuntimeLike,
  AgentSessionStoreLike,
  PulseStoreLike,
} from './types.js';

// Re-export TraceStoreLike for backward compatibility
export type { TraceStoreLike } from '../../types.js';

// === Manifest ===

/** Static adapter manifest for the Claude Code built-in adapter. */
export const CLAUDE_CODE_MANIFEST: AdapterManifest = {
  type: 'claude-code',
  displayName: 'Claude Code',
  description: 'Routes messages to Claude Agent SDK sessions. Auto-configured.',
  iconEmoji: '🤖',
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

/** Subject prefix for agent-bound messages. */
const AGENT_SUBJECT_PREFIX = 'relay.agent.';

/** Subject prefix for Pulse dispatch messages. */
const PULSE_SUBJECT_PREFIX = 'relay.system.pulse.';

// === ClaudeCodeAdapter ===

/**
 * Runtime adapter that bridges Relay messages to Claude Code Agent SDK sessions.
 *
 * Handles agent-directed messages (`relay.agent.>`) and Pulse scheduler
 * dispatch (`relay.system.pulse.>`). Enforces a concurrency semaphore,
 * TTL budget timeouts, and records trace spans through the delivery lifecycle.
 */
export class ClaudeCodeAdapter implements RelayAdapter {
  readonly id: string;
  readonly subjectPrefix = [AGENT_SUBJECT_PREFIX, PULSE_SUBJECT_PREFIX] as const;
  readonly displayName = 'Claude Code';

  private readonly config: ResolvedConfig;
  private readonly deps: ClaudeCodeAdapterDeps;
  private relay: RelayPublisher | null = null;
  private activeCount = 0;
  private readonly agentQueue = new AgentQueue();
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
   * @param deps - Injected dependencies (agentManager, traceStore, pulseStore)
   */
  constructor(id: string, config: ClaudeCodeAdapterConfig, deps: ClaudeCodeAdapterDeps) {
    this.id = id;
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 3,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 300_000,
      defaultCwd: config.defaultCwd ?? process.cwd(),
    };
    this.deps = deps;
  }

  /**
   * Start the adapter — store relay publisher and mark as connected.
   *
   * @param relay - The RelayPublisher used to publish response events
   */
  async start(relay: RelayPublisher): Promise<void> {
    this.relay = relay;
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
    this.relay = null;
    this.agentQueue.clear();
    this.status = { ...this.status, state: 'disconnected' };
  }

  /**
   * Return the current adapter status snapshot.
   */
  getStatus(): AdapterStatus {
    return { ...this.status, queuedMessages: this.agentQueue.size };
  }

  /**
   * Deliver a Relay message to an agent session or Pulse runner.
   *
   * Routes to handleAgentMessage or handlePulseMessage based on subject prefix.
   * Enforces the concurrency semaphore before dispatching.
   *
   * @param subject - The target subject
   * @param envelope - The relay envelope to deliver
   * @param context - Optional context with agent directory and trace info
   */
  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    context?: AdapterContext,
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
      if (subject.startsWith(PULSE_SUBJECT_PREFIX)) {
        return await handlePulseMessage(
          subject,
          envelope,
          context,
          startTime,
          { defaultCwd: this.config.defaultCwd },
          {
            agentManager: this.deps.agentManager,
            traceStore: this.deps.traceStore,
            pulseStore: this.deps.pulseStore,
            logger: this.deps.logger,
          },
          this.relay,
        );
      }

      // Extract agentId for queue key. If extraction fails, handleAgentMessage
      // will return the error — we still want that error to be returned, so we
      // must still call handleAgentMessage (not bypass it).
      const queueKey = subject.split('.')[2] ?? subject;
      return await this.agentQueue.process(queueKey, () =>
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
          this.relay,
        ),
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
