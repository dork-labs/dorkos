/**
 * Room orchestration: create, join, post, read cursor, thread create.
 *
 * The service owns the rules a room has that the tables cannot state — a thread
 * may not have a thread for a parent, a channel slug is unique while it is
 * live — and it publishes what happened to the two streams a room fans out on:
 * its own SSE stream for entries and signals, the global `/api/events` stream
 * for lifecycle. Membership lives next door in `room-roster.ts`.
 *
 * It deliberately does NOT trigger agents. Addressing and the cascade guard are
 * pure modules with their own tests (`addressing.ts`, `cascade-guard.ts`); R3
 * calls them from here. Posting an entry today reaches its readers and stops.
 *
 * @module server/services/rooms/room-service
 */
import { ulid } from 'ulidx';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { SignalType } from '@dorkos/shared/relay-schemas';
import type {
  CreateRoomRequest,
  Room,
  RoomEntry,
  RoomEntryBody,
  RoomKind,
  RoomMember,
  RoomRosterEntry,
  RoomSummary,
  RoomWithRoster,
  UpdateRoomRequest,
} from '@dorkos/shared/room-schemas';
import { eventFanOut } from '../core/event-fan-out.js';
import type { AuthorRegistry } from './author-registry.js';
import { deriveCascade } from './cascade-guard.js';
import { resolveMentions } from './mentions.js';
import { RoomError, type RoomAgentLookup } from './room-errors.js';
import { RoomRoster, type AddMemberInput } from './room-roster.js';
import type { RoomStore } from './room-store.js';
import type { RoomBroadcaster } from './room-stream.js';

/** Everything {@link RoomService} is constructed from. */
export interface RoomServiceDeps {
  store: RoomStore;
  authors: AuthorRegistry;
  broadcaster: RoomBroadcaster;
  agents: RoomAgentLookup;
}

/** Optional provenance a post carries when a trigger produced it (R3). */
export interface PostTrigger {
  root: string;
  depth: number;
}

/** Orchestration over the store, the roster, the author registry and the streams. */
export class RoomService {
  private readonly store: RoomStore;
  private readonly authors: AuthorRegistry;
  private readonly broadcaster: RoomBroadcaster;
  private readonly roster: RoomRoster;

  constructor(deps: RoomServiceDeps) {
    this.store = deps.store;
    this.authors = deps.authors;
    this.broadcaster = deps.broadcaster;
    this.roster = new RoomRoster({
      store: deps.store,
      authors: deps.authors,
      agents: deps.agents,
    });
  }

  /** The live subscription source behind `GET /api/rooms/:id/events`. */
  get stream(): RoomBroadcaster {
    return this.broadcaster;
  }

  /** The author registry, for callers that need to resolve their own identity. */
  get authorRegistry(): AuthorRegistry {
    return this.authors;
  }

  // === Rooms ===

  /**
   * Create a channel or a DM and seed its roster with the creator.
   *
   * @param request - The validated create request.
   * @param creatorAuthorId - The author opening the room; joined automatically.
   * @returns The new room with its roster.
   */
  createRoom(request: CreateRoomRequest, creatorAuthorId: string): RoomWithRoster {
    const slug = request.kind === 'channel' ? (request.slug ?? slugify(request.title ?? '')) : null;
    if (request.kind === 'channel' && !slug) {
      throw new RoomError(
        'INVALID_SLUG',
        'A channel name needs at least one letter or number, or give it a slug'
      );
    }
    if (slug && this.store.findLiveChannelBySlug(slug)) {
      throw new RoomError('SLUG_TAKEN', `A channel called #${slug} already exists`);
    }

    const room = this.store.createRoom({
      id: ulid(),
      kind: request.kind,
      parentId: null,
      slug,
      title: request.title ?? `#${slug ?? ''}`,
      topic: request.topic ?? null,
      workspaceId: request.workspaceId ?? null,
      rootEntryId: null,
      createdAt: new Date().toISOString(),
    });

    for (const authorId of new Set([creatorAuthorId, ...request.members])) {
      this.roster.add(room, { authorId });
    }

    eventFanOut.broadcast('room_created', { roomId: room.id, kind: room.kind, title: room.title });
    return this.withRoster(room);
  }

