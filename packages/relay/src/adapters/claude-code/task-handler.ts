/**
 * Tasks (scheduled job) handling for the Claude Code adapter.
 *
 * Parses TaskDispatchPayload envelopes and executes scheduled jobs
 * via the Claude Agent SDK. Integrates with the TasksStore for job
 * status tracking and the TraceStore for delivery span recording.
 *
 * @module relay/adapters/claude-code-task-handler
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { TaskDispatchPayloadSchema } from '@dorkos/shared/relay-schemas';
import type {
  RelayPublisher,
  AdapterContext,
  DeliveryResult,
  PublishOptions,
  TraceStoreLike,
} from '../../types.js';
import type { AgentRuntimeLike, TasksStoreLike } from './types.js';

/** Maximum characters to collect for run output summary. */
const OUTPUT_SUMMARY_MAX_CHARS = 1000;

/** Dependencies required by the tasks handler. */
export interface TasksHandlerDeps {
  agentManager: AgentRuntimeLike;
  traceStore: TraceStoreLike;
  taskStore?: TasksStoreLike;
  logger?: import('@dorkos/shared/logger').Logger;
}

/** Resolved config values needed by the tasks handler. */
export interface TasksHandlerConfig {
  defaultCwd: string;
}

/**
 * Handle a relay.system.tasks.{taskId} message.
 *
 * Validates the TaskDispatchPayload, runs the agent, and updates
 * the TasksStore with the final run status (completed/failed/cancelled).
 *
 * @param _subject - The tasks subject (unused, kept for interface consistency)
 * @param envelope - The relay envelope containing the tasks dispatch payload
 * @param context - Optional adapter context with agent directory info
 * @param startTime - Timestamp when delivery began (for durationMs calculation)
 * @param config - Resolved adapter configuration
 * @param deps - Injected dependencies
 * @param relay - The relay publisher for response streaming (may be null)
 */
export async function handleTasksMessage(
  _subject: string,
  envelope: RelayEnvelope,
  context: AdapterContext | undefined,
  startTime: number,
  config: TasksHandlerConfig,
  deps: TasksHandlerDeps,
  relay: RelayPublisher | null
): Promise<DeliveryResult> {
  const traceId = randomUUID();
  const spanId = randomUUID();
  const now = Date.now();

  // Validate tasks payload
  const parsed = TaskDispatchPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    deps.traceStore.insertSpan({
      messageId: envelope.id,
      traceId,
      spanId,
      parentSpanId: null,
      subject: envelope.subject,
      fromEndpoint: envelope.from,
      toEndpoint: 'tasks:unknown',
      status: 'failed',
      budgetHopsUsed: envelope.budget.hopCount,
      budgetTtlRemainingMs: envelope.budget.ttl - now,
      sentAt: now,
      deliveredAt: now,
      processedAt: now,
      error: `Invalid TaskDispatchPayload: ${JSON.stringify(z.flattenError(parsed.error).fieldErrors)}`,
    });
    return {
      success: false,
      error: 'Invalid TaskDispatchPayload',
      durationMs: Date.now() - startTime,
    };
  }

  const payload = parsed.data;
  const { taskId, runId, prompt, cwd, permissionMode } = payload;
  const effectiveCwd = cwd ?? context?.agent?.directory ?? config.defaultCwd;

  // Record trace span as delivered
  deps.traceStore.insertSpan({
    messageId: envelope.id,
    traceId,
    spanId,
    parentSpanId: null,
    subject: envelope.subject,
    fromEndpoint: envelope.from,
    toEndpoint: `tasks:${taskId}`,
    status: 'delivered',
    budgetHopsUsed: envelope.budget.hopCount,
    budgetTtlRemainingMs: envelope.budget.ttl - now,
    sentAt: now,
    deliveredAt: now,
    processedAt: null,
    error: null,
  });

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

    deps.agentManager.ensureSession(runId, {
      permissionMode,
      cwd: effectiveCwd,
      hasStarted: false,
    });

    const eventStream = deps.agentManager.sendMessage(runId, prompt, {
      cwd: effectiveCwd,
    });

    for await (const event of eventStream) {
      if (controller.signal.aborted) break;

      if (event.type === 'text_delta' && outputSummary.length < OUTPUT_SUMMARY_MAX_CHARS) {
        const data = event.data as { text: string };
        outputSummary += data.text;
      }

      if (envelope.replyTo && relay) {
        await publishResponse(envelope, event, runId, relay);
      }
    }

    const durationMs = Date.now() - startTime;
    const truncatedSummary = outputSummary.slice(0, OUTPUT_SUMMARY_MAX_CHARS);
    const aborted = controller.signal.aborted;

    if (deps.taskStore) {
      if (aborted) {
        deps.taskStore.updateRun(runId, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: truncatedSummary,
          error: 'Run timed out (TTL budget expired)',
          sessionId: runId,
        });
      } else {
        deps.taskStore.updateRun(runId, {
          status: 'completed',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: truncatedSummary,
          sessionId: runId,
        });
      }
    }

    deps.traceStore.updateSpan(envelope.id, {
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

    if (deps.taskStore) {
      deps.taskStore.updateRun(runId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        durationMs,
        outputSummary: outputSummary.slice(0, OUTPUT_SUMMARY_MAX_CHARS),
        error: errorMsg,
        sessionId: runId,
      });
    }

    deps.traceStore.updateSpan(envelope.id, {
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

/**
 * Publish a response event for tasks flows (no correlationId).
 *
 * @param originalEnvelope - The original incoming envelope
 * @param event - The StreamEvent to publish
 * @param fromId - The run ID to use as the sender
 * @param relay - The relay publisher
 */
async function publishResponse(
  originalEnvelope: RelayEnvelope,
  event: import('@dorkos/shared/types').StreamEvent,
  fromId: string,
  relay: RelayPublisher
): Promise<void> {
  if (!originalEnvelope.replyTo) return;
  const opts: PublishOptions = {
    from: `agent:${fromId}`,
    budget: {
      hopCount: originalEnvelope.budget.hopCount + 1,
    },
  };
  await relay.publish(originalEnvelope.replyTo, event, opts);
}
