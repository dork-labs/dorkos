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
 * - **Every handle in it is one the resolver would return.** Ownership is read
 *   from `author-handles.ts` — the same computation, over the same candidate
 *   sequence, that `resolveMentions` runs when a message is written. An author
 *   no string reaches gets `null` rather than a name that looks like an address,
 *   because a model handed a name it cannot be reached by cannot tell.
 *
 * Pure over the store, the roster, the dispatcher's live claims and the budget:
 * no runtime, no clock beyond the entries' own timestamps, no model. Assembling
 * this must never cost a turn (`meta/agent-etiquette.md` E7 — if an agent is
 * charged for listening, restraint becomes something the product punishes).
 *
 * @module server/services/rooms/room-context
 */
import type {
  RoomContextAcknowledgment,
  RoomContextAuthor,
  RoomContextData,
  RoomContextEntry,
} from '@dorkos/shared/additional-context';
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { Room, RoomAttachment, RoomEntry } from '@dorkos/shared/room-schemas';
import type { BridgedRoomFraming } from '../relay/chat-bridge/room-context-framing.js';
import { addressableHandles, rosterMentionCandidates } from './handles/author-handles.js';
import type { EngagementWindow } from './engagement.js';
import {
  authorOrigin,
  isExternalNaturalKey,
  type AuthorRecord,
  type AuthorRegistry,
} from './author-registry.js';
import type { ReactionStore } from './reaction-store.js';
import type { RoomAgentLookup } from './room-errors.js';
import type { RoomStore } from './room-store.js';
import { projectedAttachmentPath, storedExtension } from './attachments/attachment-paths.js';

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
 * How many acknowledgments reach the model at most, newest first.
 *
 * They are already bounded by {@link OWN_RECENT_MAX_ENTRIES} — only reactions on
 * the agent's own recent posts are reported — but one popular message can carry
 * a dozen pills on its own, and a turn that opened with twelve lines of thanks
 * would be a turn spent reading thanks.
 */
const ACKNOWLEDGMENTS_MAX = 5;

/** How much of the agent's own reacted-to message is quoted back to identify it. */
const ACKNOWLEDGMENT_EXCERPT_CHARS = 80;

/**
 * Name for an author whose row has vanished. Rendering something honest beats
 * dropping the line: a message with no attribution is still a message that was
 * said, and hiding it would leave the agent reading half a conversation. The
 * same word `RoomRoster` uses for the same state, so one absent author does not
 * read as two different people on two surfaces.
 */
const UNKNOWN_DISPLAY_NAME = 'Unknown';

/** The data this module reads. Everything is synchronous (`better-sqlite3`). */
export interface RoomContextDeps {
  store: RoomStore;
  /** Reactions on this agent's own posts — read only, and never a reason to run. */
  reactions: ReactionStore;
  authors: AuthorRegistry;
  /** Resolves an agent's handle from its directory — one name an `@` may match. */
  agents: RoomAgentLookup;
  /**
   * What this room's turn is told about the chat it projects, or `null` for an
   * unbridged room (chats-as-channels §8, §9.2, §15).
   *
   * Injected as a predicate, in the same style as `RoomServiceDeps.isOwnerAuthor`
   * and `maxAgentDepth`, so this module still reads no store — and no platform —
   * it does not already own: everything Telegram-shaped stays behind this one
   * function (`chat-bridge/room-context-framing.ts`), which is what keeps this
   * file honest about "no runtime knows a room is bridged" extending to "this
   * builder does not know Telegram exists either."
   *
   * Non-`null` decides three things: whether the untrusted fence carries the
   * standing line about strangers, whether `room.visibility` is reported, and
   * whether `room.formatting` guidance rides the turn.
   *
   * A property of the ROOM, deliberately not of the members who happen to have
   * spoken. A bridged group that no stranger has posted in yet is still a
   * channel that receives messages from strangers, and the sentence is about
   * what may arrive rather than about what already has.
   */
  bridgedFraming(roomId: string): BridgedRoomFraming | null;
  /**
   * The stored forum-topic name for a batch of entries, keyed by entry id, or
   * an empty map for any entry with none — chats-as-channels §5.6's per-entry
   * label, read once per turn for every candidate in `pending` and `ownRecent`
   * rather than once per entry.
   */
  topicNamesFor(entryIds: readonly string[]): Map<string, string>;
  /**
   * The attachments on a batch of entries, keyed by entry id, or an empty map
   * for any entry with none — read once per turn for every candidate in
   * `pending` and `ownRecent`, exactly as {@link RoomContextDeps.topicNamesFor}
   * is.
   *
   * Takes the room explicitly rather than closing over one: this deps object is
   * built once per service and reused for every room, so a captured room id
   * would be the wrong room on the second call.
   */
  attachmentsFor(roomId: string, entryIds: readonly string[]): Map<string, RoomAttachment[]>;
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
  /**
   * This agent's open engaged window here, or `null` when it is not in one — a
   * `responseMode` other than `engaged` is always `null`, because saying
   * otherwise would describe a window nothing reads.
   *
   * Passed in rather than derived: the predicate needs a clock and this module
   * has none (`engagement.ts` owns it, `room-trigger.ts` evaluates it once per
   * entry and threads it here).
   */
  engaged: EngagementWindow | null;
}

