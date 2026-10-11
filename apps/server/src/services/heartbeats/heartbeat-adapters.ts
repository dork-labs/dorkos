/**
 * The server-side seams heartbeats deliver and look things up through: the
 * outbox's ways out (rooms, the in-app DM, a note, another agent's chat), who a
 * raise may name, whether a room post reaches a person, and the chat-list
 * label. Kept apart from `heartbeats-wiring.ts` so each piece stays small and
 * testable.
 *
 * @module services/heartbeats/heartbeat-adapters
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { MeshCore } from '@dorkos/mesh';
import { authors, rooms, sessionMetadata, type Db } from '@dorkos/db';
import type { AuthorRegistry } from '../rooms/author-registry.js';
import type { RoomService } from '../rooms/room-service.js';
import { deliverNotifyDm, type NotifyDmDeps } from '../relay/notify-dm.js';
import { deliverOverRelay, type RelayChannelDeps } from '../notifications/channels/relay.js';
import { getChatMessageService } from '../session/chat-messages/chat-message-service.js';
import type { BeatAgent } from './beat-runner.js';
import type { RecipientCheck } from './heartbeat-capabilities.js';
import { noteBeatRoomPost } from './event-wakes.js';
import type { DeliveryResult, OutboxDeps } from './outbox.js';
import type { ReportsToChain } from './reports-to.js';

/** The relay principal held raises are published under when they leave the app. */
const OUTBOX_PRINCIPAL = 'relay.system.heartbeats.outbox';

/** `@handle` tokens a post's text names. */
const HANDLE_TOKEN = /(?:^|\s)@([a-z0-9][a-z0-9._-]{0,31})/gi;

/** What the delivery seams reach. */
export interface DeliveryDeps {
  /** The database. */
  db: Db;
  /** Rooms, for `room` raises. */
  rooms: Pick<RoomService, 'postFromTool'>;
  /** Room authors, to post as the agent. */
  roomAuthors: Pick<AuthorRegistry, 'resolveAgent'>;
  /** The in-app DM seam, when rooms and mesh run. */
  notifyDm: NotifyDmDeps | undefined;
  /** The out-of-app leg, read per send. */
  relay: () => RelayChannelDeps | undefined;
}

/**
 * A delivery result from a yes/no.
 *
 * @param ok - Whether it landed.
 * @param entryId - Where, when it did.
 * @param reason - Why not, when it did not.
 */
function result(ok: boolean, entryId?: string, reason = 'not delivered'): DeliveryResult {
  return ok ? { ok: true, ...(entryId ? { entryId } : {}) } : { ok: false, reason };
}

/** Why a message to a person who is not the owner goes nowhere today. */
const NOT_THE_OWNER =
  'Only the owner can get messages from agents here yet; this person has no DM to land in.';

/**
 * The outbox's ways out.
 *
 * @param deps - What they reach.
 * @param isOwner - Whether an account id is the owner's, by any id they are
 *   known by. The in-app DM and a bound chat are the owner's, so a message for
 *   anybody else (a manager who is a person other than the owner) is refused
 *   rather than landing in the owner's DM.
 */
export function createDeliveries(
  deps: DeliveryDeps,
  isOwner: (accountId: string) => boolean
): Pick<
  OutboxDeps,
  'postToRoom' | 'deliverDm' | 'deliverNote' | 'sendToAgent' | 'roomReachesPerson'
