/**
 * What an agent is told about the room it is answering in (ADR-0273, the
 * room-participation spec §6).
 *
 * Before this existed, a triggered agent got one sentence of prose glued onto
 * the front of the message: which room, who spoke, and a reminder that the
 * answer is public. No roster, no topic, no history, and — the part that made
 * the etiquette rules unfollowable — no indication of who is a person and who is
 * a machine. Block's Buzz computes exactly that per participant and then never
 * renders it, so their model cannot tell a colleague from a bot; this module is
 * the deliberate refusal to copy that.
 *
 * Two properties are load-bearing and easy to break:
 *
 * - **It emits structured data, never prose.** The rendering lives in the
 *   runtime adapters (`runtimes/shared/room-context-block.ts` writes the block
 *   all three of them use), so a room works identically on claude-code, codex
 *   and opencode without this file knowing any of them exist. That is the whole
 *   reason room framing is a `ContextKind` rather than a prompt.
 * - **It is server-derived.** `ClientContext` is parsed off the wire; a roster a
 *   caller could supply is a roster a caller could forge, so nothing here reads
 *   anything a client sent.
 *
 * Pure over the store, the roster, the dispatcher's live claims and the budget:
 * no runtime, no clock beyond the entries' own timestamps, no model. Assembling
 * this must never cost a turn (`meta/agent-etiquette.md` E7 — if an agent is
 * charged for listening, restraint becomes something the product punishes).
 *
 * @module server/services/rooms/room-context
 */
import type { RoomContextData, RoomContextEntry } from '@dorkos/shared/additional-context';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import type { AuthorRecord, AuthorRegistry } from './author-registry.js';
import type { RoomAgentLookup } from './room-errors.js';
import type { RoomStore } from './room-store.js';

/**
 * How many unread entries reach the model at most, oldest dropped.
 *
 * A cap rather than a setting for now. Every agent's read cursor is `0` until
 * something advances it, so without a clamp the first triggered turn in a busy
 * room would replay the entire log. The room-participation spec's RP3 phase
 * turns this into `rooms.ambientMaxEntries` (default 30) when it wires the
 * cursor; until then it is the same number, spelled once.
 */
const PENDING_MAX_ENTRIES = 30;

/** How many of the agent's own recent posts it is reminded of. */
const OWN_RECENT_MAX_ENTRIES = 5;

/** How much of a thread's opening message is quoted back as its subject. */
const THREAD_EXCERPT_CHARS = 200;

/**
 * Handle for an author whose row has vanished. Rendering something honest beats
 * dropping the line: a message with no attribution is still a message that was
 * said, and hiding it would leave the agent reading half a conversation.
 */
const UNKNOWN_HANDLE = 'unknown';

/** The data this module reads. Everything is synchronous (`better-sqlite3`). */
export interface RoomContextDeps {
  store: RoomStore;
  authors: AuthorRegistry;
  /** Resolves an agent's handle from its directory — what an `@mention` matches. */
  agents: RoomAgentLookup;
}

/** The one turn being described. */
export interface RoomContextInput {
  /**
   * The room the turn was triggered in, and the room every read below is scoped
   * to: its roster, its log, its read cursor. For a thread turn that is the
   * CHANNEL, because a thread is a set of entries inside it rather than a room
   * of its own (ADR 260728-022013) — so an agent answering in a thread reads the
   * channel's history and answers on the channel's session, which is the
   * continuity the child-room shape threw away.
   */
  room: Room;
  /** The agent whose turn this is. */
  agentAuthorId: string;
  /** The entry that triggered it. Never appears in `pending`: it IS the message. */
  entry: RoomEntry;
  /** Other agents holding a turn claim in this room right now. */
  working: ReadonlyArray<{ authorId: string; since: string }>;
  /** Automatic turns still available this hour, per room and in total. */
  budget: { room: number; global: number };
  /** The cascade ceiling minus this turn's depth. */
  repliesLeftInThisChain: number;
}

/**
 * Describe one room turn for the agent about to run it.
 *
 * @param deps - The store, the author registry, and the agent handle lookup.
 * @param input - The room, the agent, the trigger, and the live bounds.
 * @returns The structured entry an adapter renders into `<room_context>`.
 */
