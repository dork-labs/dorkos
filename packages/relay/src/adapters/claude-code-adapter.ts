/**
 * Runtime adapter that bridges Relay messages to Claude Code Agent SDK sessions.
 *
 * Handles two subject patterns:
 * - `relay.agent.>` — agent-directed messages
 * - `relay.system.pulse.>` — Pulse scheduler dispatch
 *
 * Replaces the temporary MessageReceiver bridge with a unified adapter
 * that plugs into the AdapterRegistry alongside Telegram and webhook adapters.
 *
 * @module relay/adapters/claude-code-adapter
 */
import { randomUUID } from 'node:crypto';
import type { RelayEnvelope, AdapterManifest } from '@dorkos/shared/relay-schemas';
import { PulseDispatchPayloadSchema } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import type {
  RelayAdapter,
  RelayPublisher,
  AdapterStatus,
  AdapterContext,
  DeliveryResult,
  PublishOptions,
} from '../types.js';

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

/** Maximum characters to collect for run output summary. */
const OUTPUT_SUMMARY_MAX_CHARS = 1000;

/** Subject prefix for agent-bound messages. */
const AGENT_SUBJECT_PREFIX = 'relay.agent.';

/** Subject prefix for Pulse dispatch messages. */
const PULSE_SUBJECT_PREFIX = 'relay.system.pulse.';

// === Dependency interfaces ===

/** Configuration for the ClaudeCodeAdapter. */
export interface ClaudeCodeAdapterConfig {
  /** Maximum concurrent agent sessions. Default: 3 */
  maxConcurrent?: number;
  /** Default session timeout in ms (used when envelope has no TTL). Default: 300000 (5 min) */
  defaultTimeoutMs?: number;
  /** Default working directory for agents without explicit directory */
  defaultCwd?: string;
}

/**
 * Minimal interface for agent session management.
 *
 * Matches the existing AgentManagerLike from message-receiver.ts.
 */
export interface AgentManagerLike {
  ensureSession(
    sessionId: string,
    opts: { permissionMode: string; cwd?: string; hasStarted?: boolean },
  ): void;
  sendMessage(
    sessionId: string,
    content: string,
    opts?: { permissionMode?: string; cwd?: string },
  ): AsyncGenerator<StreamEvent>;
}

/** Minimal TraceStore interface for dependency injection. Accepts loose span shapes. */
export interface TraceStoreLike {
  insertSpan(span: {
    messageId: string;
    traceId: string;
    subject: string;
    status?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  }): void;
  updateSpan(messageId: string, update: {
    status?: string;
    deliveredAt?: string | number | null;
    processedAt?: string | number | null;
    error?: string | null;
    [key: string]: unknown;
  }): void;
}

/** Minimal PulseStore interface for Pulse run lifecycle updates. */
export interface PulseStoreLike {
  updateRun(runId: string, update: Record<string, unknown>): void;
}

/** Dependencies injected into ClaudeCodeAdapter. */
export interface ClaudeCodeAdapterDeps {
  agentManager: AgentManagerLike;
  traceStore: TraceStoreLike;
  pulseStore?: PulseStoreLike;
}

// === Resolved config type (all fields required after construction) ===

