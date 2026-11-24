/**
 * The live lookups behind a `dork:` link (DOR-5046): each kind is found, and
 * its visibility decided, by the same checks that kind's own read routes use.
 *
 * | Kind    | Found through                       | Who may see it (the route it mirrors)                                    |
 * | ------- | ----------------------------------- | ------------------------------------------------------------------------ |
 * | `chat`  | `sessionExists`, after a re-key     | `readableSessionIds`, the check before every `/api/sessions/:id/*` route |
 * | `room`  | `RoomService.getRoom`               | the caller as `GET /api/rooms/:id` names them, and the room's `canSee`   |
 * | `entry` | `entryLocations`, then its room     | a person: the room, as the room's history page; an agent: `readEntry`    |
 * | `agent` | the mesh registry                   | anyone, as `GET /api/mesh/agents/:id`                                    |
 *
 * An agent reading a message is held to `readEntry`, the read its own room
 * tools use: it must be a member, and the message must be from after it
 * joined. A person is held to the room alone, as the app's history page is.
 *
 * @module services/core/links/link-lookups
 */
import type { Db } from '@dorkos/db';
import type { AccountIds } from '../../audit/account-ids.js';
import { readerFor } from '../../audit/audit-capabilities.js';
import { readableSessionIds } from '../../audit/session-visibility.js';
import type { AuthorRecord } from '../../rooms/author-registry.js';
import { entryLocations } from '../../rooms/messages/entry-rooms.js';
import { RoomError } from '../../rooms/room-errors.js';
import type { RoomService } from '../../rooms/room-service.js';
import { followChatRekey } from '../../session/turn-identity/follow-chat-rekey.js';
import type { CapabilityHandlerContext } from '../capabilities/index.js';
import type { DorkLinkLookups, LinkedEntry } from './resolve-dork-link.js';

/** What {@link createDorkLinkLookups} reads. */
export interface DorkLinkLookupDeps {
  /** The server database, for finding which room holds a message. */
  db: Db;
  /** The rooms service: who the caller is in rooms, and what they may see. */
  rooms: Pick<RoomService, 'getRoom' | 'readEntry'>;
  /**
   * Who the caller is, as a room author: `callerAuthor`, the ladder every room
   * capability asks. Throws a `RoomError` for a caller rooms refuse.
   */
  roomCaller: (context: CapabilityHandlerContext) => AuthorRecord;
  /** Names an agent caller by its stable account id, for the chat read check. */
  accounts?: Pick<AccountIds, 'forAgentIdentity' | 'unidentified'> | undefined;
  /** Whether this server has a chat under the id (`sessionExists`). */
  chatExists: (sessionId: string) => Promise<boolean>;
  /** The mesh agent registry; absent when mesh did not start. */
  agents?: { get(agentId: string): unknown } | undefined;
}

/**
 * The room author this caller is, or `null` when rooms refuse to name them
 * (an unverifiable agent token, a chat with no agent, nobody under a login).
 */
function roomCallerOrNull(
  deps: DorkLinkLookupDeps,
  context: CapabilityHandlerContext
): AuthorRecord | null {
  try {
    return deps.roomCaller(context);
  } catch (err) {
    if (err instanceof RoomError) return null;
    throw err;
  }
}

/** The message, when this caller may read it in this room. */
function readableEntry(
  deps: DorkLinkLookupDeps,
  caller: AuthorRecord,
  entryId: string,
  location: LinkedEntry
): LinkedEntry | null {
  if (caller.kind !== 'agent') {
    return deps.rooms.getRoom(location.roomId, caller.id) ? location : null;
  }
  try {
    return deps.rooms.readEntry(location.roomId, caller.id, entryId) ? location : null;
  } catch (err) {
    // "Not a member" reads as "no such room", which is a RoomError.
    if (err instanceof RoomError) return null;
    throw err;
  }
}

/**
 * Build the lookups a link resolves through, from the server's own services.
 *
 * @param deps - The services each kind is read from.
 * @returns The lookups `resolveDorkLink` reads.
 */
export function createDorkLinkLookups(deps: DorkLinkLookupDeps): DorkLinkLookups {
  return {
    followChatRekey,
    async chatVisible(sessionId, context) {
      const reader = readerFor({ accounts: deps.accounts }, context);
      if (!readableSessionIds(reader, [sessionId]).has(sessionId)) return false;
      return deps.chatExists(sessionId);
    },
    roomVisible(roomId, context) {
      const caller = roomCallerOrNull(deps, context);
      return caller !== null && deps.rooms.getRoom(roomId, caller.id) !== null;
    },
    entryVisible(entryId, context) {
      const caller = roomCallerOrNull(deps, context);
      if (!caller) return null;
      for (const location of entryLocations(deps.db, entryId)) {
        const entry = readableEntry(deps, caller, entryId, location);
        if (entry) return entry;
      }
      return null;
    },
    agentVisible(agentId) {
      return deps.agents?.get(agentId) != null;
    },
  };
}
