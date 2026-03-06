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
  TraceStoreLike,
} from '../types.js';
import { extractPayloadContent } from '../lib/payload-utils.js';

// Re-export TraceStoreLike for backward compatibility
export type { TraceStoreLike } from '../types.js';

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
  /**
   * Get the SDK-assigned session UUID for a given session key.
   *
   * The SDK may assign a different UUID from the one passed to ensureSession()
   * after the first query() init message. This returns the actual SDK UUID.
   *
   * @param sessionId - The session key used in ensureSession/sendMessage
   * @returns The SDK session UUID, or undefined if the session does not exist
   */
  getSdkSessionId(sessionId: string): string | undefined;
}

/**
 * Minimal interface for the persistent agent session store.
 *
 * Maps Mesh agent ULIDs (or other stable agent keys) to their SDK session UUIDs
 * so that conversation threads survive server restarts.
 */
export interface AgentSessionStoreLike {
  get(agentId: string): string | undefined;
  set(agentId: string, sdkSessionId: string): void;
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
  /**
   * Persistent store for mapping agent identifiers to SDK session UUIDs.
   *
   * When provided, handleAgentMessage() will look up the persisted SDK session
   * UUID for the agent key extracted from the subject, enabling conversation
   * continuity across server restarts. If not provided, the raw subject key
   * is used as the session ID (original behavior).
   */
  agentSessionStore?: AgentSessionStoreLike;
  logger?: import('@dorkos/shared/logger').Logger;
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
  /** Per-agentId promise chain for serializing concurrent messages to the same agent. */
  private agentQueues = new Map<string, Promise<void>>();
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
   * Stop the adapter — clear relay reference, drain in-flight queue entries, and mark as disconnected.
   */
  async stop(): Promise<void> {
    this.relay = null;
    this.agentQueues.clear();
    this.status = { ...this.status, state: 'disconnected' };
  }

  /**
   * Return the current adapter status snapshot.
   */
  getStatus(): AdapterStatus {
    return { ...this.status, queuedMessages: this.agentQueues.size };
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
        return await this.handlePulseMessage(subject, envelope, context, startTime);
      }