> {
  const deliverDm = async (agent: BeatAgent, to: string, text: string): Promise<DeliveryResult> => {
    // The in-app DM is the agent's DM with the owner, the one person a raise
    // can reach today.
    if (!isOwner(to)) return result(false, undefined, NOT_THE_OWNER);
    if (!deps.notifyDm) return result(false, undefined, 'no in-app DM on this server');
    const outcome = deliverNotifyDm({ agentId: agent.id, message: text }, deps.notifyDm);
    return outcome.ok ? result(true, outcome.entryId) : result(false, undefined, outcome.reason);
  };
  return {
    postToRoom: (agent, roomId, text, chatSessionId) => {
      try {
        const author = deps.roomAuthors.resolveAgent(agent.projectPath, agent.name);
        const posted = deps.rooms.postFromTool(roomId, {
          authorId: author.id,
          text,
          ...(chatSessionId ? { callerSessionId: chatSessionId } : {}),
        });
        // A beat's post never wakes a beat back (`room-wakes.ts`).
        noteBeatRoomPost(posted.id);
        return result(true, posted.id);
      } catch (err) {
        return result(false, undefined, err instanceof Error ? err.message : String(err));
      }
    },
    deliverDm,
    deliverNote: async (agent, to, text) => {
      if (!isOwner(to)) return result(false, undefined, NOT_THE_OWNER);
      const relay = deps.relay();
      if (!relay) return deliverDm(agent, to, text);
      const outcome = await deliverOverRelay(
        {
          agentId: agent.id,
          message: text,
          policy: 'always',
          fromPrincipal: OUTBOX_PRINCIPAL,
          dmFallback: true,
        },
        relay
      );
      if (!outcome.ok) return deliverDm(agent, to, text);
      return result(true, outcome.surface === 'dorkos-dm' ? outcome.entryId : undefined);
    },
    sendToAgent: async (agent, chatSessionId, toAgentId, text) => {
      const chat = getChatMessageService();
      if (!chat || !chatSessionId) return result(false, undefined, 'chat messages are not running');
      try {
        await chat.send(
          { sessionId: chatSessionId, agentPath: agent.projectPath },
          { to: toAgentId, message: text, summary: `A report from ${agent.name}'s heartbeat` },
          'report'
        );
        return result(true);
      } catch (err) {
        return result(false, undefined, err instanceof Error ? err.message : String(err));
      }
    },
    roomReachesPerson: (roomId, text) => roomReachesPerson(deps.db, roomId, text),
  };
}

/**
 * Whether a post in a room reaches a person directly: the room is a DM, or the
 * text names a person by handle.
 *
 * @param db - The database.
 * @param roomId - The room.
 * @param text - The post.
 */
export function roomReachesPerson(db: Db, roomId: string, text: string): boolean {
  const room = db.select({ kind: rooms.kind }).from(rooms).where(eq(rooms.id, roomId)).get();
  if (room?.kind === 'dm') return true;
  // A handle never ends in `.`, `_` or `-`, so trailing punctuation is the sentence's.
  const handles = [...text.matchAll(HANDLE_TOKEN)].map((match) =>
    match[1]!.toLowerCase().replace(/[._-]+$/, '')
  );
  if (handles.length === 0) return false;
  return (
    db
      .select({ id: authors.id })
      .from(authors)
      .where(and(eq(authors.kind, 'human'), inArray(authors.handle, handles)))
      .get() !== undefined
  );
}

/**
 * How `end_beat` checks a raise's `to`: an agent this server knows, or the owner
 * by any id they are known by. Any other person is refused until delivery can
 * reach them.
 *
 * @param mesh - Agents, read lazily.
 * @param chain - The reports-to chain, for canonical ids.
 * @param ownerAccountId - The owner's account id.
 */
export function createRecipientCheck(
  mesh: () => Pick<MeshCore, 'get'> | undefined,
  chain: Pick<ReportsToChain, 'canonical' | 'names'>,
  ownerAccountId: () => string
): RecipientCheck {
  return (to) => {
    if (mesh()?.get(to)) return { ok: true, accountId: to };
    if (chain.names(to)) {
      const accountId = chain.canonical(to);
      if (accountId === ownerAccountId()) return { ok: true, accountId };
      return {
        ok: false,
        code: 'PERSON_UNREACHABLE',
        error:
          'Raises can reach only the owner for now. Leave `to` out to reach your manager, ' +
          'or name an agent.',
      };
    }
    return {
      ok: false,
      code: 'UNKNOWN_RECIPIENT',
      error: `Nobody here has the id "${to}". Name an agent id or the owner, or leave \`to\` out for your manager.`,
    };
  };
}

/**
 * Which chats are beat chats, by what started them: every beat chat, not only
 * today's.
 *
 * @param db - The database.
 */
export function beatChatResolver(db: Db): (sessionIds: string[]) => Set<string> {
  return (sessionIds) => {
    if (sessionIds.length === 0) return new Set();
    const rows = db
      .select({ id: sessionMetadata.sessionId })
      .from(sessionMetadata)
      .where(
        and(
          inArray(sessionMetadata.sessionId, sessionIds),
          eq(sessionMetadata.launchOrigin, 'heartbeat')
        )
      )
      .all();
    return new Set(rows.map((row) => row.id));
  };
}
