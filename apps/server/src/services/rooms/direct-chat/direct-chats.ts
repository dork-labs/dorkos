/**
 * Each agent's one standing Direct chat with the person (rule S12, DOR-2997).
 *
 * **The view follows who is in the conversation.** The person plus one agent is
 * always the 1:1 view: the chat composer and the session stream. A room with a
 * second person or a second agent is a room. So the operator's two-member DM
 * with an agent never opens as a room again; it opens as that agent's Direct
 * chat.
 *
 * **Built from what already exists, ahead of conversation-model step 4.** The
 * Direct chat is two things this domain already keeps:
 *
 * - **The log** is the operator-plus-agent `dm` room, found (or opened, once) by
 *   its exact member set. `relay_notify_user` keeps posting there, so agents'
 *   room tools, search, notifications and read cursors keep working unchanged.
 * - **The session** is the agent's seat in that room (`room_sessions`), minted
 *   the first time anybody needs it. The app opens it in the 1:1 view, and room
 *   turns already in it read as the person's message and the agent's work.
 *
 * Nothing is copied and nothing is deleted, so folding the old DM rooms in is
 * forward-only and idempotent by construction: a room that has a seat keeps it,
 * and one that has none gets one when it is first opened.
 *
 * **A room that gains a member stops being a Direct chat.** Every question here
 * re-reads the roster, so a DM that someone added a third member to answers
 * `null`, and the next ping finds no two-member DM and opens a fresh one.
 *
 * @module services/rooms/direct-chat/direct-chats
 */
import { randomUUID } from 'node:crypto';
import type { DirectNote, DirectNotesData } from '@dorkos/shared/additional-context';
import type { CreateRoomRequest } from '@dorkos/shared/room-schemas';
import type { AuthorRecord, AuthorRegistry } from '../author-registry.js';
import type { RoomStore } from '../room-store.js';

/** An agent's Direct chat: the room underneath it and the session it opens. */
export interface DirectChat {
  /** The two-member DM room that holds its log. */
  roomId: string;
  /** The session the app opens, which is the agent's seat in that room. */
  sessionId: string;
  /**
   * Every id that session has held, current first. A runtime can rename a
   * session mid-turn, and the room's entries keep the id their turn ran under,
   * so "did this session write it" has to ask about all of them.
   */
  sessionIds: string[];
  /** The agent's directory, which is its identity. */
  agentPath: string;
  /** The agent's author id in the room. */
  agentAuthorId: string;
}

/** The rooms surface this needs: opening a DM, narrowed to that one verb. */
export interface DirectChatRooms {
  createRoom(request: CreateRoomRequest, creatorAuthorId: string): { id: string };
}

/** Dependencies for {@link DirectChats}. */
export interface DirectChatsDeps {
  store: Pick<
    RoomStore,
    | 'getRoom'
    | 'listMembers'
    | 'getMember'
    | 'findDmByMemberSet'
    | 'getRoomSession'
    | 'bindRoomSession'
    | 'listEntriesAfter'
    | 'setReadCursor'
    | 'sessionLedger'
  >;
  authors: Pick<AuthorRegistry, 'resolveAgent' | 'getMany'>;
  rooms: DirectChatRooms;
  /** The person's author id, read per call: an install can gain an owner. */
  operator: () => AuthorRecord;
  /** Mints a session id. A test pins it. */
  mintSessionId?: () => string;
  /** The clock a binding is stamped with. */
  now?: () => string;
}

/** How many unseen messages one turn carries before the oldest are left out. */
export const DIRECT_NOTES_LIMIT = 20;

/** Every Direct chat question, answered from the rooms store. */
export class DirectChats {
  private readonly mintSessionId: () => string;
  private readonly now: () => string;