/**
 * One file the agent is about to be TOLD about, and therefore one the projector
 * is obliged to put on disk before the turn starts.
 *
 * It carries the ids and the extension the built context deliberately does not:
 * a `RoomContextEntry` names a file by relative path and human name only,
 * because that is all a model needs.
 */
export interface ProjectableAttachment {
  /** The entry the file was posted with — what scopes its projected directory. */
  entryId: string;
  /** The attachment id, which is also its basename in the store. */
  attachmentId: string;
  /** The suffix the bytes are stored under, without a dot. May be `''`. */
  extension: string;
  /** The sanitized filename, as the model is told it. */
  name: string;
  /** Where it must land, relative to the agent's working directory. */
  relativePath: string;
}

/**
 * Describe one room turn for the agent about to run it, and say which files
 * have to exist for that description to be true.
 *
 * **The projection plan comes back from HERE rather than being recomputed.**
 * ADR 260807-233816 rests on one invariant — the agent is only told about files
 * it can open — and the two halves of that sentence are written in two
 * different modules. The rejected alternative was a second, independent query
 * in the turn runner: it would have made the lockstep a thing two code paths
 * have to keep agreeing about, over a window (`PENDING_MAX_ENTRIES` plus
 * `OWN_RECENT_MAX_ENTRIES`) that only this function resolves — and the failure
 * mode is silent, an agent handed a path to a file that was never projected.
 * A `RoomContextEntry` cannot carry the plan itself: it has no entry id and no
 * attachment id, so a projector reading the built context would have to
 * reverse-parse its own path strings. So the plan is built in the SAME pass,
 * from the SAME map, and returned beside the context.
 *
 * @param deps - The store, the author registry, and the agent handle lookup.
 * @param input - The room, the agent, the trigger, and the live bounds.
 * @returns The structured entry an adapter renders into `<room_context>`, and
 *   the exact set of files that context refers to.
 */
