/**
 * Room orchestration: create, join, post, read cursor, thread replies.
 *
 * The service owns the rules a room has that the tables cannot state — a reply
 * may not hang off another reply, a channel slug is unique while it is
 * live — and it publishes what happened to the two streams a room fans out on:
 * its own SSE stream for entries and signals, the global `/api/events` stream
 * for lifecycle. Membership lives next door in `room-roster.ts`, and turning a
 * committed post into agent replies lives in `room-trigger.ts`.
 *
 * **Roster writes are the owner's — as far as identity can tell.** Adding,
 * removing, or re-configuring a member is refused for anyone the server does
 * not resolve as this install's owner. That was a harmless asymmetry while
 * nothing read `responseMode`; now that a post triggers turns, an agent that
 * could widen another agent's addressing could drive replies nobody asked for,
 * from inside the room where it is hardest to notice.
 *
 * **Those three are the whole list. `updateRoom` is deliberately not on it** —
 * a room's title, topic and archived flag are writable by any member, so an
 * agent can rename or archive a room it belongs to. That is pre-existing and
 * survives DOR-598 unchanged, and it is not a gate anyone forgot: the naive fix
 * (`requireOperator` in `updateRoom`) breaks `createRoom`'s DM un-archive path,
 * where the caller re-opening its own archived direct message may legitimately
 * be that agent. Closing it properly means splitting the re-open out first.
 * Tracked as DOR-608; do not add the gate without that split.
 *
 * **The gates ask who the OWNER is, never whether the author is a human**
 * (DOR-598). Those were the same question only while this table held exactly one
 * human author. It will not: joining a community fills it with other humans —
 * cached remote members whose messages you hold (ADR 260727-184933 D6) — and
 * none of them operates this machine. Ownership is injected as `isOwnerAuthor`
 * rather than read here, because whether an account exists is not a room's
 * business to know.
 *
 * Read "not the owner" literally: it means a request the server resolved to
 * somebody else. In the DEFAULT posture (`auth.enabled` off) a request carrying
 * no `X-DorkOS-Agent` header resolves to the owner, so a program on this machine
 * clears every gate in this file by omitting a header. That is the documented
 * DOR-505 residual, not a hole this domain opened or can close — with login off
 * there is nothing left to tell a local program from the person at the keyboard.
 * Turning **Require login** on is what makes these gates mean what they say.
 *
 * What holds regardless is `turn-budget.ts`, which counts without asking who is
 * calling: a per-room cap on what any ONE room may spend, and a global cap on
 * what the whole install may. The per-room one bounds a room, not a bill —
 * rooms are free to create, so it alone can be multiplied by making more of
 * them; the global one is the ceiling. These gates shape a healthy room; those
 * caps are what bound a dishonest one.
 *
 * **A thread is no longer one of those levers** (ADR 260728-022013). While a
 * thread was a child room it came with a fresh budget window and a fresh cascade
 * namespace, which is why opening one used to answer to the seeding gate; now a
 * thread reply is an entry in its channel, so it spends the channel's budget and
 * lands in the channel's ancestry set. Threads got cheaper to make and stopped
 * buying anything.
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
  RoomPresencePayload,
  RoomRosterEntry,
  RoomSummary,
  RoomWithRoster,
  UpdateRoomRequest,
} from '@dorkos/shared/room-schemas';
import { eventFanOut } from '../core/event-fan-out.js';
import type { AuthorRecord, AuthorRegistry } from './author-registry.js';
import { deriveCascade } from './cascade-guard.js';
import type { EngagedWindow } from './engagement.js';
import { resolveMentions } from './mentions.js';
import { RoomError, type RoomAgentLookup } from './room-errors.js';
import { RoomRoster, type AddMemberInput } from './room-roster.js';
import type { NewRoom } from './room-rows.js';
import type { RoomStore } from './room-store.js';
import type { RoomBroadcaster } from './room-stream.js';
import { RoomTriggerDispatcher, type RoomTurnRunner } from './room-trigger.js';
import type { RoomTurnBudget } from './turn-budget.js';

/** Everything {@link RoomService} is constructed from. */
export interface RoomServiceDeps {
  store: RoomStore;
  authors: AuthorRegistry;
  broadcaster: RoomBroadcaster;
  agents: RoomAgentLookup;
  /** How a triggered agent actually takes its turn. */
  turns: RoomTurnRunner;
  /** The per-room ceiling on automatic turns, counted whoever is calling. */
  budget: RoomTurnBudget;
  /** The live `rooms.maxAgentDepth`. Injected so the domain reads no config. */
  maxAgentDepth(): number;
  /** The live `rooms.engagedWindow*` ceilings, injected for the same reason. */
  engagedWindow(): EngagedWindow;
  /**
   * Whether this author is the person who owns the install.
   *
   * Injected in the same style as {@link RoomServiceDeps.maxAgentDepth}, so this
   * domain still reads no config and no auth module: who the owner is depends on
   * whether an account exists, which is not a room's business to know.
   */
  isOwnerAuthor(authorId: string): boolean;
}