interface ResolvedConfig {
  maxConcurrent: number;
  defaultTimeoutMs: number;
  defaultCwd: string;
}

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
  private status: AdapterStatus = {
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  };

  /**
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
   * Stop the adapter — clear relay reference and mark as disconnected.
   */
  async stop(): Promise<void> {
    this.relay = null;
    this.status.state = 'disconnected';
  }

  /**
   * Return the current adapter status snapshot.
   */
  getStatus(): AdapterStatus {
    return { ...this.status };
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
    this.status.messageCount.inbound++;

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
        return await this.handlePulseMessage(subject, envelope, context, startTime);
      }
      return await this.handleAgentMessage(subject, envelope, context, startTime);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.status.errorCount++;
      this.status.lastError = errorMsg;
      this.status.lastErrorAt = new Date().toISOString();
      return {
        success: false,
        error: errorMsg,
        durationMs: Date.now() - startTime,
      };
    } finally {
      this.activeCount--;
    }
  }

  // === Private: agent message handling ===

  /**
   * Handle a relay.agent.{sessionId} message.
   *
   * Resolves the session ID, records trace spans, formats the prompt with
   * relay context, and streams the agent response back to envelope.replyTo.
   */
  private async handleAgentMessage(
    subject: string,
    envelope: RelayEnvelope,
    context: AdapterContext | undefined,
    startTime: number,
  ): Promise<DeliveryResult> {
    const sessionId = this.extractSessionId(subject);
    if (!sessionId) {
      return {
        success: false,
        error: `Could not extract sessionId from subject: ${subject}`,
        durationMs: Date.now() - startTime,
      };
    }

    const traceId = randomUUID();
    const spanId = randomUUID();
    const now = Date.now();

    // Record trace span as pending
    const span = {
      messageId: envelope.id,
      traceId,
      spanId,
      parentSpanId: context?.trace?.parentSpanId ?? null,
      subject: envelope.subject,
      fromEndpoint: envelope.from,
      toEndpoint: `agent:${sessionId}`,
      status: 'pending',
      budgetHopsUsed: envelope.budget.hopCount,
      budgetTtlRemainingMs: envelope.budget.ttl - now,
      sentAt: now,
      deliveredAt: null,
      processedAt: null,
      error: null,
    };
    this.deps.traceStore.insertSpan(span);

    // Resolve agent working directory from context or default
    const agentCwd = context?.agent?.directory ?? this.config.defaultCwd;

    this.deps.agentManager.ensureSession(sessionId, {
      permissionMode: 'default',
      cwd: agentCwd,
      hasStarted: true,
    });

    this.deps.traceStore.updateSpan(envelope.id, {
      status: 'delivered',
      deliveredAt: Date.now(),
    });

    // Format prompt with relay context metadata
    const content = this.extractPayloadContent(envelope.payload);
    const prompt = this.formatPromptWithContext(content, envelope);

    // Set up timeout from TTL budget
    const ttlRemaining = envelope.budget.ttl - Date.now();
    const timeoutMs = ttlRemaining > 0 ? ttlRemaining : this.config.defaultTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const eventStream = this.deps.agentManager.sendMessage(sessionId, prompt, {
        cwd: agentCwd,
      });

      for await (const event of eventStream) {
        if (controller.signal.aborted) break;
        if (envelope.replyTo && this.relay) {
          await this.publishResponse(envelope, event, sessionId);
        }
      }

      const aborted = controller.signal.aborted;
      this.deps.traceStore.updateSpan(envelope.id, {
        status: aborted ? 'failed' : 'processed',
        processedAt: Date.now(),
        ...(aborted && { error: 'TTL budget expired' }),
      });

      return {
        success: !aborted,
        error: aborted ? 'TTL budget expired' : undefined,
        deadLettered: aborted,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.deps.traceStore.updateSpan(envelope.id, {
        status: 'failed',
        processedAt: Date.now(),
        error: errorMsg,
      });
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // === Private: pulse message handling ===

  /**
   * Handle a relay.system.pulse.{scheduleId} message.
   *
   * Validates the PulseDispatchPayload, runs the agent, and updates
   * the PulseStore with the final run status (completed/failed/cancelled).
   */
  private async handlePulseMessage(
    _subject: string,
    envelope: RelayEnvelope,
    context: AdapterContext | undefined,
    startTime: number,
  ): Promise<DeliveryResult> {
    const traceId = randomUUID();
    const spanId = randomUUID();
    const now = Date.now();

    // Validate pulse payload
    const parsed = PulseDispatchPayloadSchema.safeParse(envelope.payload);
    if (!parsed.success) {
      const failSpan = {
        messageId: envelope.id,
        traceId,
        spanId,
        parentSpanId: null,
        subject: envelope.subject,
        fromEndpoint: envelope.from,
        toEndpoint: 'pulse:unknown',
        status: 'failed',
        budgetHopsUsed: envelope.budget.hopCount,
        budgetTtlRemainingMs: envelope.budget.ttl - now,
        sentAt: now,
        deliveredAt: now,
        processedAt: now,
        error: `Invalid PulseDispatchPayload: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`,
      };
      this.deps.traceStore.insertSpan(failSpan);
      return {
        success: false,
        error: 'Invalid PulseDispatchPayload',
        durationMs: Date.now() - startTime,
      };
    }

    const payload = parsed.data;
    const { scheduleId, runId, prompt, cwd, permissionMode } = payload;
    const effectiveCwd = cwd ?? context?.agent?.directory ?? this.config.defaultCwd;

    // Record trace span as delivered
    const span = {
      messageId: envelope.id,
      traceId,
      spanId,
      parentSpanId: null,
      subject: envelope.subject,
      fromEndpoint: envelope.from,
      toEndpoint: `pulse:${scheduleId}`,
      status: 'delivered',
      budgetHopsUsed: envelope.budget.hopCount,
      budgetTtlRemainingMs: envelope.budget.ttl - now,
      sentAt: now,
      deliveredAt: now,
      processedAt: null,
      error: null,
    };
    this.deps.traceStore.insertSpan(span);

    // Set up timeout from TTL budget
    const ttlRemaining = envelope.budget.ttl - Date.now();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (ttlRemaining <= 0) {
      controller.abort();
    } else {
      timeout = setTimeout(() => controller.abort(), ttlRemaining);
    }

    let outputSummary = '';

    try {
      if (controller.signal.aborted) {
        throw new Error('Run timed out (TTL budget expired)');
      }

      this.deps.agentManager.ensureSession(runId, {
        permissionMode,
        cwd: effectiveCwd,
        hasStarted: false,
      });

      const eventStream = this.deps.agentManager.sendMessage(runId, prompt, {
        cwd: effectiveCwd,
      });

      for await (const event of eventStream) {
        if (controller.signal.aborted) break;

        if (event.type === 'text_delta' && outputSummary.length < OUTPUT_SUMMARY_MAX_CHARS) {
          const data = event.data as { text: string };
          outputSummary += data.text;
        }

        if (envelope.replyTo && this.relay) {
          await this.publishResponse(envelope, event, runId);
        }
      }

      const durationMs = Date.now() - startTime;
      const truncatedSummary = outputSummary.slice(0, OUTPUT_SUMMARY_MAX_CHARS);
      const aborted = controller.signal.aborted;

      if (this.deps.pulseStore) {
        if (aborted) {
          this.deps.pulseStore.updateRun(runId, {
            status: 'cancelled',
            finishedAt: new Date().toISOString(),
            durationMs,
            outputSummary: truncatedSummary,
            error: 'Run timed out (TTL budget expired)',
            sessionId: runId,
          });
        } else {
          this.deps.pulseStore.updateRun(runId, {
            status: 'completed',
            finishedAt: new Date().toISOString(),
            durationMs,
            outputSummary: truncatedSummary,
            sessionId: runId,
          });
        }
      }

      this.deps.traceStore.updateSpan(envelope.id, {
        status: 'processed',
        processedAt: Date.now(),
      });

      return {
        success: !aborted,
        error: aborted ? 'TTL budget expired' : undefined,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (this.deps.pulseStore) {
        this.deps.pulseStore.updateRun(runId, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: outputSummary.slice(0, OUTPUT_SUMMARY_MAX_CHARS),
          error: errorMsg,
          sessionId: runId,
        });
      }

      this.deps.traceStore.updateSpan(envelope.id, {
        status: 'failed',
        processedAt: Date.now(),
        error: errorMsg,
      });

      return {
        success: false,
        error: errorMsg,
        deadLettered: true,
        durationMs,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  // === Private: helpers ===

  /**
   * Format the user prompt with a <relay_context> XML block.
   *
   * Follows the XML block pattern used by context-builder.ts (<env>, <git_status>).
   * The relay context provides the agent with sender info, budget awareness,
   * and reply instructions.
   *
   * @param content - The plain text content from the envelope payload
   * @param envelope - The relay envelope for metadata
   */
  private formatPromptWithContext(content: string, envelope: RelayEnvelope): string {
    const lines: string[] = [
      `From: ${envelope.from}`,
      `Message-ID: ${envelope.id}`,
      `Subject: ${envelope.subject}`,
      `Sent: ${envelope.createdAt}`,
      '',
      'Budget remaining:',
      `- Hops: ${envelope.budget.hopCount} of ${envelope.budget.maxHops} used`,
      `- TTL: ${Math.max(0, Math.round((envelope.budget.ttl - Date.now()) / 1000))} seconds remaining`,
      `- Max turns: ${envelope.budget.callBudgetRemaining}`,
    ];

    if (envelope.replyTo) {
      lines.push('');
      lines.push(`Reply to: ${envelope.replyTo}`);
      lines.push(
        "If you cannot complete the task within the budget, summarize what you've done and stop.",
      );
    }

    const contextBlock = `<relay_context>\n${lines.join('\n')}\n</relay_context>`;
    return `${contextBlock}\n\n${content}`;
  }

  /**
   * Extract session ID from relay.agent.{sessionId} subject.
   *
   * @param subject - A relay.agent.* subject
   * @returns The session ID segment, or null if the subject is malformed
   */
  private extractSessionId(subject: string): string | null {
    const segments = subject.split('.');
    if (segments.length < 3 || segments[0] !== 'relay' || segments[1] !== 'agent') {
      return null;
    }
    return segments[2] || null;
  }

  /**
   * Extract message content from an envelope payload.
   *
   * Attempts to read `content` or `text` from an object payload.
   * Falls back to JSON serialization.
   *
   * @param payload - The unknown payload from the relay envelope
   */
  private extractPayloadContent(payload: unknown): string {
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object') {
      const obj = payload as Record<string, unknown>;
      if (typeof obj.content === 'string') return obj.content;
      if (typeof obj.text === 'string') return obj.text;
    }
    return JSON.stringify(payload);
  }

  /**
   * Publish a response event to the envelope's replyTo subject.
   *
   * @param originalEnvelope - The original incoming envelope
   * @param event - The StreamEvent to publish as a response
   * @param fromId - The session or run ID to use as the sender
   */
  private async publishResponse(
    originalEnvelope: RelayEnvelope,
    event: StreamEvent,
    fromId: string,
  ): Promise<void> {
    if (!this.relay || !originalEnvelope.replyTo) return;
    const opts: PublishOptions = {
      from: `agent:${fromId}`,
      budget: {
        hopCount: originalEnvelope.budget.hopCount + 1,
      },
    };
    await this.relay.publish(originalEnvelope.replyTo, event, opts);
  }
}
