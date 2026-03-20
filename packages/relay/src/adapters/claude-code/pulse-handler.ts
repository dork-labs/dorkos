/**
 * Pulse (scheduled job) handling for the Claude Code adapter.
 *
 * Parses PulseDispatchPayload envelopes and executes scheduled jobs
 * via the Claude Agent SDK. Integrates with the PulseStore for job
 * status tracking and the TraceStore for delivery span recording.
 *
 * @module relay/adapters/claude-code-pulse-handler
 */

import { randomUUID } from 'node:crypto';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { PulseDispatchPayloadSchema } from '@dorkos/shared/relay-schemas';
import type {
  RelayPublisher,
  AdapterContext,
  DeliveryResult,
  PublishOptions,
  TraceStoreLike,
} from '../../types.js';
import type { AgentRuntimeLike, PulseStoreLike } from './types.js';

/** Maximum characters to collect for run output summary. */
const OUTPUT_SUMMARY_MAX_CHARS = 1000;

/** Dependencies required by the pulse handler. */
export interface PulseHandlerDeps {
  agentManager: AgentRuntimeLike;
  traceStore: TraceStoreLike;
  pulseStore?: PulseStoreLike;
  logger?: import('@dorkos/shared/logger').Logger;
}

/** Resolved config values needed by the pulse handler. */
export interface PulseHandlerConfig {
  defaultCwd: string;
}

/**
 * Handle a relay.system.pulse.{scheduleId} message.
 *
 * Validates the PulseDispatchPayload, runs the agent, and updates
 * the PulseStore with the final run status (completed/failed/cancelled).
 *
 * @param _subject - The pulse subject (unused, kept for interface consistency)
 * @param envelope - The relay envelope containing the pulse dispatch payload
 * @param context - Optional adapter context with agent directory info
 * @param startTime - Timestamp when delivery began (for durationMs calculation)
 * @param config - Resolved adapter configuration
 * @param deps - Injected dependencies
 * @param relay - The relay publisher for response streaming (may be null)
 */
export async function handlePulseMessage(
  _subject: string,
  envelope: RelayEnvelope,
  context: AdapterContext | undefined,
  startTime: number,
  config: PulseHandlerConfig,
  deps: PulseHandlerDeps,
  relay: RelayPublisher | null
): Promise<DeliveryResult> {
  const traceId = randomUUID();
  const spanId = randomUUID();
  const now = Date.now();

  // Validate pulse payload
  const parsed = PulseDispatchPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    deps.traceStore.insertSpan({
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
    });
    return {
      success: false,
      error: 'Invalid PulseDispatchPayload',
      durationMs: Date.now() - startTime,
    };
  }

  const payload = parsed.data;
  const { scheduleId, runId, prompt, cwd, permissionMode } = payload;
  const effectiveCwd = cwd ?? context?.agent?.directory ?? config.defaultCwd;

  // Record trace span as delivered
  deps.traceStore.insertSpan({
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

    if (deps.pulseStore) {
      if (aborted) {
        deps.pulseStore.updateRun(runId, {
          status: 'cancelled',
          finishedAt: new Date().toISOString(),
          durationMs,
          outputSummary: truncatedSummary,
          error: 'Run timed out (TTL budget expired)',
          sessionId: runId,
        });
      } else {
        deps.pulseStore.updateRun(runId, {
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

    if (deps.pulseStore) {
      deps.pulseStore.updateRun(runId, {
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
 * Publish a response event for pulse flows (no correlationId).
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
