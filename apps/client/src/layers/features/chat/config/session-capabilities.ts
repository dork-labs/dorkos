/**
 * What an agent session's conversation can do.
 *
 * This table and the room's twin (`widgets/room-view/model/room-capabilities.ts`)
 * are the WHOLE of "what is different between the surfaces". Nothing else in the
 * tree may encode it: a row, a lane or a composer that wanted to know whether it
 * is in a session reads one of these booleans instead. When a session gains
 * reactions, one boolean moves and no component changes.
 *
 * It lives here rather than in `widgets/session` — where the spec puts it, and
 * where it belongs once P4's composer host lands there — because the session's
 * conversation is hosted by THIS feature today. `ChatPanel` is what the route,
 * the Obsidian embed and the dev simulator all mount, `MessageList` and the row
 * are here, and their tests are too; a feature may not import a widget's model,
 * so the widget path would leave every one of them unable to say what its own
 * conversation can do.
 *
 * @module features/chat/config/session-capabilities
 */
import type { ConversationCapabilities } from '@/layers/features/conversation';

/** What the agent session offers. */
export const SESSION_CAPABILITIES: ConversationCapabilities = {
  reactions: false,
  threads: false,
  runWith: true,
  attachments: true,
  toolCards: true,
  mentions: false,
  presence: false,
  turnStatus: true,
  asks: true,
};
