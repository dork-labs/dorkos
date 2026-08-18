/**
 * What an agent session's conversation can do.
 *
 * This table and the room's twin (`widgets/room-view/model/room-capabilities.ts`)
 * are the WHOLE of "what is different between the surfaces". Nothing else in the
 * tree may encode it: a row, a lane or a composer that wanted to know whether it
 * is in a session reads one of these booleans instead. When a session gains
 * reactions, one boolean moves and no component changes.
 *
 * It sits beside the host that publishes it, which is where the spec puts it.
 * P1 through P3 kept it in `features/chat` because the session's conversation
 * was hosted by that feature and a feature may not import a widget's model;
 * P4's move of `ChatPanel` up here is what freed it.
 *
 * @module widgets/session/model/session-capabilities
 */
import type { ConversationCapabilities } from '@/layers/features/conversation';

/** What the agent session offers. */
export const SESSION_CAPABILITIES: ConversationCapabilities = {
  reactions: false,
  threads: false,
  runWith: true,
  attachments: true,
  mentions: false,
  streamHealth: false,
  presence: false,
  turnStatus: true,
  asks: true,
};
