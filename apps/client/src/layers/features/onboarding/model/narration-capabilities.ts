/**
 * What the scripted onboarding conversation can do: nothing.
 *
 * It is a third host of the message row — a story told in message rows rather
 * than a conversation you can act on — so it declares its own table like every
 * other host does. Everything is off, and that is the whole point: no hover
 * actions, no reactions, no "run this with…", no live lane, nothing to press.
 * `presentation` on the row itself already suppresses the timestamp and the
 * hover background; this is the same statement made where the compound reads it.
 *
 * @module features/onboarding/model/narration-capabilities
 */
import type { ConversationCapabilities } from '@/layers/features/conversation';

/** What a scripted narration offers — nothing, deliberately. */
export const NARRATION_CAPABILITIES: ConversationCapabilities = {
  reactions: false,
  threads: false,
  runWith: false,
  attachments: false,
  mentions: false,
  presence: false,
  turnStatus: false,
  asks: false,
};
