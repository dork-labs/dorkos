/**
 * The A2A v1.0 data model, in the shapes this gateway actually needs.
 *
 * A2A v1.0 types are generated from the protocol's protobuf schema, which
 * changes how they are written rather than what they mean: every field is
 * present (an absent one is typed `T | undefined`, not `?`, so it still has to
 * be spelled out), a `Part`'s content is a `$case` union instead of a `kind`
 * string, and `TaskState`/`Role` are numeric enums instead of string literals.
 * Hand-building one is therefore noisy in a way that says nothing about what
 * the gateway is doing. These builders and readers absorb that noise so the
 * rest of the package reads like the protocol it speaks.
 *
 * @module a2a-gateway/a2a-model
 */
import type { Message, Part, Role } from '@a2a-js/sdk';

/** The media type carried by every part this gateway produces. */
const TEXT_MEDIA_TYPE = 'text/plain';

/**
 * Build a text {@link Part}.
 *
 * @param text - The part's text content.
 */
export function textPart(text: string): Part {
  return {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: TEXT_MEDIA_TYPE,
  };
}

/**
 * Read a part's text, or `undefined` when it carries anything else.
 *
 * File and data parts have no text to give, and Relay's `StandardPayload`
 * only carries a string — so they are dropped rather than stringified.
 *
 * @param part - The part to read.
 */
export function partText(part: Part): string | undefined {
  return part.content?.$case === 'text' ? part.content.value : undefined;
}

/**
 * Normalize a protobuf string field to an optional one.
 *
 * Protobuf has no null: an unset `contextId` or `taskId` arrives as `''`.
 * Relay's `StandardPayload` treats those ids as genuinely optional, and an
 * empty-string correlationId is not the same thing as no correlationId — so
 * the empty case has to become `undefined` on the way across.
 *
 * @param value - The protobuf string field.
 */
export function emptyToUndefined(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/** The parts of a {@link Message} a caller chooses; the rest are protocol defaults. */
export interface MessageInit {
  /** Who the message is from. */
  role: Role;
  /** The message's single text part. */
  text: string;
  /** The task the message belongs to, if any. */
  taskId?: string;
  /** The context the message belongs to, if any. */
  contextId?: string;
  /** The message id; a fresh UUID when omitted. */
  messageId?: string;
  /** Metadata to carry alongside the message. */
  metadata?: Record<string, unknown>;
}

/**
 * Build a single-text-part {@link Message} with every protobuf field populated.
 *
 * @param init - The fields this message actually carries ({@link MessageInit}).
 */
export function buildMessage(init: MessageInit): Message {
  return {
    messageId: init.messageId ?? crypto.randomUUID(),
    contextId: init.contextId ?? '',
    taskId: init.taskId ?? '',
    role: init.role,
    parts: [textPart(init.text)],
    metadata: init.metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}