  constructor(private readonly deps: DirectChatsDeps) {
    this.mintSessionId = deps.mintSessionId ?? randomUUID;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * The agent's Direct chat, opening the DM and minting its seat on first need.
   *
   * @param agentPath - The agent's directory.
   * @param displayName - Its name, for a DM opened for the first time.
   */
  ensureForAgent(agentPath: string, displayName: string): DirectChat {
    const agent = this.deps.authors.resolveAgent(agentPath, displayName);
    const operator = this.deps.operator();
    // Find-or-create on the exact member set, which also un-archives one the
    // person tidied away: a standing chat is never archived for good.
    const room = this.deps.rooms.createRoom(
      { kind: 'dm', title: displayName, members: [], agentPaths: [agentPath] },
      operator.id
    );
    return this.seat(room.id, agent);
  }

  /**
   * The Direct chat this room is, or `null` when it is not the person's
   * two-member DM with one agent (a channel, a group DM, a bridged chat, or a
   * DM that has gained a member).
   *
   * @param roomId - The room.
   */
  ensureForRoom(roomId: string): DirectChat | null {
    const agent = this.directAgentOf(roomId);
    return agent ? this.seat(roomId, agent) : null;
  }

  /**
   * The Direct chat behind a session, or `null` when the session is not one.
   * Reads only; never mints.
   *
   * @param sessionId - Any id the session has held.
   */
  forSession(sessionId: string): DirectChat | null {
    const binding = this.deps.store.sessionLedger.bindingForSession(sessionId);
    if (!binding) return null;
    const agent = this.directAgentOf(binding.roomId);
    if (!agent || agent.id !== binding.authorId) return null;
    return {
      roomId: binding.roomId,
      sessionId: binding.sessionId,
      sessionIds: this.idsOf(binding.sessionId),
      agentPath: agent.naturalKey,
      agentAuthorId: agent.id,
    };
  }

  /**
   * What reached this session's Direct chat that the session has not seen, and
   * move the agent's read cursor past it, so each message reaches one turn.
   *
   * Leaves out what this session wrote itself (it is already in the
   * transcript) and notices (the room speaking about itself).
   *
   * @param sessionId - The session a turn is starting on.
   * @returns The notes, or `null` when there are none or this is no Direct chat.
   */
  takeUnseen(sessionId: string): DirectNotesData | null {
    const chat = this.forSession(sessionId);
    if (!chat) return null;
    const member = this.deps.store.getMember(chat.roomId, chat.agentAuthorId);
    if (!member) return null;
    const entries = this.deps.store.listEntriesAfter(chat.roomId, member.lastReadSeq);
    if (entries.length === 0) return null;
    this.deps.store.setReadCursor(chat.roomId, chat.agentAuthorId, entries[entries.length - 1].seq);
    const ownIds = new Set(chat.sessionIds);
    const unseen = entries.filter(
      (entry) => entry.kind === 'post' && (entry.sessionId === null || !ownIds.has(entry.sessionId))
    );
    if (unseen.length === 0) return null;
    const shown = unseen.slice(-DIRECT_NOTES_LIMIT);
    const authors = this.deps.authors.getMany([...new Set(shown.map((e) => e.authorId))]);
    const notes: DirectNote[] = shown.map((entry) => ({
      at: entry.createdAt,
      from: authors.get(entry.authorId)?.displayName || 'Someone',
      fromYou: entry.authorId === chat.agentAuthorId,
      text: entry.body.text,
    }));
    return {
      withName: this.deps.operator().displayName || 'the person',
      notes,
      omitted: unseen.length - shown.length,
    };
  }

  /** The one agent in the person's two-member DM, or `null` when the room is not one. */
  private directAgentOf(roomId: string): AuthorRecord | null {
    const room = this.deps.store.getRoom(roomId);
    if (!room || room.kind !== 'dm') return null;
    const members = this.deps.store.listMembers(roomId);
    if (members.length !== 2) return null;
    const operator = this.deps.operator();
    if (!members.some((member) => member.authorId === operator.id)) return null;
    const records = this.deps.authors.getMany(members.map((member) => member.authorId));
    const agents = [...records.values()].filter((record) => record.kind === 'agent');
    if (agents.length !== 1) return null;
    // A bridged chat has the same roster as the person's own DM and carries no
    // member-set key, so asking which room holds this exact set rules it out.
    if (this.deps.store.findDmByMemberSet([operator.id, agents[0].id])?.id !== roomId) return null;
    return agents[0];
  }

  /** The agent's seat in the room: the bound session, or one minted now. */
  private seat(roomId: string, agent: AuthorRecord): DirectChat {
    const sessionId =
      this.deps.store.getRoomSession(roomId, agent.id) ??
      this.deps.store.bindRoomSession(roomId, agent.id, this.mintSessionId(), this.now());
    return {
      roomId,
      sessionId,
      sessionIds: this.idsOf(sessionId),
      agentPath: agent.naturalKey,
      agentAuthorId: agent.id,
    };
  }

  /** A session's current id, then every id it was renamed away from. */
  private idsOf(sessionId: string): string[] {
    return [sessionId, ...this.deps.store.sessionLedger.retiredIdsFor(sessionId)];
  }
}