  /**
   * Open a thread off an entry. One level only — a thread of a thread is
   * refused here rather than silently flattened, because a reader who thought
   * they had branched twice and got one branch has been lied to.
   *
   * @param parentId - The room the thread hangs off.
   * @param rootEntryId - The entry it hangs off.
   * @param title - Optional title; defaults to the root entry's opening words.
   * @returns The new thread room with its roster.
   */
  createThread(parentId: string, rootEntryId: string, title?: string): RoomWithRoster {
    const parent = this.requireRoom(parentId);
    if (parent.kind === 'thread') {
      throw new RoomError('NESTED_THREAD', 'A thread cannot hang off another thread');
    }
    const rootEntry = this.store.getEntryById(parentId, rootEntryId);
    if (!rootEntry) throw new RoomError('ENTRY_NOT_FOUND', 'No such entry in this room');

    const thread = this.store.createRoom({
      id: ulid(),
      kind: 'thread',
      parentId: parent.id,
      slug: null,
      title: title ?? summarize(rootEntry.body.text),
      topic: null,
      workspaceId: parent.workspaceId,
      rootEntryId,
      createdAt: new Date().toISOString(),
    });
    this.roster.inherit(parent.id, thread.id);

    eventFanOut.broadcast('room_created', {
      roomId: thread.id,
      kind: thread.kind,
      title: thread.title,
      parentId: parent.id,
    });
    return this.withRoster(thread);
  }

  /**
   * Rooms visible to one viewer, each with that viewer's unread count.
   *
   * @param viewerAuthorId - Whose unread counts to compute.
   * @param filter.kind - Restrict to one room kind.
   * @param filter.includeArchived - Include archived rooms.
   */
  listRooms(
    viewerAuthorId: string,
    filter: { kind?: RoomKind; includeArchived?: boolean } = {}
  ): RoomSummary[] {
    const cursors = new Map(
      this.store.listMembershipsFor(viewerAuthorId).map((m) => [m.roomId, m.lastReadSeq])
    );
    return this.store.listRooms(filter).map((room) => ({
      ...room,
      unreadCount: this.store.countUnread(room.id, cursors.get(room.id) ?? 0),
    }));
  }

  /**
   * One room with its roster.
   *
   * @param roomId - The room id.
   * @returns The room, or `null` when there is none.
   */
  getRoom(roomId: string): RoomWithRoster | null {
    const room = this.store.getRoom(roomId);
    return room ? this.withRoster(room) : null;
  }

  /**
   * Patch a room's title, topic, or archived flag.
   *
   * @param roomId - The room id.
   * @param patch - The validated update request.
   * @returns The updated room with its roster.
   */
  updateRoom(roomId: string, patch: UpdateRoomRequest): RoomWithRoster {
    this.requireRoom(roomId);
    const updated = this.store.updateRoom(roomId, patch);
    if (!updated) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    eventFanOut.broadcast('room_updated', {
      roomId: updated.id,
      title: updated.title,
      archived: updated.archived,
    });
    return this.withRoster(updated);
  }

  // === Membership ===

  /**
   * Add a member by author id, or by agent directory when the agent has never
   * been an author before.
   *
   * @param roomId - The room.
   * @param input - Who to add, and optionally how they should behave.
   */
  addMember(roomId: string, input: AddMemberInput): RoomRosterEntry {
    const member = this.roster.add(this.requireRoom(roomId), input);
    eventFanOut.broadcast('room_member_added', { roomId, authorId: member.authorId });
    return member;
  }

  /**
   * Change one membership's per-room response mode.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @param responseMode - The new override.
   */
  updateMembership(roomId: string, authorId: string, responseMode: ResponseMode): RoomRosterEntry {
    this.requireRoom(roomId);
    return this.roster.setResponseMode(roomId, authorId, responseMode);
  }

  /**
   * Remove a member, dropping its per-room session binding with it.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   */
  removeMember(roomId: string, authorId: string): void {
    this.requireRoom(roomId);
    this.roster.remove(roomId, authorId);
    eventFanOut.broadcast('room_member_removed', { roomId, authorId });
  }

  /**
   * Advance a member's read cursor. Monotonic — a lower value is ignored.
   *
   * @param roomId - The room.
   * @param authorId - The member.
   * @param lastReadSeq - The seq they have read up to.
   */
  setReadCursor(roomId: string, authorId: string, lastReadSeq: number): RoomMember {
    this.requireRoom(roomId);
    return this.roster.setReadCursor(roomId, authorId, lastReadSeq);
  }

  // === Entries ===

  /**
   * A page of history, oldest-first.
   *
   * @param roomId - The room.
   * @param opts.before - Return entries with `seq` below this.
   * @param opts.limit - Page size.
   */
  listEntries(roomId: string, opts: { before?: number; limit: number }): RoomEntry[] {
    this.requireRoom(roomId);
    return this.store.listEntries(roomId, opts);
  }

