/**
 * What a room conversation can do.
 *
 * This table and the session's twin (`widgets/session/model/session-capabilities.ts`)
 * are the WHOLE of "what is different between the surfaces". Nothing else in the
 * tree may encode it: a row, a lane or a composer that wanted to know whether it
 * is in a room reads one of these booleans instead. When a session gains
 * reactions, one boolean moves and no component changes.
 *
 * @module widgets/room-view/model/room-capabilities
 */
import type { ConversationCapabilities } from '@/layers/features/conversation';

/** What a channel offers. */
export const ROOM_CAPABILITIES: ConversationCapabilities = {
  reactions: true,
  threads: true,
  runWith: false,
  attachments: true,
  toolCards: false,
  mentions: true,
  presence: true,
  turnStatus: false,
  asks: true,
};

/** A DM is a room whose kind changes naming only, so it shares the room's capabilities. */
export const DM_CAPABILITIES = ROOM_CAPABILITIES;