/** Provenance a post carries when a trigger produced it. */
export interface PostTrigger {
  root: string;
  depth: number;
}

/**
 * A room, plus whether opening it is what brought it into existence.
 *
 * The flag exists so `POST /api/rooms` can answer 201 for a room it created and
 * 200 for a direct message that already held those members. That distinction is
 * not inferable from the body — a conversation forty messages deep and one
 * opened a moment ago serialize identically — and a caller that is not the
 * cockpit (a CLI, an MCP client) has to be able to tell them apart.
 *
 * Deliberately an intersection rather than a wrapper object: it is structurally
 * a `RoomWithRoster` everywhere one is expected, so nothing that only wants the
 * room has to reach through a field to get it. The route strips it before
 * serializing, so the wire body stays exactly `RoomWithRosterSchema`.
 */
export type OpenedRoom = RoomWithRoster & {
  /** `false` when an existing direct message was returned instead of a new room. */
  created: boolean;
};

/** Orchestration over the store, the roster, the author registry and the streams. */
export class RoomService {
  private readonly store: RoomStore;
  private readonly authors: AuthorRegistry;
  private readonly broadcaster: RoomBroadcaster;
  private readonly roster: RoomRoster;
  private readonly triggers: RoomTriggerDispatcher;
  /** The live `rooms.maxAgentDepth`. Read per write, so a change takes effect. */
  private readonly maxAgentDepth: () => number;
  /** Whether an author is the install's owner. Read per check, never captured. */
  private readonly isOwnerAuthor: (authorId: string) => boolean;