  /**
   * Write a post: resolve its mentions against the roster, allocate its `seq`,
   * stamp its cascade provenance, and publish it to the room's readers.
   *
   * A post with no trigger starts a fresh cascade at depth 0 — which is what
   * makes a human able to re-engage a room the guard has stopped.
   *
   * @param roomId - The room.
   * @param input.authorId - Who is posting.
   * @param input.text - What they wrote.
   * @param input.sessionId - The session that produced it, if any.
   * @param input.trigger - Cascade provenance, when a trigger produced this (R3).
   * @returns The committed entry.
   */
  post(
    roomId: string,
    input: { authorId: string; text: string; sessionId?: string; trigger?: PostTrigger }
  ): RoomEntry {
    const room = this.requireRoom(roomId);
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    if (!this.store.getMember(roomId, input.authorId)) {
      throw new RoomError('MEMBER_NOT_FOUND', 'Not a member of this room');
    }

    const id = ulid();
    const entry = this.store.appendEntry({
      roomId,
      id,
      authorId: input.authorId,
      kind: 'post',
      body: { text: input.text },
      mentions: resolveMentions(input.text, this.roster.mentionCandidates(roomId)),
      sessionId: input.sessionId ?? null,
      ...deriveCascade(id, input.trigger),
      createdAt: new Date().toISOString(),
    });

    this.publishEntry(entry);
    return entry;
  }

  /**
   * Write a `notice` — the room speaking in its own voice, authored by the
   * system author. A refused trigger lands one of these; a silently dropped
   * trigger is indistinguishable from a broken agent.
   *
   * @param roomId - The room.
   * @param body - The notice body, e.g. from `buildCascadeNotice`.
   * @param cascade - The cascade this notice belongs to, so it stays traceable.
   * @returns The committed entry.
   */
  postNotice(
    roomId: string,
    body: RoomEntryBody,
    cascade?: { root: string; depth: number }
  ): RoomEntry {
    this.requireRoom(roomId);
    const id = ulid();
    const entry = this.store.appendEntry({
      roomId,
      id,
      authorId: this.authors.system().id,
      kind: 'notice',
      body,
      mentions: [],
      sessionId: null,
      cascadeRoot: cascade?.root ?? id,
      cascadeDepth: cascade?.depth ?? 0,
      createdAt: new Date().toISOString(),
    });
    this.publishEntry(entry);
    return entry;
  }

  /**
   * The distinct authors already in one cascade — the ancestry rule's input,
   * read here so R3's trigger path does not have to know the schema.
   *
   * @param roomId - The room.
   * @param cascadeRoot - The entry id that began the cascade.
   */
  authorsInCascade(roomId: string, cascadeRoot: string): string[] {
    return this.store.authorsInCascade(roomId, cascadeRoot);
  }

  // === Streaming ===

  /**
   * The snapshot a cold SSE connect opens with, plus the cursor its live
   * subscription resumes from.
   *
   * @param roomId - The room.
   * @param historyLimit - How many trailing entries to hydrate with.
   */
  snapshot(
    roomId: string,
    historyLimit: number
  ): { room: RoomWithRoster; entries: RoomEntry[]; cursor: number } {
    const room = this.requireRoom(roomId);
    const entries = this.store.listEntries(roomId, { limit: historyLimit });
    return {
      room: this.withRoster(room),
      entries,
      cursor: entries.length > 0 ? entries[entries.length - 1].seq : 0,
    };
  }

  /**
   * Every entry after a cursor — the SSE replay read. The log is never trimmed,
   * so this is always servable.
   *
   * @param roomId - The room.
   * @param afterSeq - Return entries with `seq` above this.
   */
  entriesAfter(roomId: string, afterSeq: number): RoomEntry[] {
    return this.store.listEntriesAfter(roomId, afterSeq);
  }

  /**
   * Deliver an ephemeral signal — typing, presence, a receipt. Live only: it
   * never enters the log and is dropped on replay, because a room's record is
   * what another member should be able to read later.
   *
   * @param roomId - The room.
   * @param signal - The signal type, from the relay's shared vocabulary.
   * @param authorId - Who the signal is about.
   */
  publishSignal(roomId: string, signal: SignalType, authorId: string): void {
    this.broadcaster.publish(roomId, {
      type: 'signal',
      signal,
      authorId,
      at: new Date().toISOString(),
    });
  }

  // === Internals ===

  /** Fetch a room or throw the typed not-found the routes map to a 404. */
  private requireRoom(roomId: string): Room {
    const room = this.store.getRoom(roomId);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    return room;
  }

  /** Publish a committed entry to the room's readers and bump global activity. */
  private publishEntry(entry: RoomEntry): void {
    this.broadcaster.publish(entry.roomId, { type: 'entry', seq: entry.seq, entry });
    eventFanOut.broadcast('room_activity', {
      roomId: entry.roomId,
      seq: entry.seq,
      lastActivityAt: entry.createdAt,
    });
  }

  /** Attach the resolved roster to a room. */
  private withRoster(room: Room): RoomWithRoster {
    return { ...room, members: this.roster.list(room.id) };
  }
}

/**
 * Derive a channel slug from a title: lowercase, hyphenated, trimmed to 80.
 * Returns `null` when the title has nothing sluggable in it, so the caller can
 * ask for a slug rather than inventing one nobody would recognise.
 */
function slugify(title: string): string | null {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/, '') || null
  );
}

/** First words of an entry, for a thread's default title. */
function summarize(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 60) return trimmed || 'Thread';
  return `${trimmed.slice(0, 57)}…`;
}
