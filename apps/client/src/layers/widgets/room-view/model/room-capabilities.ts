/**
 * What a room conversation can do.
 *
 * This table and the session's twin (`features/chat/config/session-capabilities.ts`)
 * are the WHOLE of "what is different between the surfaces". Nothing else in the
 * tree may encode it: a row, a lane or a composer that wanted to know whether it
 * is in a room reads one of these booleans instead. When a session gains
 * reactions, one boolean moves and no component changes.
 *
 * The twin sits in `features/chat` rather than beside this one in a widget
 * because the session's conversation is hosted by that feature today, and a
 * feature may not import a widget's model. P4 moves it up to
 * `widgets/session/model/` with the composer host; that file says so too.
 *
 * @module widgets/room-view/model/room-capabilities
 */
import type { ConversationCapabilities } from '@/layers/features/conversation';

/**
 * What a channel offers — and a DM with it.
 *
 * A direct message is a room whose `kind` changes naming only (`RoomKind`), so
 * it shares this table rather than aliasing it under a second name. A second
 * exported name for the identical object buys a reader nothing and costs them a
 * question — "how do these two differ?" — whose answer is "they do not". If DMs
 * ever diverge, this splits into two tables at that point and the surface that
 * needs the other one asks for it by name.
 */
export const ROOM_CAPABILITIES: ConversationCapabilities = {
  reactions: true,
  threads: true,
  runWith: false,
  attachments: true,
  mentions: true,
  streamHealth: true,
  presence: true,
  turnStatus: false,
  asks: true,
};