  constructor(deps: RoomServiceDeps) {
    this.store = deps.store;
    this.authors = deps.authors;
    this.broadcaster = deps.broadcaster;
    this.maxAgentDepth = deps.maxAgentDepth;
    this.isOwnerAuthor = deps.isOwnerAuthor;
    this.roster = new RoomRoster({
      store: deps.store,
      authors: deps.authors,
      agents: deps.agents,
    });
    // The dispatcher writes back through this service (a reply is a post like
    // any other, mentions and provenance included), so it takes bound methods
    // rather than the store. They are only ever called after construction.
    this.triggers = new RoomTriggerDispatcher({
      store: deps.store,
      authors: deps.authors,
      agents: deps.agents,
      runner: deps.turns,
      budget: deps.budget,
      maxAgentDepth: deps.maxAgentDepth,
      engagedWindow: deps.engagedWindow,
      writer: {
        post: (roomId, input) => this.post(roomId, input),
        postNotice: (roomId, body, cascade, replyTo) =>
          this.postNotice(roomId, body, cascade, replyTo),
      },
      // The room's ephemeral channel, handed over as a bound method for the same
      // reason the writer is: the dispatcher publishes what its claim map knows
      // and stays ignorant of how a room fans out. `progress` is bound HERE, so
      // the one signal name presence may use is not a decision the dispatcher can
      // get wrong.
      publishPresence: (roomId, authorId, presence) =>
        this.publishSignal(roomId, 'progress', authorId, presence),
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

  /**
   * Resolve once every turn a post triggered has finished.
   *
   * A cascade is asynchronous by construction — posting returns before any
   * agent has answered — so this is how a caller waits it out without sleeping.
   */
  triggersIdle(): Promise<void> {
    return this.triggers.idle();
  }

  // === Rooms ===

  /**
   * Open a channel or a DM, seeding its roster with the creator and whoever the
   * request names — by author id (`members`) or by agent directory
   * (`agentPaths`).
   *
   * `agentPaths` is what makes a DM one call. The cockpit knows agents by
   * directory and nothing else; author ids are minted server-side and the only
   * surface that resolves one is `POST /:id/members`. So creating a DM used to
   * mean create-then-join, and a failed join left a direct message with nobody
   * in it — a room named after an agent that the agent was not in, which no
   * amount of retrying could repair because the room already existed.
   *
   * Resolve-then-create: every member is resolved before `RoomStore.createRoom`
   * is called at all, and that call writes the room and its whole roster in one
   * transaction. So an unregistered agent path fails while the room does not
   * exist, and the obvious retry works. (The resolution itself is not inside
   * that transaction — it does not need to be, and saying so would be drift.)
   *
   * **A DM is idempotent on its member set.** Ask for a direct message with
   * people you already have one with and you get that conversation back, not a
   * second one beside it. A DM is identified by WHO IS IN IT, so two rooms
   * holding the same authors are the same room told twice — the failure mode
   * Teams ships, where duplicate chats are real and you are told to rename them
   * apart. Slack behaves the way this does.
   *
   * It has to be decided here rather than in the picker for two reasons. It is
   * an idempotency property of the resource, so every caller gets it — the
   * cockpit, an MCP client, a shell. And a client could only evaluate it by
   * holding every DM's roster, which is exactly the per-room fetch R5 deleted.
   *
   * Three consequences worth stating, because none of them is obvious:
   *
   * - **An archived match is un-archived and returned.** Archive is this
   *   product's reversible "put it away" (spec §12.4 — there is no Leave), so
   *   re-opening a conversation is what asking for it again means. Minting a
   *   parallel room would strand the history in the archived one.
   * - **The existing room keeps its own title.** A request that matched is
   *   asking for a conversation, not renaming one; silently retitling a room
   *   somebody had named would be a side effect nobody asked for. Rename is its
   *   own verb (`PATCH /api/rooms/:id`).
   * - **The caller is told which one it got**, via {@link OpenedRoom.created},
   *   because nothing in the body says. This is an upsert on a natural key, not
   *   a replay of one caller's earlier answer against an idempotency key they
   *   supplied — the room this matches may have been opened by somebody else
   *   hours ago — so the honest report is PUT-shaped: 201 for a room that was
   *   created, 200 for one that was already there.
   * - **`lastActivityAt` is left alone**, on the matched path and the
   *   un-archived one alike. Opening a conversation is not activity in it, and
   *   bumping it would push a silent room to the top of a sidebar sorted by
   *   recency and tell the reader something happened. A re-opened DM comes back
   *   where it was.
   *
   * @param request - The validated create request.
   * @param creatorAuthorId - The author opening the room; joined automatically.
   * @returns The room with its roster and whether this call created it — new, or
   *   the one that already held these exact members.
   */
  createRoom(request: CreateRoomRequest, creatorAuthorId: string): OpenedRoom {
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

    const draft: NewRoom = {
      id: ulid(),
      kind: request.kind,
      slug,
      title: request.title ?? `#${slug ?? ''}`,
      topic: request.topic ?? null,
      workspaceId: request.workspaceId ?? null,
      createdAt: new Date().toISOString(),
    };

    // Resolve the whole roster BEFORE anything is written. An unknown author id
    // or an unregistered agent path has to fail while the room does not exist
    // yet — otherwise the caller gets a 404 for a room that is sitting in the
    // table holding its slug.
    const joinedAt = draft.createdAt;
    const seeded = { ...draft, archived: false, lastActivityAt: joinedAt };
    const creator = this.roster.requireAuthor(creatorAuthorId);
    const resolved = new Map<string, AuthorRecord>([[creator.id, creator]]);
    for (const authorId of request.members) {
      const author = this.roster.resolve({ authorId });
      resolved.set(author.id, author);
    }
    for (const agentPath of request.agentPaths) {
      const author = this.roster.resolve({ agentPath });
      resolved.set(author.id, author);
    }
    // Opening a room is not a way around the operator-only roster rule: an agent
    // may make itself a room (and talk to the person in it), but conscripting a
    // second agent into one is the same amplification lever `addMember` refuses.
    this.requireSeedingAllowed(creator, [...resolved.values()]);

    // Deliberately AFTER that gate, not before. A caller the gate refuses gets
    // the same 403 whether or not the room it named exists, so this stays a
    // create path that sometimes answers with an existing room and never a way
    // to probe for one.
    if (request.kind === 'dm') {
      const existing = this.store.findDmByMemberSet([...resolved.keys()]);
      if (existing) {
        // `updateRoom` re-checks visibility and broadcasts `room_updated`, which
        // is what a sidebar holding a stale list needs to hear. Its slug-reclaim
        // branch is channel-only, so it is inert here.
        const reopened = existing.archived
          ? this.updateRoom(existing.id, creatorAuthorId, { archived: false })
          : this.withRoster(existing, creatorAuthorId);
        return { ...reopened, created: false };
      }
    }

    const members = [...resolved.values()].map((author) => ({
      authorId: author.id,
      responseMode: this.roster.seedResponseMode(seeded, author),
      joinedAt,
    }));

    const room = this.store.createRoom(draft, members);

    eventFanOut.broadcast('room_created', { roomId: room.id, kind: room.kind, title: room.title });
    return { ...this.withRoster(room, creatorAuthorId), created: true };
  }

  /**
   * The rooms this viewer may list, each with their unread count.
   *
   * Two different answers, on purpose:
   *
   * - **The owner sees every room.** This is their machine; hiding rooms from
   *   the person running it would be absurd. "Membership-scoped" in
   *   ADR 260726-170125 describes the model, not an authorization rule against
   *   its owner. Owner-identity, not author kind: the same table will hold
   *   other humans once a community is joined (ADR 260727-184933 D6), and none
   *   of them is the operator of this machine.
   * - **Everybody else sees only rooms they belong to.** That boundary is real:
   *   an agent enumerating the operator's DMs with other agents is a leak, and
   *   it costs one join to prevent.
   *
   * `unreadCount` is `null` for a room the viewer is not a member of. Unread is
   * a property of a read cursor, and a non-member has none — reporting the
   * room's whole entry count instead would render every room the operator has
   * not joined as an alarming unread badge.
   *
   * `participants` is carried for direct messages and is `null` for everything
   * else, per {@link RoomSummary}. A DM's mark is whoever it is with, so the
   * sidebar cannot draw one without the roster; resolving it here is two
   * queries for the whole list, where asking per room was one request each.
   *
   * @param viewerAuthorId - Whose rooms to list, and whose unread counts to compute.
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
    const visible = this.seesEveryRoom(viewerAuthorId)
      ? this.store.listRooms(filter)
      : this.store.listRoomsForMember(viewerAuthorId, filter);
    // Only the DMs are asked about, so a room of any other kind is simply
    // absent from the map and reads as `null` below — "not carried" rather
    // than "empty", which is the distinction the schema promises.
    const participants = this.roster.authorsIn(
      visible.filter((room) => room.kind === 'dm').map((room) => room.id)
    );
    return visible.map((room) => {
      const cursor = cursors.get(room.id);
      return {
        ...room,
        unreadCount: cursor === undefined ? null : this.store.countUnread(room.id, cursor),
        participants: participants.get(room.id) ?? null,
      };
    });
  }

  /**
   * One room with its roster, as this viewer may see it.
   *
   * @param roomId - The room id.
   * @param viewerAuthorId - The caller. The owner sees any room; everybody else
   *   only the ones they belong to.
   * @returns The room, or `null` when it does not exist or the viewer may not see it.
   */
  getRoom(roomId: string, viewerAuthorId: string): RoomWithRoster | null {
    const room = this.store.getRoom(roomId);
    if (!room || !this.canSee(roomId, viewerAuthorId)) return null;
    return this.withRoster(room, viewerAuthorId);
  }

  /**
   * Patch a room's title, topic, or archived flag.
   *
   * **Renaming a channel moves its `#slug` with the title.** A channel's name
   * IS its slug — it is what the sidebar draws, what a person types, and the
   * only room name the server enforces as unique (§13.1) — so a rename that
   * changed only `title` would land in the database and change nothing anybody
   * could see. The new slug is derived by the same {@link slugify} creation
   * uses, though not by the same route: creating a channel may name its slug
   * outright, and renaming one never can.
   *
   * **A rename is applied before an un-archive is judged**, so a room can come
   * back under a new name. That ordering is the difference between a channel
   * whose old name was taken while it was away being recoverable and being
   * stranded for good, because a slug is only reserved while its channel is
   * live and nothing else in the product un-archives a room.
   *
   * @param roomId - The room id.
   * @param viewerAuthorId - The caller; must be on the roster.
   * @param patch - The validated update request.
   * @returns The updated room with its roster.
   */
  updateRoom(roomId: string, viewerAuthorId: string, patch: UpdateRoomRequest): RoomWithRoster {
    const room = this.requireVisibleRoom(roomId, viewerAuthorId);
    // Resolved FIRST, because the slug this room is about to have is the one an
    // un-archive has to be judged against — not the one it is leaving behind.
    const slugPatch = this.renamedSlug(room, patch.title);
    const nextSlug = slugPatch.slug ?? room.slug;
    // Un-archiving reclaims a slug the partial unique index released when the
    // room was archived. Somebody may have taken it since — refuse the same way
    // creating it would, rather than letting the raw UNIQUE violation surface
    // as a 500 the caller cannot act on. Renaming in the same patch is the way
    // out: `{ archived: false, title: 'Backend two' }` reclaims a free slug.
    if (patch.archived === false && room.archived && room.kind === 'channel' && nextSlug) {
      const holder = this.store.findLiveChannelBySlug(nextSlug);
      if (holder && holder.id !== room.id) {
        throw new RoomError('SLUG_TAKEN', `A channel called #${nextSlug} already exists`);
      }
    }
    const updated = this.store.updateRoom(roomId, { ...patch, ...slugPatch });
    if (!updated) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    eventFanOut.broadcast('room_updated', {
      roomId: updated.id,
      title: updated.title,
      archived: updated.archived,
    });
    return this.withRoster(updated, viewerAuthorId);
  }

  // === Membership ===

  /**
   * Add a member by author id, or by agent directory when the agent has never
   * been an author before. **Operator-only.**
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be the install's owner.
   * @param input - Who to add, and optionally how they should behave.
   */
  addMember(roomId: string, viewerAuthorId: string, input: AddMemberInput): RoomRosterEntry {
    const room = this.requireVisibleRoom(roomId, viewerAuthorId);
    this.requireOperator(viewerAuthorId, 'who is in a room');
    const member = this.roster.add(room, input);
    eventFanOut.broadcast('room_member_added', { roomId, authorId: member.authorId });
    return member;
  }

  /**
   * Change one membership's per-room response mode. **Operator-only** — this is
   * the setting that decides when an agent answers without being addressed, so
   * an agent able to turn it up on a room-mate could manufacture a conversation.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be the install's owner.
   * @param authorId - The member being changed.
   * @param responseMode - The new override.
   */
  updateMembership(
    roomId: string,
    viewerAuthorId: string,
    authorId: string,
    responseMode: ResponseMode
  ): RoomRosterEntry {
    this.requireVisibleRoom(roomId, viewerAuthorId);
    this.requireOperator(viewerAuthorId, 'how an agent answers in a room');
    return this.roster.setResponseMode(roomId, authorId, responseMode);
  }

  /**
   * Remove a member, dropping its per-room session binding with it.
   * **Operator-only.**
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be the install's owner.
   * @param authorId - The member being removed.
   */
  removeMember(roomId: string, viewerAuthorId: string, authorId: string): void {
    this.requireVisibleRoom(roomId, viewerAuthorId);
    this.requireOperator(viewerAuthorId, 'who is in a room');
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
    this.requireVisibleRoom(roomId, authorId);
    return this.roster.setReadCursor(roomId, authorId, lastReadSeq);
  }

  // === Entries ===

  /**
   * A page of history, oldest-first.
   *
   * @param roomId - The room.
   * @param viewerAuthorId - The caller; must be on the roster.
   * @param opts.before - Return entries with `seq` below this.
   * @param opts.limit - Page size.
   */
  listEntries(
    roomId: string,
    viewerAuthorId: string,
    opts: { before?: number; limit: number }
  ): RoomEntry[] {
    this.requireVisibleRoom(roomId, viewerAuthorId);
    return this.store.listEntries(roomId, opts);
  }

  /**
   * Write a post: resolve its mentions against the roster, allocate its `seq`,
   * stamp its cascade provenance, and publish it to the room's readers.
   *
   * A post with no trigger starts a fresh cascade at depth 0 — which is what
   * makes a human able to re-engage a room the guard has stopped.
   *
   * **`replyTo` is what makes this a thread reply**, and it is the only way to
   * write one (ADR 260728-022013). It names an entry in THIS room; the reply
   * lands in the same log, under the same roster, spending the same budget, and
   * — the point of the change — inside the same `(room_id, cascade_root)`
   * ancestry set, so a cascade that goes through a thread is bounded by the same
   * rule as one that does not.
   *
   * @param roomId - The room.
   * @param input.authorId - Who is posting.
   * @param input.text - What they wrote.
   * @param input.sessionId - The session that produced it, if any.
   * @param input.trigger - Cascade provenance, when a trigger produced this.
   * @param input.replyTo - The entry this answers, when it is a thread reply.
   * @returns The committed entry.
   */
  post(
    roomId: string,
    input: {
      authorId: string;
      text: string;
      sessionId?: string;
      trigger?: PostTrigger;
      replyTo?: string;
    }
  ): RoomEntry {
    const room = this.requireVisibleRoom(roomId, input.authorId);
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    // Seeing a room is not being in it. The owner can see every room but still
    // has to join one before speaking in it; for everybody else the visibility
    // check above already required membership, so this is a no-op.
    if (!this.store.getMember(roomId, input.authorId)) {
      throw new RoomError('MEMBER_NOT_FOUND', 'Not a member of this room');
    }

    // Provenance follows the TURN, not the call — and where there is no turn,
    // who is writing decides, never the shape of the call. An agent can post
    // here directly (`POST /api/rooms/:id/entries` carries no trigger), both
    // while its turn runs and from a shell with nothing in flight at all;
    // `deriveCascade` refuses a fresh cascade to either. Only a human resets the
    // count, which is what spec §6 says and what the setting's own docs promise.
    const author = this.authors.getById(input.authorId);
    const trigger = input.trigger ?? this.triggers.activeTurnFor(input.authorId);

    const id = ulid();
    const entry = this.store.appendEntry({
      roomId,
      id,
      authorId: input.authorId,
      kind: 'post',
      body: { text: input.text },
      mentions: resolveMentions(input.text, this.roster.mentionCandidates(roomId)),
      sessionId: input.sessionId ?? null,
      ...this.threadPointers(roomId, input.replyTo),
      ...deriveCascade(id, {
        trigger,
        // An author row that has vanished is treated as an agent — the
        // conservative read, since the only thing this decides is whether the
        // writer may reset a spend limit.
        authorKind: author?.kind ?? 'agent',
        maxAgentDepth: this.maxAgentDepth(),
      }),
      createdAt: new Date().toISOString(),
    });

    this.publishEntry(entry);
    // Trigger-only, both ways: the post reaches its readers now, and whoever it
    // addresses answers on their own schedule. Deliberately not awaited — the
    // HTTP 202 must not wait on a model call, and the reply arrives on the same
    // SSE stream as everything else when it comes.
    this.triggers.dispatch(room, entry);
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
   * @param replyTo - The entry it belongs under, when the turn it is about
   *   happened inside a thread. A refusal reported at the channel's top level
   *   while the exchange it refused is three replies deep in a thread is a
   *   notice the reader cannot connect to anything (`I3` — a refusal is visible).
   * @returns The committed entry.
   */
  postNotice(
    roomId: string,
    body: RoomEntryBody,
    cascade?: { root: string; depth: number },
    replyTo?: string
  ): RoomEntry {
    const room = this.requireRoom(roomId);
    // Archived means archived for the room's own voice too. `post` has always
    // refused here; a notice that slipped past would let an archived room keep
    // gaining entries, which is the one thing archiving promises it will not do.
    if (room.archived) throw new RoomError('ROOM_ARCHIVED', 'This room is archived');
    const id = ulid();
    const entry = this.store.appendEntry({
      roomId,
      id,
      authorId: this.authors.system().id,
      kind: 'notice',
      body,
      mentions: [],
      sessionId: null,
      ...this.threadPointers(roomId, replyTo),
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
   * @param viewerAuthorId - The caller; must be on the roster.
   * @param historyLimit - How many trailing entries to hydrate with.
   */
  snapshot(
    roomId: string,
    viewerAuthorId: string,
    historyLimit: number
  ): { room: RoomWithRoster; entries: RoomEntry[]; cursor: number } {
    const room = this.requireVisibleRoom(roomId, viewerAuthorId);
    const entries = this.store.listEntries(roomId, { limit: historyLimit });
    return {
      room: this.withRoster(room, viewerAuthorId),
      entries,
      cursor: entries.length > 0 ? entries[entries.length - 1].seq : 0,
    };
  }

  /**
   * The highest `seq` this room has issued, or 0 when it is empty. The SSE
   * handler bounds a resume cursor against it.
   *
   * @param roomId - The room.
   */
  maxSeq(roomId: string): number {
    return this.store.maxSeq(roomId);
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
   * @param presence - The working lifecycle, on a `'progress'` signal. Every
   *   publish carries the whole of it, `since` included: an ephemeral event is
   *   never replayed, so it has to be renderable by a client that connected in
   *   the middle of the work.
   */
  publishSignal(
    roomId: string,
    signal: SignalType,
    authorId: string,
    presence?: RoomPresencePayload
  ): void {
    this.broadcaster.publish(roomId, {
      type: 'signal',
      signal,
      authorId,
      at: new Date().toISOString(),
      ...presence,
    });
  }

  // === Internals ===

  /**
   * Resolve the two thread pointers an entry is written with.
   *
   * **This is where the one-level rule lives, and it is the whole of it**
   * (ADR 260728-022013). The schema permits `parent_entry_id` to name a reply;
   * the service refuses to write one, on the same reasoning 260726-170125 gave
   * and every surveyed product shares. So the depth ceiling is a policy a later
   * ADR can revisit by changing the `if` below — not a shape a migration would
   * have to undo. Opening a second level means deriving
   * `threadRootEntryId = parent.threadRootEntryId ?? parent.id` here instead of
   * throwing; nothing else in the schema has an opinion.
   *
   * Refusing beats flattening: a reader who thought they had branched twice and
   * got one branch has been lied to.
   *
   * @param roomId - The room the entry is being written into.
   * @param replyTo - The entry it answers, or undefined for a top-level entry.
   * @returns The `parentEntryId` / `threadRootEntryId` pair to persist.
   */
  private threadPointers(
    roomId: string,
    replyTo: string | undefined
  ): { parentEntryId: string | null; threadRootEntryId: string | null } {
    if (replyTo === undefined) return { parentEntryId: null, threadRootEntryId: null };
    // Scoped to this room, so an entry id from a room the caller can see cannot
    // pull a reply into a conversation it does not belong to.
    const root = this.store.getEntryById(roomId, replyTo);
    if (!root) throw new RoomError('ENTRY_NOT_FOUND', 'No such entry in this room');
    if (root.threadRootEntryId !== null) {
      throw new RoomError('NESTED_THREAD', 'A thread reply cannot hang off another reply');
    }
    return { parentEntryId: root.id, threadRootEntryId: root.id };
  }

  /**
   * Fetch a room or throw the typed not-found the routes map to a 404.
   *
   * Unscoped — for server-internal writes only (`postNotice`, whose author is
   * the system and is deliberately on no roster). Every request-driven path
   * uses {@link RoomService.requireVisibleRoom} instead.
   */
  private requireRoom(roomId: string): Room {
    const room = this.store.getRoom(roomId);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    return room;
  }

  /**
   * Fetch a room the caller is entitled to see, or throw.
   *
   * The single visibility rule for every request-driven path. It reports the
   * same `ROOM_NOT_FOUND` for "no such room" and "not visible to you" on
   * purpose: distinguishing them would let an agent holding a room id — and the
   * identity header is attribution, not authorization
   * (`middleware/agent-identity.ts`) — confirm that the operator's DM with
   * another agent exists by probing for a different error code.
   *
   * @param roomId - The room id.
   * @param viewerAuthorId - The caller's author id.
   */
  private requireVisibleRoom(roomId: string, viewerAuthorId: string): Room {
    const room = this.store.getRoom(roomId);
    if (!room || !this.canSee(roomId, viewerAuthorId)) {
      throw new RoomError('ROOM_NOT_FOUND', 'No such room');
    }
    return room;
  }

  /**
   * Whether this caller may see a room at all: the owner may see every room,
   * everybody else only the ones they belong to.
   */
  private canSee(roomId: string, viewerAuthorId: string): boolean {
    if (this.seesEveryRoom(viewerAuthorId)) return true;
    return this.store.getMember(roomId, viewerAuthorId) !== null;
  }

  /**
   * The owner sees every room; nothing on their own machine hides from them.
   *
   * This used to read `kind === 'human'`, which was only ever the same question
   * while an install minted exactly one human author. A second one — an invited
   * person — would have passed it and read every room on the install, the
   * owner's DMs with agents included.
   */
  private seesEveryRoom(viewerAuthorId: string): boolean {
    return this.isOwnerAuthor(viewerAuthorId);
  }

  /**
   * Refuse a roster write from anyone but the person who owns the install.
   *
   * Deliberately a 403 and not a 404: the caller is already a member of a room
   * it can see, so there is nothing left to hide, and telling an agent "you may
   * not" is more useful than telling it a room it just read no longer exists.
   *
   * Same correction as {@link RoomService.seesEveryRoom}: on `kind === 'human'`
   * a second person could have rewritten any roster in any room.
   *
   * @param viewerAuthorId - The caller.
   * @param what - What they tried to change, for the message.
   */
  private requireOperator(viewerAuthorId: string, what: string): void {
    if (this.isOwnerAuthor(viewerAuthorId)) return;
    throw new RoomError('OPERATOR_ONLY', `Only you can change ${what}`);
  }

  /**
   * Refuse a non-owner's attempt to seed a room with an agent that is not
   * itself.
   *
   * A caller opening a room for itself — a DM with the owner, a scratch channel
   * — is legitimate and stays allowed. Putting somebody else's agent in one is
   * not: it is `addMember` by a different route, and it would let the caller
   * assemble a room whose members then answer each other.
   *
   * This reads owner-identity rather than `kind === 'human'` for the same reason
   * {@link RoomService.requireOperator} does, and it is not a formality: `/api/rooms`
   * is reachable by a member (her own rooms live behind it), so on the old test
   * an invited person could have assembled exactly the amplification room this
   * refuses an agent — spending the owner's model quota, with the server
   * process's filesystem access, in a room she made herself.
   *
   * @param creator - The author opening the room.
   * @param seeded - Every author the new roster will hold.
   */
  private requireSeedingAllowed(creator: AuthorRecord, seeded: readonly AuthorRecord[]): void {
    if (this.isOwnerAuthor(creator.id)) return;
    const conscripted = seeded.find(
      (author) => author.id !== creator.id && author.kind === 'agent'
    );
    if (conscripted) {
      throw new RoomError('OPERATOR_ONLY', 'Only you can put another agent in a room');
    }
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

  /**
   * Attach the resolved roster to a room, and say which of its members the
   * reader is.
   *
   * `viewerAuthorId` is the id this call was already scoped by, so it is the
   * authoritative answer to "which one am I" rather than something a client can
   * infer. It is not necessarily ON the roster: the owner sees rooms they have
   * not joined, and a reader who is not a member has no membership to find.
   *
   * @param room - The room.
   * @param viewerAuthorId - The caller this room was resolved for.
   */
  private withRoster(room: Room, viewerAuthorId: string): RoomWithRoster {
    return { ...room, members: this.roster.list(room.id), viewerAuthorId };
  }

  /**
   * The `slug` half of a channel rename, as a patch fragment to spread.
   *
   * Empty for anything that is not a channel getting a new title — only a
   * channel has a name people type, so only a channel has a slug to move. That
   * guard is load-bearing: without it a direct message would be given one.
   *
   * Refuses a title with nothing sluggable in it, and one that slugs onto a name
   * another LIVE channel holds. An archived channel's slug is not reserved, so
   * it never blocks a rename; {@link updateRoom} is where that matters, because
   * it judges an un-archive against the slug the room is about to have.
   *
   * @param room - The room being patched.
   * @param title - The requested title, when the patch carries one.
   * @returns `{ slug }` when the slug moves, otherwise `{}`.
   */
  private renamedSlug(room: Room, title: string | undefined): { slug?: string } {
    if (title === undefined || room.kind !== 'channel') return {};
    const slug = slugify(title);
    if (!slug) {
      throw new RoomError(
        'INVALID_SLUG',
        'A channel name needs at least one letter or number in it'
      );
    }
    // A cosmetic rename — `#Backend` to `Backend ` — slugs to what the channel
    // is already called. Returning early skips a lookup and a no-op write; the
    // `holder.id !== room.id` test below would reach the same verdict, so this
    // is an optimisation and not the guard against self-conflict.
    if (slug === room.slug) return {};
    const holder = this.store.findLiveChannelBySlug(slug);
    if (holder && holder.id !== room.id) {
      throw new RoomError('SLUG_TAKEN', `A channel called #${slug} already exists`);
    }
    return { slug };
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
