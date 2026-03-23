/**
 * Bidirectional schema translation between A2A Messages/Tasks
 * and Relay Envelopes/StandardPayload.
 *
 * A2A uses a multi-part message model (TextPart | FilePart | DataPart).
 * Relay uses a flat string `content` field in StandardPayload.
 * This module bridges the two by extracting and concatenating text parts.
 *
 * @module a2a-gateway/schema-translator
 */
import type { Message, TaskState, TextPart } from '@a2a-js/sdk';
import type { StandardPayload } from '@dorkos/shared/relay-schemas';

/**
 * Translate an inbound A2A Message to a Relay StandardPayload.
 *
 * Text parts are extracted and concatenated with newlines to form
 * the `content` field. Non-text parts (file, data) are silently
 * dropped — Relay's StandardPayload only supports string content.
 *
 * Mapping:
 * - `message.parts[*].text` (text parts only) → `payload.content` (joined with `\n`)
 * - `message.contextId` → `payload.conversationId`
 * - `message.taskId` → `payload.correlationId`
 * - Hardcoded `senderName: 'a2a-client'`, `channelType: 'dm'`, `performative: 'request'`
 *
 * @param message - The inbound A2A Message to translate.
 * @returns A StandardPayload suitable for publishing via Relay.
 */
export function a2aMessageToRelayPayload(message: Message): StandardPayload {
  const textParts = message.parts
    .filter((p): p is TextPart => p.kind === 'text')
    .map((p) => p.text);

  return {
    content: textParts.join('\n'),
    senderName: 'a2a-client',
    channelType: 'dm',
    conversationId: message.contextId,
    correlationId: message.taskId,
    responseContext: {
      platform: 'a2a',
      supportedFormats: ['text/plain'],
    },
    performative: 'request',
  };
}

/**
 * Translate a Relay StandardPayload into an A2A Message.
 *
 * Used when converting Relay agent responses back to A2A format
 * for SSE streaming to the external A2A client.
 *
 * The produced Message always has `role: 'agent'` — Relay responses
 * originate from DorkOS agents, never from users.
 *
 * @param payload - The Relay StandardPayload containing the agent's response.
 * @param taskId - The A2A task ID to associate with the message.
 * @param contextId - The A2A context ID to associate with the message.
 * @returns A well-formed A2A Message with a single TextPart.
 */
export function relayPayloadToA2aMessage(
  payload: StandardPayload,
  taskId: string,
  contextId: string
): Message {
  return {
    kind: 'message',
    role: 'agent',
    messageId: crypto.randomUUID(),
    parts: [{ kind: 'text', text: payload.content }],
    taskId,
    contextId,
  };
}

/** Relay delivery statuses that map to A2A TaskState values. */
type RelayStatus = 'sent' | 'delivered' | 'failed' | 'timeout';

/**
 * Map a Relay delivery status to an A2A TaskState.
 *
 * Relay status → A2A TaskState mapping:
 * - `sent`      → `'working'`   (message accepted, agent processing)
 * - `delivered` → `'completed'` (agent responded successfully)
 * - `failed`    → `'failed'`    (delivery or processing error)
 * - `timeout`   → `'failed'`    (no response within deadline)
 *
 * @param status - A Relay delivery status string.
 * @returns The corresponding A2A TaskState value.
 */
export function relayStatusToTaskState(status: RelayStatus): TaskState {
  switch (status) {
    case 'sent':
      return 'working';
    case 'delivered':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'timeout':
      return 'failed';
  }
}
