/**
 * Schema translation from A2A Messages to Relay StandardPayload.
 *
 * A2A uses a multi-part message model — each `Part` carries text, a file
 * (raw bytes or a url), or structured data. Relay uses a flat string
 * `content` field in StandardPayload. This module bridges the two by
 * extracting and concatenating text parts.
 * (The reverse direction — Relay reply events back to A2A — is handled by
 * `reply-events.ts`, since responders stream StreamEvent envelopes rather
 * than StandardPayloads.)
 *
 * @module a2a-gateway/schema-translator
 */
import type { Message } from '@a2a-js/sdk';
import type { StandardPayload } from '@dorkos/shared/relay-schemas';
import { emptyToUndefined, partText } from './a2a-model.js';

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
    .map((p) => partText(p))
    .filter((text): text is string => text !== undefined);

  return {
    content: textParts.join('\n'),
    senderName: 'a2a-client',
    channelType: 'dm',
    conversationId: emptyToUndefined(message.contextId),
    correlationId: emptyToUndefined(message.taskId),
    responseContext: {
      platform: 'a2a',
      supportedFormats: ['text/plain'],
    },
    performative: 'request',
  };
}