export function buildRoomContext(deps: RoomContextDeps, input: RoomContextInput): RoomContextData {
  // The two rooms collapsed into one (ADR 260728-022013): a thread reply lives
  // in the channel's own log, so the room the turn HAPPENED in and the
  // conversation it is ABOUT are the same room, and `frame` reads the position
  // within it off the triggering entry rather than off a container.
  const frame = resolveFrame(deps, input.room, input.entry);
  const members = deps.store.listMembers(input.room.id);
  const self = members.find((member) => member.authorId === input.agentAuthorId);

  // Read one more than the cap: a full page means older entries were dropped,
  // and that is what `pendingTruncated` reports. The cap, the cursor and both
  // exclusions are in SQL — see the store method for why that matters.
  const window = deps.store.listUnreadEntries(input.room.id, {
    afterSeq: self?.lastReadSeq ?? 0,
    // Its own posts are reported separately as `ownRecent`, outside the
    // untrusted fence, because it wrote them.
    excludeAuthorId: input.agentAuthorId,
    // The triggering entry is the message the agent is answering; it arrives as
    // the turn's `content`, not as history.
    excludeEntryId: input.entry.id,
    limit: PENDING_MAX_ENTRIES + 1,
  });
  const pendingTruncated = window.length > PENDING_MAX_ENTRIES;
  const missed = pendingTruncated ? window.slice(-PENDING_MAX_ENTRIES) : window;
  // Read off the whole log rather than off the unread window: the point of it is
  // that an agent triggered again does not repeat what it already said, and what
  // it already said sits behind its own cursor by definition.
  const ownRecent = deps.store.listEntriesByAuthor(
    input.room.id,
    input.agentAuthorId,
    OWN_RECENT_MAX_ENTRIES
  );

  // Resolve authors from the ROSTER PLUS whoever actually wrote the entries
  // being rendered. Roster-only was wrong in a way that inverted the one field
  // this whole kind exists for: `removeMember` is a real path, and a person who
  // left the room had every message they ever sent relabelled as machine-written.
  const records = deps.authors.getMany([
    ...members.map((member) => member.authorId),
    ...missed.map((entry) => entry.authorId),
    ...ownRecent.map((entry) => entry.authorId),
    ...input.working.map((claim) => claim.authorId),
  ]);
  const handles = new Map<string, string>();
  const people = new Set<string>();
  for (const [id, record] of records) {
    handles.set(id, handleFor(deps, record));
    if (record.kind === 'human') people.add(id);
  }

  const flatten = (entry: RoomEntry): RoomContextEntry => ({
    authorHandle: handles.get(entry.authorId) ?? UNKNOWN_HANDLE,
    authorIsPerson: people.has(entry.authorId),
    kind: entry.kind,
    at: entry.createdAt,
    text: entry.body.text,
    mentionsMe: entry.mentions.includes(input.agentAuthorId),
  });

  return {
    room: frame.room,
    thread: frame.thread,
    members: members.map((member) => {
      const record = records.get(member.authorId);
      return {
        handle: handles.get(member.authorId) ?? UNKNOWN_HANDLE,
        displayName: record?.displayName ?? 'Unknown',
        isPerson: record?.kind === 'human',
        isSelf: member.authorId === input.agentAuthorId,
        ...(record?.kind === 'agent' ? { responseMode: member.responseMode } : {}),
      };
    }),
    working: input.working
      .filter((claim) => claim.authorId !== input.agentAuthorId)
      .map((claim) => ({
        handle: handles.get(claim.authorId) ?? UNKNOWN_HANDLE,
        since: claim.since,
      })),
    pending: missed.map(flatten),
    pendingTruncated,
    ownRecent: ownRecent.map(flatten),
    addressing: {
      responseMode:
        self?.responseMode ?? fallbackResponseMode(deps, records.get(input.agentAuthorId)),
      // The `engaged` mode is a later phase (spec §9); nothing can be engaged
      // yet, so this is honestly null rather than speculatively computed.
      engagedUntil: null,
      addressedNow: input.entry.mentions.includes(input.agentAuthorId),
    },
    budget: {
      automaticRepliesLeftInThisRoomThisHour: input.budget.room,
      automaticRepliesLeftInTotalThisHour: input.budget.global,
      repliesLeftInThisChain: input.repliesLeftInThisChain,
    },
  };
}

/** How the conversation is named to the agent, and where in it this turn sits. */
interface ContextFrame {
  room: RoomContextData['room'];
  thread: RoomContextData['thread'];
}

/**
 * Name the conversation this turn belongs to, and say where in it the turn sits.
 *
 * An agent answering in a thread is inside the channel the thread hangs off, so
 * the frame is that channel's name and topic and the thread is carried as a
 * POSITION within it — `RoomContextData.room.kind` has no `thread` member on
 * purpose. Under the entry relation (ADR 260728-022013) the frame needs no
 * lookup at all: `room` already IS the channel, and the position comes off the
 * triggering entry's own pointer.
 *
 * @param room - The room the turn was triggered in.
 * @param entry - The entry that triggered it; its thread pointer is the position.
 */