export function buildRoomContext(
  deps: RoomContextDeps,
  input: RoomContextInput
): { context: RoomContextData; projection: ProjectableAttachment[] } {
  // Read once, reused for the frame below and for gating the topic-label
  // lookup further down — a second call would be a second bridge-store read
  // for the same answer.
  const framing = deps.bridgedFraming(input.room.id);
  // The two rooms collapsed into one (ADR 260728-022013): a thread reply lives
  // in the channel's own log, so the room the turn HAPPENED in and the
  // conversation it is ABOUT are the same room, and `frame` reads the position
  // within it off the triggering entry rather than off a container.
  const frame = resolveFrame(deps, input.room, input.entry, framing);
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

  // The forum-topic label for every candidate this turn might render, in ONE
  // query — gated on `framing` so an unbridged room's turn never touches the
  // bridge store at all (chats-as-channels §5.6).
  const rendered = [...missed, ...ownRecent];
  const topicNames = framing
    ? deps.topicNamesFor(rendered.map((entry) => entry.id))
    : new Map<string, string>();

  // The attachments on those SAME entries, in ONE query. Ungated, unlike the
  // topic labels above: any room may carry files, bridged or not.
  const attachmentsByEntry = deps.attachmentsFor(
    input.room.id,
    rendered.map((entry) => entry.id)
  );
  // Built in the same pass as the fill below, from this same map, so the set of
  // paths the model is told about and the set of files the projector creates
  // cannot be two different answers.
  const projection: ProjectableAttachment[] = [];

  // Reactions on those same posts, in ONE query. Scoped to `ownRecent` because
  // that is what makes an acknowledgment age out on its own: five more messages
  // from this agent and an old pill stops riding every turn. Reading them costs
  // no model call, which is the point — being thanked must stay free
  // (`meta/agent-etiquette.md` E7).
  const reacted = deps.reactions.listFor(
    input.room.id,
    ownRecent.map((entry) => entry.id)
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
    // Somebody who reacted may have left the room since, exactly as an entry's
    // author may have — so they are resolved from the same union rather than
    // assumed to be on the roster.
    ...[...reacted.values()].flatMap((pills) => pills.flatMap((pill) => pill.authorIds)),
  ]);
  const people = new Set<string>();
  // Both sets are read off the SAME stored rows, once: `kind` says person or
  // machine, the natural key says this machine or somewhere else. Neither is a
  // property of the message being processed, which is exactly why an entry
  // written two years ago still answers both questions the same way today
  // (spec §9.1).
  const externals = new Set<string>();
  for (const [id, record] of records) {
    if (record.kind === 'human') people.add(id);
    if (isExternalNaturalKey(record.naturalKey)) externals.add(id);
  }
  // The SAME projection the mention picker runs, over the SAME candidate
  // sequence `resolveMentions` is handed at write time (`RoomService` →
  // `RoomRoster.addressingCandidates`). Not a second rule that happens to agree:
  // the defect this replaced was exactly that, one function returning
  // `agents.name` unfiltered while the picker refused the same string.
  const handles = addressableHandles(rosterMentionCandidates(members, records, deps.agents).live);

  const flatten = (entry: RoomEntry): RoomContextEntry => {
    const author = nameOf(entry.authorId);
    return {
      authorHandle: author.handle,
      authorDisplayName: author.displayName,
      authorIsPerson: people.has(entry.authorId),
      // Off the STORED key of whoever wrote it, which is what makes this a fact
      // about the entry rather than about the moment it renders (spec §9.1). An
      // author row that has vanished reads as local: the row is retired, never
      // deleted, so this is a corrupt-database placeholder and not a case a
      // stranger can steer into.
      authorOrigin: externals.has(entry.authorId) ? 'external' : 'local',
      kind: entry.kind,
      at: entry.createdAt,
      text: entry.body.text,
      mentionsMe: entry.mentions.includes(input.agentAuthorId),
      // Already sanitized once, at write time (spec §9.2, A9.3) — carried
      // through raw so the renderer can sanitize it again at render.
      topicLabel: topicNames.get(entry.id) ?? null,
      attachments: (attachmentsByEntry.get(entry.id) ?? []).map((file) => {
        const relativePath = projectedAttachmentPath(entry.id, file.id, file.name);
        // Recording the plan HERE is what makes the lockstep structural: an
        // entry that reaches the model records its files in the same statement
        // that tells the model about them.
        projection.push({
          entryId: entry.id,
          attachmentId: file.id,
          extension: storedExtension(file.name),
          name: file.name,
          relativePath,
        });
        return { name: file.name, path: relativePath };
      }),
    };
  };

  /**
   * The address that reaches an author here, and the name they render under.
   *
   * **The handle comes from the roster's addressable map and nowhere else**, so an
   * author who is not on the roster gets `null` even though a perfectly good
   * name of their own is sitting right there in `records`. That is the point.
   * `removeMember` is a real path and an entry outlives its author's
   * membership, but mentions resolve against the room's CURRENT roster
   * (`RoomService.post`), so nothing anyone types reaches somebody who has left.
   * Printing their name back with an `@` would be inert at best — and at worst a
   * mis-address, because the name a departed member answered to may now be
   * claimed by somebody still in the room. The name without the `@` keeps the
   * attribution and claims nothing.
   */
  function nameOf(authorId: string): RoomContextAuthor {
    return {
      handle: handles.get(authorId) ?? null,
      displayName: records.get(authorId)?.displayName ?? UNKNOWN_DISPLAY_NAME,
    };
  }

  /**
   * Every reaction standing on the agent's own recent posts, newest first.
   *
   * Newest is decided by the ENTRY, not by the reaction: `ownRecent` is
   * oldest-first, so walking it backwards puts the freshest message's thanks at
   * the top — which is the order the agent would care about them in, and the one
   * the excerpt lines up with.
   */
  function acknowledgments(): RoomContextAcknowledgment[] {
    const found: RoomContextAcknowledgment[] = [];
    for (let i = ownRecent.length - 1; i >= 0 && found.length < ACKNOWLEDGMENTS_MAX; i -= 1) {
      const entry = ownRecent[i];
      for (const pill of reacted.get(entry.id) ?? []) {
        for (const authorId of pill.authorIds) {
          if (found.length >= ACKNOWLEDGMENTS_MAX) break;
          found.push({
            ...nameOf(authorId),
            isPerson: people.has(authorId),
            emoji: pill.emoji,
            entryAt: entry.createdAt,
            entryExcerpt: entry.body.text.slice(0, ACKNOWLEDGMENT_EXCERPT_CHARS),
          });
        }
      }
    }
    return found;
  }

  const context: RoomContextData = {
    room: frame.room,
    thread: frame.thread,
    members: members.map((member) => {
      const record = records.get(member.authorId);
      return {
        ...nameOf(member.authorId),
        isPerson: record?.kind === 'human',
        isSelf: member.authorId === input.agentAuthorId,
        // Same source as `authorOrigin` on an entry, at the finer grain a roster
        // can afford: the roster names the platform, an entry line only carries
        // the trust bit (§4.3).
        origin: record ? authorOrigin(record.naturalKey) : 'local',
        ...(record?.kind === 'agent' ? { responseMode: member.responseMode } : {}),
      };
    }),
    working: input.working
      .filter((claim) => claim.authorId !== input.agentAuthorId)
      .map((claim) => ({ ...nameOf(claim.authorId), since: claim.since })),
    pending: missed.map(flatten),
    pendingTruncated,
    ownRecent: ownRecent.map(flatten),
    acknowledgments: acknowledgments(),
    addressing: {
      responseMode:
        self?.responseMode ?? fallbackResponseMode(deps, records.get(input.agentAuthorId)),
      engagedUntil: input.engaged?.until.toISOString() ?? null,
      engagedPostsLeft: input.engaged?.postsLeft ?? null,
      addressedNow: input.entry.mentions.includes(input.agentAuthorId),
    },
    budget: {
      automaticRepliesLeftInThisRoomThisHour: input.budget.room,
      automaticRepliesLeftInTotalThisHour: input.budget.global,
      repliesLeftInThisChain: input.repliesLeftInThisChain,
    },
  };

  // `projection` is filled by `flatten`, which runs inside the object literal
  // above — so it is complete only here, and only for the entries that actually
  // reached the model.
  return { context, projection };
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
 * POSITION within it. There is no lookup to do: `room` already IS the channel,
 * and the position comes off the triggering entry's own pointer
 * (ADR 260728-022013).
 *
 * @param room - The room the turn was triggered in.
 * @param entry - The entry that triggered it; its thread pointer is the position.
 * @param framing - What the room's turn is told about the chat it projects, or
 *   `null` for an unbridged room.
 */
function resolveFrame(
  deps: RoomContextDeps,
  room: Room,
  entry: RoomEntry,
  framing: BridgedRoomFraming | null
): ContextFrame {
  return { room: frameOf(room, framing), thread: threadOf(deps, room, entry) };
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
 * Project a room onto the frame shape.
 *
 * @param room - The room the turn is happening in.
 * @param framing - What the room's turn is told about the chat it projects, or
 *   `null` for an unbridged room.
 */
function frameOf(room: Room, framing: BridgedRoomFraming | null): RoomContextData['room'] {
  return {
    id: room.id,
    kind: room.kind,
    name: roomName(room),
    ...(room.topic ? { topic: room.topic } : {}),
    bridged: framing !== null,
    ...(framing?.visibility ? { visibility: framing.visibility } : {}),
    ...(framing ? { formatting: framing.formatting } : {}),
  };
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