      // Extract agentId for queue key. If extraction fails, handleAgentMessage
      // will return the error — we still want that error to be returned, so we
      // must still call handleAgentMessage (not bypass it).
      const queueKey = subject.split('.')[2] ?? subject;
      return await this.processWithQueue(queueKey, () =>
        this.handleAgentMessage(subject, envelope, context, startTime),
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

  // === Private: agent message handling ===

  /**
   * Handle a relay.agent.{agentId} message.
   *
   * Resolves the agent ID, records trace spans, formats the prompt with
   * relay context, and streams the agent response back to envelope.replyTo.
   */
  private async handleAgentMessage(
    subject: string,
    envelope: RelayEnvelope,
    context: AdapterContext | undefined,
    startTime: number,
  ): Promise<DeliveryResult> {
    const agentId = this.extractAgentId(subject);
    if (!agentId) {
      return {
        success: false,
        error: `Could not extract agentId from subject: ${subject}`,
        durationMs: Date.now() - startTime,
      };
    }

    // Resolve the canonical SDK session ID from the persistent store when available.
    // The store maps stable agent keys (Mesh ULIDs, BindingRouter session IDs) to
    // the SDK-assigned UUIDs so conversation threads survive server restarts.
    // Fall back to the raw agentId for backwards compatibility.
    const persistedSdkSessionId = this.deps.agentSessionStore?.get(agentId);
    const ccaSessionKey = persistedSdkSessionId ?? agentId;

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
      toEndpoint: `agent:${agentId}/${ccaSessionKey}`,
      status: 'pending',
      budgetHopsUsed: envelope.budget.hopCount,
      budgetTtlRemainingMs: envelope.budget.ttl - now,
      sentAt: now,
      deliveredAt: null,
      processedAt: null,
      error: null,
    };
    this.deps.traceStore.insertSpan(span);

    // Resolve agent working directory from authoritative context only.
    // When context is undefined (no Mesh agent), do NOT override with
    // process.cwd() — let the session's stored CWD (set by BindingRouter
    // from binding.projectPath) take precedence via AgentManager fallback.
    const agentCwd = context?.agent?.directory;
    const log = this.deps.logger ?? console;
    log.debug?.(
      `[CCA] handleAgentMessage agentId=${agentId} ccaSessionKey=${ccaSessionKey}, ` +
      `context.agent.directory=${context?.agent?.directory ?? '(none)'}, ` +
      `resolvedCwd=${agentCwd ?? '(deferred to session)'}`,
    );

    this.deps.agentManager.ensureSession(ccaSessionKey, {
      permissionMode: 'default',
      hasStarted: true,
      ...(agentCwd ? { cwd: agentCwd } : {}),
    });

    this.deps.traceStore.updateSpan(envelope.id, {
      status: 'delivered',
      deliveredAt: Date.now(),
    });

    if (!envelope.replyTo) {
      (this.deps.logger ?? console).warn(
        `ClaudeCodeAdapter: envelope ${envelope.id} has no replyTo — response events will not be published`,
      );
    }

    // Skip if the payload is a StreamEvent response from another agent's session.
    // When we are the replyTo for a relay_send call, the responding agent's CCA
    // streams every event (text_delta, tool_call_delta, etc.) back to our subject.
    // These are NOT new user queries — injecting them as sendMessage calls creates
    // an infinite loop.
    const payloadObj =
      typeof envelope.payload === 'object' && envelope.payload !== null
        ? (envelope.payload as Record<string, unknown>)
        : null;
    const STREAM_EVENT_TYPES = new Set([
      'text_delta', 'tool_call_start', 'tool_call_end', 'tool_call_delta',
      'tool_result', 'session_status', 'approval_required', 'question_prompt',
      'error', 'done', 'task_update', 'relay_message', 'relay_receipt', 'message_delivered',
    ]);
    if (payloadObj?.type && STREAM_EVENT_TYPES.has(payloadObj.type as string)) {
      (this.deps.logger ?? console).debug?.(
        `[CCA] skipping sendMessage for StreamEvent payload type=${String(payloadObj.type)}`,
      );
      this.deps.traceStore.updateSpan(envelope.id, { status: 'processed', processedAt: Date.now() });
      return { success: true, durationMs: Date.now() - startTime };
    }

    // Format prompt with relay context metadata
    const content = extractPayloadContent(envelope.payload);
    const prompt = this.formatPromptWithContext(content, envelope, agentId, ccaSessionKey);

    // Set up timeout from TTL budget
    const ttlRemaining = envelope.budget.ttl - Date.now();
    const timeoutMs = ttlRemaining > 0 ? ttlRemaining : this.config.defaultTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // All relay.inbox.* replyTos (dispatch, query, persistent) receive full streaming:
    // incremental progress events + final agent_result.
    // relay_query accumulates progress internally and presents a single MCP response.
    // Other addresses (relay.human.console.*, relay.agent.*) receive raw event streaming.
    const isInboxReplyTo = envelope.replyTo?.startsWith('relay.inbox.');

    try {
      const eventStream = this.deps.agentManager.sendMessage(ccaSessionKey, prompt, {
        ...(agentCwd ? { cwd: agentCwd } : {}),
      });

      let eventCount = 0;
      let collectedText = '';
      let stepCounter = 0;
      let messageBuffer = '';
      for await (const event of eventStream) {
        if (controller.signal.aborted) break;
        eventCount++;

        if (envelope.replyTo && this.relay) {
          if (isInboxReplyTo) {
            // All relay.inbox.* — same progress streaming as dispatch (formerly dispatch-only)
            if (event.type === 'text_delta') {
              const data = event.data as { text: string };
              messageBuffer += data.text;
              collectedText += data.text;
            }
            if (event.type === 'tool_call_start' && messageBuffer) {
              stepCounter++;
              await this.publishDispatchProgress(envelope, stepCounter, 'message', messageBuffer, ccaSessionKey);
              messageBuffer = '';
            }
            if (event.type === 'tool_result') {
              stepCounter++;
              const data = event.data as { content?: string; tool_use_id?: string };
              const text = typeof data.content === 'string' ? data.content : JSON.stringify(data);
              await this.publishDispatchProgress(envelope, stepCounter, 'tool_result', text, ccaSessionKey);
            }
          } else {
            // relay.agent.*, relay.human.* — existing raw event streaming (unchanged)
            await this.publishResponse(envelope, event, ccaSessionKey);
          }
        }
      }

      // After loop — flush and publish final result for all relay.inbox.* replyTos
      if (isInboxReplyTo && envelope.replyTo && this.relay) {
        if (messageBuffer) {
          stepCounter++;
          await this.publishDispatchProgress(envelope, stepCounter, 'message', messageBuffer, ccaSessionKey);
        }
        await this.publishAgentResult(envelope, collectedText, ccaSessionKey);
      }

      // Persist the SDK-assigned session UUID for future messages to the same agent key.
      // After the first sendMessage(), the SDK may have assigned a different UUID from
      // the one we passed to ensureSession(). We store the mapping so that the next
      // message addressed to agentId resumes the same conversation thread.
      if (this.deps.agentSessionStore && !persistedSdkSessionId) {
        const actualSdkId = this.deps.agentManager.getSdkSessionId(ccaSessionKey);
        if (actualSdkId && actualSdkId !== agentId) {
          this.deps.agentSessionStore.set(agentId, actualSdkId);
          log.debug?.(
            `[CCA] persisted session mapping: ${agentId} → ${actualSdkId}`,
          );
        }
      }

      (this.deps.logger ?? console).info(
        `ClaudeCodeAdapter: published ${eventCount} event(s) to ${envelope.replyTo ?? '(no replyTo)'}`,
      );

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
   * Process a deliver function for a given agentId through a per-agent serial queue.
   *
   * Prevents the SDK "Already connected to a transport" error by ensuring
   * only one sendMessage() call runs per agentId at a time. Cross-agent
   * messages run in parallel (separate queue entries).
   *
   * @param agentId - The Mesh ULID identifying the target agent (used as the queue key)
   * @param fn - Async function that performs the actual delivery
   */
  private async processWithQueue(
    agentId: string,
    fn: () => Promise<DeliveryResult>,
  ): Promise<DeliveryResult> {
    const current = this.agentQueues.get(agentId) ?? Promise.resolve();
    let result!: DeliveryResult;
    const next = current.then(() =>
      fn().then((r) => {
        result = r;
      }),
    );
    // Store the chain but swallow errors to prevent unhandled rejection
    // on the queue reference itself (errors are returned via result)
    this.agentQueues.set(agentId, next.catch(() => {}));
    await next;
    return result;
  }

  /**
   * Format the user prompt with a <relay_context> XML block.
   *
   * Follows the XML block pattern used by context-builder.ts (<env>, <git_status>).
   * The relay context provides the agent with sender info, budget awareness,
   * reply instructions, and dual-ID identity lines (Agent-ID + Session-ID).
   *
   * @param content - The plain text content from the envelope payload
   * @param envelope - The relay envelope for metadata
   * @param agentId - The stable Mesh ULID (subject key) used to address this agent
   * @param sdkSessionId - The SDK-assigned session UUID for the active conversation thread
   */
  private formatPromptWithContext(
    content: string,
    envelope: RelayEnvelope,
    agentId: string,
    sdkSessionId: string,
  ): string {
    const lines: string[] = [
      `Agent-ID: ${agentId}`,
      `Session-ID: ${sdkSessionId}`,
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
   * Extract agent ID from relay.agent.{agentId} subject.
   *
   * @param subject - A relay.agent.* subject
   * @returns The Mesh agent ULID segment, or null if the subject is malformed
   */
  private extractAgentId(subject: string): string | null {
    const segments = subject.split('.');
    if (segments.length < 3 || segments[0] !== 'relay' || segments[1] !== 'agent') {
      return null;
    }
    return segments[2] || null;
  }


  /**
   * Publish a single aggregated agent result to a relay.inbox.* replyTo address.
   *
   * Used for agent-to-agent communication where the receiving agent polls an
   * inbox. Sends one clean message instead of streaming raw events.
   *
   * @param originalEnvelope - The original incoming envelope
   * @param text - The full collected response text
   * @param fromId - The session ID to use as the sender
   */
  private async publishAgentResult(
    originalEnvelope: RelayEnvelope,
    text: string,
    fromId: string,
  ): Promise<void> {
    if (!this.relay || !originalEnvelope.replyTo) return;
    const opts: PublishOptions = {
      from: `agent:${fromId}`,
      budget: {
        hopCount: originalEnvelope.budget.hopCount + 1,
      },
    };
    await this.relay.publish(originalEnvelope.replyTo, { type: 'agent_result', text, done: true }, opts);
  }

  /**
   * Publish a single incremental progress event to a dispatch inbox.
   *
   * Called during Agent B's session to stream intermediate results to the
   * relay.inbox.dispatch.* inbox so Agent A can poll for progress.
   *
   * @param originalEnvelope - The original incoming envelope (for replyTo and budget)
   * @param step - Monotonically increasing step counter
   * @param step_type - 'message' for text completions, 'tool_result' for tool events
   * @param text - Text content for this step
   * @param fromId - The session ID to use as the sender
   */
  private async publishDispatchProgress(
    originalEnvelope: RelayEnvelope,
    step: number,
    step_type: 'message' | 'tool_result',
    text: string,
    fromId: string,
  ): Promise<void> {
    if (!this.relay || !originalEnvelope.replyTo) return;
    const opts: PublishOptions = {
      from: `agent:${fromId}`,
      budget: { hopCount: originalEnvelope.budget.hopCount + 1 },
    };
    await this.relay.publish(
      originalEnvelope.replyTo,
      { type: 'progress', step, step_type, text, done: false },
      opts,
    );
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