function resolveFrame(deps: RoomContextDeps, room: Room, entry: RoomEntry): ContextFrame {
  if (room.kind === 'thread') return legacyChildRoomFrame(deps, room);
  return { room: frameOf(room, room.kind), thread: threadOf(deps, room, entry) };
}

/**
 * Where this turn sits in the room's log: inside a thread, or at the top level.
 *
 * `null` for a top-level turn, which is most of them — the pointer being null is
 * the whole test, so a channel with no threads in it costs no query.
 */
function threadOf(deps: RoomContextDeps, room: Room, entry: RoomEntry): RoomContextData['thread'] {
  const rootEntryId = entry.threadRootEntryId;
  if (!rootEntryId) return null;
  // The root is in THIS room — that is the change. Under the child-room shape it
  // lived in the parent's log and this had to cross a room boundary to find it.
  const root = deps.store.getEntryById(room.id, rootEntryId);
  return {
    rootEntryId,
    rootExcerpt: (root?.body.text ?? '').slice(0, THREAD_EXCERPT_CHARS),
    // Counted over the relation, NOT by reusing `countUnread(threadRoomId, 0)`
    // the way the child-room shape did. That reuse read "how many entries are in
    // this thread room" out of the unread counter, and it only ever worked
    // because a thread had a room to itself.
    replyCount: deps.store.countThreadReplies(room.id, rootEntryId),
  };
}

/**
 * The frame for a thread that is still stored as a child room.
 *
 * **Transitional, and deliberately unreachable for anything created from now
 * on.** `RoomService` no longer mints a `kind: 'thread'` room, so this serves
 * rows that predate DOR-634 and nothing else. It is here rather than deleted
 * because deleting it would silently stop telling an agent it is in a thread for
 * any install that has one; PR 3 of DOR-634 drops the `thread` room kind and
 * this function with it.
 *
 * Frames the PARENT's name and topic, and reads the thread's replies out of the
 * child room's own log — which for such a room is every entry in it, since the
 * entry it hangs off lives in the parent.
 */
function legacyChildRoomFrame(deps: RoomContextDeps, room: Room): ContextFrame {
  const parent = room.parentId ? deps.store.getRoom(room.parentId) : null;
  const root =
    parent && room.rootEntryId ? deps.store.getEntryById(parent.id, room.rootEntryId) : null;
  const thread = room.rootEntryId
    ? {
        rootEntryId: room.rootEntryId,
        rootExcerpt: (root?.body.text ?? '').slice(0, THREAD_EXCERPT_CHARS),
        replyCount: deps.store.countUnread(room.id, 0),
      }
    : null;

  // A thread whose parent has vanished frames itself, because a conversation
  // with a stale name beats an agent with no idea where it is.
  if (!parent || parent.kind === 'thread') return { room: frameOf(room, 'channel'), thread };
  return { room: frameOf(parent, parent.kind), thread };
}

/** Project a room onto the frame shape, whose `kind` excludes `thread`. */
function frameOf(room: Room, kind: 'channel' | 'dm'): RoomContextData['room'] {
  return {
    id: room.id,
    kind,
    name: roomName(room),
    ...(room.topic ? { topic: room.topic } : {}),
  };
}

/**
 * What an `@mention` resolves this author against: an agent's handle, or the
 * name a person renders under.
 *
 * Kept in step with `RoomRoster.mentionCandidates`, which resolves `@name` the
 * same way at write time. A handle the agent cannot be addressed by would be
 * worse than no handle: it invites a message that reaches nobody.
 */
function handleFor(deps: RoomContextDeps, record: AuthorRecord): string {
  if (record.kind !== 'agent') return record.displayName;
  return deps.agents.byPath(record.naturalKey)?.name ?? record.displayName;
}

/**
 * The response mode to report for an agent with no membership row in this room.
 *
 * Unreachable through a trigger — addressing selects targets from the roster —
 * but a room turn can be requested for a scope whose membership lives on the
 * parent, so the manifest default is the honest answer rather than a guess.
 */
function fallbackResponseMode(deps: RoomContextDeps, record?: AuthorRecord): ResponseMode {
  if (!record || record.kind !== 'agent') return 'always';
  return deps.agents.byPath(record.naturalKey)?.responseMode ?? 'always';
}

/** How a room is named to an agent: `#slug` for a channel, the title otherwise. */
function roomName(room: Room): string {
  return room.slug ? `#${room.slug}` : room.title;
}
