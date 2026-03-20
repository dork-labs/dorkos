/**
 * Publish helpers for the Claude Code adapter.
 *
 * Shared response publishing functions used by both the agent handler
 * and pulse handler sub-modules. Extracted to keep individual handlers
 * focused on their primary routing logic.
 *
 * @module relay/adapters/claude-code-publish
 */

import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RelayPublisher, PublishOptions } from '../../types.js';

/**
 * Publish a single aggregated agent result to a relay.inbox.* replyTo address.
 *
 * Used for agent-to-agent communication where the receiving agent polls an
 * inbox. Sends one clean message instead of streaming raw events.
 *
 * @param originalEnvelope - The original incoming envelope
 * @param text - The full collected response text
 * @param fromId - The session ID to use as the sender
 * @param relay - The relay publisher
 */
export async function publishAgentResult(
  originalEnvelope: RelayEnvelope,
  text: string,
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
  await relay.publish(originalEnvelope.replyTo, { type: 'agent_result', text, done: true }, opts);
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
 * @param relay - The relay publisher
 */
export async function publishDispatchProgress(
  originalEnvelope: RelayEnvelope,
  step: number,
  step_type: 'message' | 'tool_result',
  text: string,
  fromId: string,
  relay: RelayPublisher
): Promise<void> {
  if (!originalEnvelope.replyTo) return;
  const opts: PublishOptions = {
    from: `agent:${fromId}`,
    budget: { hopCount: originalEnvelope.budget.hopCount + 1 },
  };
  await relay.publish(
    originalEnvelope.replyTo,
    { type: 'progress', step, step_type, text, done: false },
    opts
  );
}

/**
 * Publish a response event to the envelope's replyTo subject with optional correlationId.
 *
 * Wraps the event with correlationId (when present) so the client can filter
 * stale events from previous messages. Logs a warning when delivery reaches
 * zero subscribers for non-done events.
 *
 * @param originalEnvelope - The original incoming envelope
 * @param event - The StreamEvent to publish as a response
 * @param fromId - The session or run ID to use as the sender
 * @param relay - The relay publisher
 * @param log - Logger instance for diagnostics
 * @param correlationId - Optional correlation ID to echo for client-side event filtering
 * @param enrichment - Optional enrichment data for approval events
 */
export async function publishResponseWithCorrelation(
  originalEnvelope: RelayEnvelope,
  event: StreamEvent,
  fromId: string,
  relay: RelayPublisher,
  log: Pick<Console, 'warn'>,
  correlationId?: string,
  enrichment?: { agentId?: string }
): Promise<void> {
  if (!originalEnvelope.replyTo) return;
  const opts: PublishOptions = {
    from: `agent:${fromId}`,
    budget: {
      hopCount: originalEnvelope.budget.hopCount + 1,
    },
  };

  let payload: unknown;

  // Enrich approval_required events with agent/session IDs so outbound
  // adapters can encode them in interactive button values for the round-trip.
  if (event.type === 'approval_required' && enrichment?.agentId) {
    payload = {
      ...event,
      ...(correlationId ? { correlationId } : {}),
      data: {
        ...(event.data as Record<string, unknown>),
        agentId: enrichment.agentId,
        ccaSessionKey: fromId,
      },
    };
  } else {
    // Wrap event with correlationId so client can filter stale events
    payload = correlationId ? { ...event, correlationId } : event;
  }

  const result = await relay.publish(originalEnvelope.replyTo, payload, opts);
  if (result.deliveredTo === 0 && event.type !== 'done') {
    log.warn(
      `[CCA] publishResponse delivered to 0 subscribers: subject=${originalEnvelope.replyTo}, eventType=${event.type}`
    );
  }
}
