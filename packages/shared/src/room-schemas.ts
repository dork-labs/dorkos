/**
 * Zod schemas for rooms — channels, DMs and threads (spec `rooms`, ADR
 * 260726-170125).
 *
 * A room is a membership-scoped durable stream: a roster of authors, an
 * append-only log of entries, and nothing else. It is deliberately NOT a
 * session — three agents in a room are three sessions posting onto one stream,
 * each keeping its own runtime binding (ADR-0255).
 *
 * Two reuses are load-bearing and must not be forked here:
 *
 * - `responseMode` is {@link ResponseModeSchema} from `mesh-schemas.ts`. The
 *   manifest value is an agent's default; a membership carries the per-room
 *   override. Same enum, second scope.
 * - Ephemeral signals are {@link SignalTypeSchema} from
 *   `relay-envelope-schemas.ts`. Typing and presence in a room are the same
 *   vocabulary they already are on the relay.
 *
 * @module shared/room-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { ResponseModeSchema } from './mesh-schemas.js';
import { SignalTypeSchema } from './relay-envelope-schemas.js';
import { SessionActivitySchema, type SessionActivity } from './session-stream.js';

extendZodWithOpenApi(z);

// === Enums ===

/**
 * The two shapes a room takes.
 *
 * There is no `thread` member and there is not going to be one: a thread is a
 * relation between entries in one room's log, carried by `RoomEntry.parentEntryId`
 * / `threadRootEntryId`, and a room list never contains one (ADR 260728-022013).
 */
export const RoomKindSchema = z.enum(['channel', 'dm']).openapi('RoomKind');

export type RoomKind = z.infer<typeof RoomKindSchema>;

/** What kind of thing an author is. `system` is the room's own voice. */
export const AuthorKindSchema = z.enum(['human', 'agent', 'system']).openapi('AuthorKind');

export type AuthorKind = z.infer<typeof AuthorKindSchema>;

/**
 * Where an author is: on this machine, or on a platform outside it
 * (chats-as-channels spec §4.3).
 *
 * **Derived from the stored author's natural key, never from whatever relay
 * subject happens to be in scope when a roster is rendered.** A key is written
 * once, at mint, and is the only honest source: render-time derivation would
 * make the origin of a two-year-old entry depend on which message is being
 * processed right now, and an entry whose provenance can change is not evidence.
 *
 * `'local'` for the operator, for agents and for the room's own system voice.
 * `{ platform }` — `'telegram'`, `'slack'` — for anybody whose key starts
 * `platform:`. The platform name is a LABEL: it renders outside the untrusted
 * fence, so every reader passes it through `sanitizeIdentity` like any other.
 *
 * The distinction is a security boundary, not decoration: it is the difference
 * between "a person on this machine wrote this" and "a stranger on the internet
 * wrote this" (spec §9).
 */
export const AuthorOriginSchema = z
  .union([
    z.literal('local').describe('This machine: the operator, an agent, or the room itself.'),
    z
      .object({ platform: z.string().min(1) })
      .describe('Outside this machine, on the named platform.'),
  ])
  .openapi('AuthorOrigin');

export type AuthorOrigin = z.infer<typeof AuthorOriginSchema>;

/**
 * A durable log entry is either something someone said (`post`) or something
 * the room reports about itself (`notice`).
 */
export const RoomEntryKindSchema = z.enum(['post', 'notice']).openapi('RoomEntryKind');

export type RoomEntryKind = z.infer<typeof RoomEntryKindSchema>;

/**
 * Why the room is speaking in its own voice. Kept to the cases that actually
 * write a `notice`; a new member-facing event earns a new code here rather than
 * a free-text convention.
 *
 * - `cascade_stopped` — the back-and-forth hit its automatic-reply depth.
 * - `budget_reached` — the room hit its cap on automatic turns for the window.
 *   Separate from the cascade guard on purpose: that one bounds ONE
 *   conversation, this one bounds the room whoever the caller claims to be.
 * - `agent_busy` — the agent's session was already being written to, so the
 *   trigger was skipped. Nothing is wrong with the agent; it was just occupied.
 * - `turn_failed` — the agent started answering and the turn ended in an error,
 *   or it never finished at all.
 * - `agent_gone` — the member's project folder no longer holds the agent it was
 *   added as: nothing is registered there, or a DIFFERENT agent is. No turn ran
 *   and none ever will until somebody re-registers it, which is why this is its
 *   own code rather than `turn_failed` — nothing failed, and there is no session
 *   to go and look at (ADR 260801-003051).
 * - `agent_unavailable` — the room could not bind a session for this agent before
 *   a turn ever started, almost always brief database contention on the
 *   `(room, agent)` session row. Its own code rather than `turn_failed` because
 *   no turn ran and there is no session to point a reader at yet — the same
 *   reasoning that gives `agent_gone` its own code, and the same shape: damped
 *   per `(room, agent, reason)` rather than treated as one more distinct error
 *   (DOR-1206).
 * - `awaiting_approval` — the agent's turn STARTED and then stopped, waiting for
 *   a person: a tool approval, a question it asked, or an MCP prompt. All three
 *   park the turn until somebody answers in that agent's own session, and the
 *   one code covers all three because what a reader has to do about them is
 *   identical. Without it a room shows nothing at all while an agent waits, and
 *   the prompt auto-denies ten minutes later — the 2026-07-31 incident, where
 *   agents were silent for up to forty-one minutes with nothing written
 *   anywhere (DOR-784).
 * - `halted` — somebody stopped work here. A control action, never inferred from
 *   anything anybody typed (room-participation spec §10.4). It comes in two
 *   scopes and `subjectAuthorId` is the tell: **absent** means the whole room was
 *   stopped, **present** names the one agent that was
 *   (`specs/room-per-agent-stop`). Both are written by the same log, damped on
 *   different keys.
 * - `addressing_changed` — DorkOS itself changed when the agents in this room
 *   answer. The only code not written by `rooms/notices/notice-copy.ts`: migration 0039 wrote
 *   it once, into every channel whose members it moved from `mention-only` to
 *   `engaged` (room-participation spec §9.4). A widening nobody asked for has to
 *   say so, because absence is never consent.
 * - `bridge_blocked` — a bridge delivery was refused by the reply/initiate
 *   consent switch, or by a provenance misclassification after a restart
 *   (chats-as-channels spec §6.6). Names the switch and where it lives.
 * - `bridge_undelivered` — a bridge delivery exhausted its retry budget; the
 *   entry is intact in the room log and eligible for the catch-up scan when
 *   the adapter reconnects (spec §6.1, §10.1).
 * - `bridge_rate_limited` — `ingest` refused an inbound message past the
 *   per-chat rate ceiling; nothing was written for it (spec §5.2 step 2).
 * - `bridge_second_agent_refused` — `RoomService.addMember` refused a second
 *   agent on a bridged room (spec §3.4, D-6 Q3): outbound consent is per
 *   binding, so a second agent's replies would have no gate that names them.
 * - `bridge_history_note` — posted once when a chat is bridged, saying where the
 *   conversation's earlier history lives (chats-as-channels spec §7.3). The
 *   pointer variant is written when an existing session is adopted (its own
 *   transcript holds the earlier messages); the pointer-less variant when the
 *   bridge starts fresh. Either way the room log does NOT gain the old messages,
 *   and the notice says so — the platform gives bots no history to import.
 *
 * **This four-code addition is the one non-additive change in the whole
 * chats-as-channels feature (spec §11.2, A11.1).** Widening an enum is not
 * additive for a client that already parses this schema: a build pinned to the
 * eight codes above fails to parse ANY room that contains one of the four new
 * ones, the moment a bridge writes its first notice — not just a room it
 * bridges itself. That is acceptable only because the client and server ship
 * from this same repo in lockstep; it must be called out explicitly in the
 * OpenAPI diff review and in the feature's changelog fragment rather than
 * passed over as "just four more enum values."
 */
export const RoomNoticeCodeSchema = z
  .enum([
    'cascade_stopped',
    'budget_reached',
    'agent_busy',
    'turn_failed',
    'agent_gone',
    'agent_unavailable',
    'awaiting_approval',
    'halted',
    'addressing_changed',
    'bridge_blocked',
    'bridge_undelivered',
    'bridge_rate_limited',
    'bridge_second_agent_refused',
    'bridge_disconnected',
    'bridge_agent_swapped',
    'bridge_history_note',
  ])
  .openapi('RoomNoticeCode');

export type RoomNoticeCode = z.infer<typeof RoomNoticeCodeSchema>;

// === Authors ===

/**
 * A stable, opaque handle for one agent, derived from its `agentPath`.
 *
 * It exists so a reader can ask "which agent is this author?" without the
 * server putting a home-directory path in front of every member of a room
 * (ADR 260726-170126). Comparing rendered names was the only alternative, and a
 * display name is a label: two agents can share one, and renaming an agent
 * silently changes the answer.
 *
 * Deliberately a plain FNV-1a fold rather than a hash from `node:crypto`: this
 * has to be computable synchronously on BOTH sides — the browser's only digest
 * API is async, which cannot be used from a render pass. It is an identity
 * token, not a security boundary; the privacy property it buys is simply that
 * no path is on the wire.
 *
 * @param agentPath - Absolute path to the agent's project directory.
 * @returns A 16-character lowercase hex handle, stable for that path forever.
 */
export function agentAuthorRef(agentPath: string): string {
  // Two independent FNV-1a-32 folds (different offset bases) concatenated, so
  // the handle is 64 bits wide rather than 32 — collisions across the handful
  // of agents on one machine are then not worth reasoning about.
  const fold = (offset: number): string => {
    let hash = offset >>> 0;
    for (let i = 0; i < agentPath.length; i++) {
      // UTF-16 code units, not UTF-8 bytes — this is not claiming to be the
      // canonical FNV-1a of the string, only to be the same function on both
      // sides. Its output is pinned byte-for-byte by a test.
      hash ^= agentPath.charCodeAt(i);
      // FNV prime 16777619, via shifts so the product stays inside 32 bits.
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  return `${fold(0x811c9dc5)}${fold(0x01000193)}`;
}

/**
 * How an author appears to a reader: the opaque persisted id, enough to render
 * it, and — for an agent — a stable handle to recognise it by. The `naturalKey`
 * behind the id (an agent's `agentPath`) never leaves the server: a room is a
 * shared surface, and a home-directory path is not something to put on the wire
 * (ADR 260726-170126).
 *
 * `displayName`, `emoji`, `color` and `imageUrl` are all the same thing — a
 * render cache, refreshed by a resolve whose caller actually knows the field.
 * For the three avatar fields that means "the caller passed one"; for
 * `displayName` it also means the name is not an agent's slug where its manifest
 * says otherwise, so an identity token minted under a slug cannot rename a live
 * agent (DOR-1264). None of them is ever the key, and nothing may look an author
 * up by one.
 *
 * **`handle` is the exception, and it is the only one.** It IS a key: unique
 * across this install by index, written once at mint, and the single string that
 * addresses this author. It replaced `mentionHandle`, which was the same idea
 * computed per roster because a display name a member quietly answered to could
 * belong to somebody else. Under a unique handle, ownership is not
 * roster-relative any more — the author who has it is the author it reaches,
 * everywhere, with no map (spec `handles` S5).
 */
export const AuthorRefSchema = z
  .object({
    id: z.string().min(1).describe('Opaque author id (ULID). Stable across agent re-registration.'),
    kind: AuthorKindSchema,
    displayName: z.string().min(1),
    emoji: z
      .string()
      .optional()
      .describe('Render cache: the emoji avatar, when the author has one.'),
    color: z
      .string()
      .optional()
      .describe('Render cache: the identity colour, when the author has one.'),
    imageUrl: z
      .string()
      .optional()
      .describe(
        "Render cache: the author's photo, when they have one. The fourth field beside `displayName`, `emoji` and `color`, on exactly their lifecycle — refreshed by a resolve whose caller knows it, never a key. Additive: an author with a photo AND an emoji keeps both, and the renderer picks. Source-agnostic: the value is whatever URL the avatar store returned, so it may be server-relative today and absolute tomorrow."
      ),
    agentRef: z
      .string()
      .optional()
      .describe(
        'Agents only: the stable handle from `agentAuthorRef(agentPath)`. Compare this, never a display name.'
      ),
    handle: z
      .string()
      .nullable()
      .describe(
        "This author's address: what to type after an `@` to reach them. Globally unique on this install (case-folded), lowercase, 2–32 characters of `[a-z0-9._-]`, starting and ending alphanumeric. A mention picker inserts it verbatim, so the string written is the string the server resolves. `null` means this author cannot be addressed by `@` at all — a person who has not chosen one yet, or an agent whose name spells nothing legal. Never fall back to the display name: that is not an address, it is unrestricted text, and it routinely contains spaces the mention pattern cannot span."
      ),
  })
  .openapi('AuthorRef');

export type AuthorRef = z.infer<typeof AuthorRefSchema>;

// === Rooms ===

/** Characters a channel slug may use — lowercase, digits, hyphens. */
export const ROOM_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * What a bridged room's header and room sheet need about its bridge
 * (chats-as-channels spec §8's badge, §3.4's title subtitle). `null` on an
 * unbridged room.
 *
 * **`visibility` is sourced from the bridge row, which is sourced from
 * Telegram's own `getMe` — never from config, and never inferred from
 * observed traffic.** `null` for a bridged DM (privacy mode is a group-only
 * switch) or before the first check completes; `'partial'` or `'full'`
 * otherwise. This is the exact value `room_context` carries into a turn
 * (`resolveBridgeFraming`, the one function that computes it) — the header
 * badge and the model's own view of the room can never silently disagree,
 * because there is only the one source.
 */
export const RoomBridgeInfoSchema = z
  .object({
    visibility: z
      .enum(['partial', 'full'])
      .nullable()
      .describe(
        "Telegram's privacy-mode switch: 'partial' (mentions/commands/replies only) or 'full' (everything). `null` for a bridged DM, or a group whose first visibility check has not yet completed."
      ),
    platformTitle: z
      .string()
      .nullable()
      .describe(
        "The platform chat's title, sanitized, as recorded when this room was bridged (spec §3.4). A room's own `title` can be renamed afterward without this column moving with it, which is the whole reason to carry it: the room sheet shows this alongside the room's title so the two are never silently different things. `null` for a bridged DM."
      ),
  })
  .openapi('RoomBridgeInfo');

export type RoomBridgeInfo = z.infer<typeof RoomBridgeInfoSchema>;

/**
 * The `wellKnown` key of #team — the one room every install is opened with and
 * the room the cockpit's home tab renders (team-room-home spec D3.1).
 *
 * It lives on the wire contract rather than in the server, because both ends
 * read it: the boot hook opens the room under this key, and the client finds it
 * again by the same key rather than by a slug a person may have renamed. One
 * spelling, one place.
 */
export const TEAM_ROOM_WELL_KNOWN = 'team';

export const RoomSchema = z
  .object({
    id: z.string().min(1),
    kind: RoomKindSchema,
    slug: z.string().nullable().describe('Channels only. Unique among non-archived channels.'),
    title: z.string().min(1),
    topic: z.string().nullable(),
    workspaceId: z
      .string()
      .nullable()
      .describe('Optional workspace reference. How it resolves a cwd is out of scope for v1.'),
    archived: z.boolean(),
    ambientMaxEntries: z
      .number()
      .int()
      .min(0)
      .describe(
        'How many entries of ambient history a turn in this room replays at most, oldest dropped first (room-participation spec §8.3). A bound on what one turn reads, never on the log — a room never forgets what was said, and a turn whose window was trimmed is told so.'
      ),
    wellKnown: z
      .string()
      .nullable()
      .optional()
      .describe(
        "The stable name a room DorkOS itself depends on is found by — `'team'` for the #team channel every install gets at boot — and `null` for every room a person or an agent opened (team-room-home spec D3.1). It is also the tell that this is a SYSTEM room: only the owner may rename or archive one, so a client draws those controls off this field rather than guessing. It never changes, which is what makes it findable after a rename. The server always sends it, `null` included; it is optional only so that the thirty client fixtures that assemble a room by hand need not each carry a field none of them reads. Absent and `null` mean the same thing — an ordinary room."
      ),
    fallbackSeatAuthorId: z
      .string()
      .nullable()
      .optional()
      .describe(
        'The one member that answers a message somebody typed in this room without addressing anybody — #team\'s default agent (team-room-home spec D3.4) — and `null` in every room a person opened. Held on the room rather than read off a member\'s `always` mode, because a person may set any agent to "Everything" themselves and that choice must not be mistaken for this one. Optional for the same reason `wellKnown` is: client fixtures that assemble a room by hand do not carry a field they never read, and absent means the same as `null`.'
      ),
    createdAt: z.string(),
    lastActivityAt: z.string(),
    bridge: RoomBridgeInfoSchema.nullable()
      .optional()
      .describe(
        "This room's bridge, when it has one. Optional as well as nullable: the sidebar's bulk room list does not resolve it today (a per-row bridge lookup a list never renders is cost nobody asked for), so absent and `null` both mean 'draw nothing bridge-related here' — only `GET /api/rooms/:id` and the room-create responses populate it for real."
      ),
  })
  .openapi('Room');

export type Room = z.infer<typeof RoomSchema>;

/**
 * A room as the sidebar reads it: the room, this viewer's unread count, and —
 * for a direct message — who it is with.
 *
 * `unreadCount` is `null` when the viewer is not a member. Unread is a property
 * of a read cursor and a non-member has none — so there is no number to give,
 * and the honest answer is "not applicable" rather than the room's whole entry
 * count dressed up as an unread badge.
 *
 * `participants` is `null` on the same principle: not carried, rather than
 * empty. See its own description for why only a DM carries one.
 */
export const RoomSummarySchema = RoomSchema.extend({
  unreadCount: z.number().int().min(0).nullable(),
  participants: z
    .array(AuthorRefSchema)
    .nullable()
    .describe(
      "Direct messages only: the DM's resolved roster. `null` — never `[]` — for a channel, meaning \"not carried here\". A DM's mark IS whoever it is with, so a sidebar that did not get the roster could only hash the room id and draw a stranger; a DM's roster is whoever one person assembled by hand, which is small enough to ride along on every list. A channel reads as `#slug`, so its roster would be payload nothing renders — and a channel's roster is the one with no ceiling on it."
    ),
  working: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "How many agents are working in this room right now — `0` when nobody is. The server always sends it; it is optional only so a caller that predates it still parses. It is a live read of the dispatcher's claim map at the moment of the request, not stored state, so it is the same fact the `room_presence` stream carries and exists purely so a freshly loaded sidebar draws its dots without waiting for the next republish tick."
    ),
  viewerHasPosted: z
    .boolean()
    .optional()
    .describe(
      'Whether the viewer has ever written in this room themselves. Derived from the log on every read, so it cannot drift; membership does not imply it and neither does reading. The server always sends it, and it is optional for the same reason `working` is — a caller that predates it still parses. **Absent means "this source cannot say", never `false`**: a client reads it to decide whether to nudge somebody to say hello, and a missing field read as "never posted" would nudge an operator who has been talking in #team for months.'
    ),
}).openapi('RoomSummary');

export type RoomSummary = z.infer<typeof RoomSummarySchema>;

// === Membership ===

/**
 * An author's binding to one room. This is where per-room state lives: the read
 * cursor is keyed `(member, room)`, never per client and never per session, and
 * `responseMode` is this room's override of the agent's manifest default.
 */
export const RoomMemberSchema = z
  .object({
    roomId: z.string().min(1),
    authorId: z.string().min(1),
    responseMode: ResponseModeSchema.describe(
      'Per-room override, written explicitly at join time. Seeded from the manifest for a DM and "engaged" for a channel. A thread is a position inside a channel rather than a room of its own, so a reply there reads the channel\'s value — but the engaged window itself is thread-scoped, so being addressed in a thread does not engage the agent across the whole channel.'
    ),
    joinedAt: z.string(),
    joinedSeq: z
      .number()
      .int()
      .min(0)
      .describe(
        "The room's highest seq when this membership was written — 0 for somebody who joined an empty room. The floor under everything the member may be shown: joining a channel does not retroactively read what was said before you were in it. Distinct from `lastReadSeq`, which starts at 0 for everybody and moves as they read."
      ),
    lastReadSeq: z
      .number()
      .int()
      .min(0)
      .describe(
        'Where this member has read up to in this room. For a PERSON it is their own read state, shared with every other device they read on; for an AGENT it is what the room has shown it, which its next ambient turn reads from. One number either way — match yourself on `RoomWithRoster.viewerAuthorId` and this is your place in the room.'
      ),
  })
  .openapi('RoomMember');

export type RoomMember = z.infer<typeof RoomMemberSchema>;

/** A membership with its author resolved, which is what a roster renders. */
export const RoomRosterEntrySchema = RoomMemberSchema.extend({
  author: AuthorRefSchema,
  origin: AuthorOriginSchema.describe(
    'Where this member is: on this machine, or on the platform a bridged chat projects from. Derived from the stored author key, so it is a property of who they are and not of how this response was produced.'
  ),
}).openapi('RoomRosterEntry');

export type RoomRosterEntry = z.infer<typeof RoomRosterEntrySchema>;

/**
 * One room with its roster — the `GET /api/rooms/:id` body.
 *
 * `viewerAuthorId` is the answer to "which of these members am I", and it has
 * to be on the wire because nothing else tells a client. A reader used to be
 * findable by `kind === 'human'`, which was only ever true while an install
 * minted exactly one human author; with two, `find` returns whichever sorts
 * first and one person reads and advances the other's cursor. The server
 * already resolves this id on every one of these routes and already scopes the
 * read by it, so carrying it costs nothing and makes it authoritative rather
 * than inferred.
 */
export const RoomWithRosterSchema = RoomSchema.extend({
  members: z.array(RoomRosterEntrySchema),
  viewerAuthorId: z
    .string()
    .min(1)
    .describe(
      'The author id the server resolved for THIS request — who the reader is. Match a roster member on it to find your own membership (your read cursor, your response mode); never match on `author.kind`. It is not necessarily on `members`: seeing a room and being in it are different things.'
    ),
  reactionFrequents: z
    .array(z.string())
    .describe(
      "THIS reader's most-used reaction emoji, most-used first, always exactly three — the quick row in the message capsule. Counted across every room, because a person's reaction habits are theirs and not a room's, and padded from the shipped defaults so a new install still gets a full row. It rides the room rather than a route of its own for the same reason `viewerAuthorId` does: the reader is already resolved here, the value is one aggregate query, and a capsule that had to fetch it separately would draw an empty row first."
    ),
  deliverNotices: z
    .boolean()
    .optional()
    .describe(
      "Present only on a bridged room: whether a turn_failed or halted notice reaches the bridged chat (chats-as-channels spec §6.2, D-6 Q5). The one per-bridge override, seeded true for a DM and false for a channel. Absent on any room with no bridge — the field IS the tell that this room projects to an external chat, so the cockpit's bridge controls read their state from it."
    ),
}).openapi('RoomWithRoster');

export type RoomWithRoster = z.infer<typeof RoomWithRosterSchema>;

// === Moments ===

/**
 * What a moment marks — the milestone the room is pointing at.
 *
 * Every one of these is something that either happened or did not: an agent was
 * created, a pull request shipped, a week's work added up to a number. There is
 * no code here for "encouragement" or "tip", and there must never be one — a
 * moment a person cannot trace back to a real record is the thing this whole
 * feature is designed not to be (team-room-home spec D5.1).
 *
 * `agent_minted` is the one an AGENT noticed rather than a detector. It is not
 * a looser bar: it carries the same source, it rides the same guarded post path
 * as any other agent post, and it additionally has to name the agent that
 * minted it.
 */
export const RoomMomentKindSchema = z
  .enum([
    'first_agent',
    'joined_team',
    'first_pr',
    'first_schedule',
    'first_overnight_run',
    'first_connection',
    'volume_mark',
    'anniversary',
    'agent_minted',
  ])
  .openapi('RoomMomentKind');

export type RoomMomentKind = z.infer<typeof RoomMomentKindSchema>;

/**
 * The kind of real record a moment was read from.
 *
 * Deliberately a closed list of the things this install actually keeps, so a
 * detector cannot invent a provenance: an agent's own record, a pull request,
 * a schedule, a session, a connection, or the activity log that already counts
 * what happened.
 */
export const RoomMomentSourceKindSchema = z
  .enum(['agent', 'pull_request', 'schedule', 'session', 'connection', 'activity'])
  .openapi('RoomMomentSourceKind');

export type RoomMomentSourceKind = z.infer<typeof RoomMomentSourceKindSchema>;

/**
 * What a moment was derived FROM — the record, and when it happened.
 *
 * Required, and required to name something: `ref` is the id or path of the one
 * record a reader could go and look at, and `observedAt` is when that record
 * says the thing occurred, never when the moment was written. A moment posted
 * an hour late is still about the hour it is about.
 */
export const RoomMomentSourceSchema = z
  .object({
    kind: RoomMomentSourceKindSchema,
    ref: z
      .string()
      .min(1)
      .describe(
        "The record's own identifier — an agent path, a session id, a pull request URL. Never a sentence, and never empty: a source that names nothing is not a source."
      ),
    observedAt: z
      .string()
      .min(1)
      .describe('When the thing actually happened, from the record. Not when this was posted.'),
  })
  .openapi('RoomMomentSource');

export type RoomMomentSource = z.infer<typeof RoomMomentSourceSchema>;

/**
 * A milestone worth marking, carried on the entry that says it.
 *
 * **A moment is a post, not a fourth kind of entry.** It rides
 * {@link RoomEntryBodySchema} beside the words a person reads, so every path
 * that already carries a post carries this one — the history page, the stream,
 * a bridge, a thread reply — and nothing had to learn a new entry kind. What
 * changes is how the feed DRAWS it (`MomentRow`).
 *
 * **`source` is what makes the type honest.** It is required, so the schema
 * itself refuses a moment nobody can trace; a detector with nothing to point at
 * has nothing to post.
 *
 * **`mintedByAgentRef` is required and nullable rather than optional**, so
 * every moment states who minted it and "nobody filled this in" can never be
 * read as "DorkOS did". `null` is DorkOS itself; an `agentAuthorRef` is the
 * agent that noticed, and an `agent_minted` moment must carry one.
 */
export const RoomMomentSchema = z
  .object({
    kind: RoomMomentKindSchema,
    source: RoomMomentSourceSchema,
    mintedByAgentRef: z
      .string()
      .min(1)
      .nullable()
      .describe(
        'The `agentAuthorRef` of the agent that minted this moment, or null when DorkOS itself did.'
      ),
  })
  .refine((moment) => moment.kind !== 'agent_minted' || moment.mintedByAgentRef !== null, {
    message: 'An agent-minted moment has to name the agent that minted it',
    path: ['mintedByAgentRef'],
  })
  .openapi('RoomMoment');

export type RoomMoment = z.infer<typeof RoomMomentSchema>;

// === Entries ===

/**
 * What an agent stopped to wait for, on an `awaiting_approval` notice.
 *
 * All three kinds write the SAME notice code — the room turn runner's damping
 * key depends on that, so splitting them into three codes would change
 * behaviour it relies on — and the entry therefore did not say which one it
 * was. This field has exactly one reader: a bridged chat renders its own
 * sentence per kind (spec `ask-entitlement` §5.4), because the room's own line
 * says "open its session" to somebody who may not have one.
 *
 * Optional on the body, so every entry stored before it existed still parses;
 * the bridge falls back to the approval sentence when it is absent.
 *
 * The names are the projector's own (`PendingInteractionDTO['type']`), so the
 * two cannot drift into meaning different things.
 */
export const RoomWaitingKindSchema = z
  .enum(['approval', 'question', 'elicitation'])
  .openapi('RoomWaitingKind');

/** What an agent stopped to wait for. */
export type RoomWaitingKind = z.infer<typeof RoomWaitingKindSchema>;

/**
 * The payload of a log entry.
 *
 * One shape rather than a union, because `kind` on the entry already says
 * whether this is someone talking or the room reporting: `notice` is set
 * exactly when `kind === 'notice'`, and `subjectAuthorId` names who the notice
 * is about when that is not the entry's own author (a refused trigger is
 * written by the system but is about the agent that did not reply).
 *
 * `moment` is the third field: set on a post that marks a milestone (spec
 * D5.1), never on a notice. `subjectAuthorId` does the same job for it as it
 * does for a notice — "tangerines joined your team" is written by the system
 * and is ABOUT tangerines, and that is the identity the feed draws.
 *
 * `answersEntryId` is about ORDER rather than identity: a room posts in arrival
 * order, so an answer is not always next to its question. It is set on every
 * agent-authored post a turn produces, because a reader cannot tell from the
 * outside which answers waited.
 *
 * `waitingKind` is the newest and the narrowest — see
 * {@link RoomWaitingKindSchema}. It is set only on an `awaiting_approval`
 * notice, and has exactly one reader.
 */
export const RoomEntryBodySchema = z
  .object({
    text: z.string(),
    notice: RoomNoticeCodeSchema.optional(),
    subjectAuthorId: z.string().optional(),
    moment: RoomMomentSchema.optional(),
    waitingKind: RoomWaitingKindSchema.optional(),
    answersEntryId: z
      .string()
      .optional()
      .describe(
        'The entry this post answers, set on every agent-authored post the room writes for a turn. Chat posts in arrival order whatever a message is responding to, and an agent whose message waited behind work in another conversation answers out of order often rather than rarely — so the pointer is what a reader follows back to the question.'
      ),
  })
  .openapi('RoomEntryBody');

export type RoomEntryBody = z.infer<typeof RoomEntryBodySchema>;

// === Reactions ===

/**
 * The most code points one reaction emoji may carry.
 *
 * Sixteen, because the longest emoji anybody actually sends is a family ZWJ
 * sequence with skin tones — four faces, four modifiers, three joiners, eleven
 * code points — and a little headroom above it is cheaper than a cap somebody
 * hits. It is a bound on the column, not a claim about which sequences are real.
 */
export const REACTION_EMOJI_MAX_CODE_POINTS = 16;

/** Every code point a reaction may be built from: pictographs and their parts. */
const REACTION_EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component})+$/u;

/**
 * At least one code point that carries the picture. `Emoji_Component` alone
 * includes the plain digits and `#`, so without this `0123` would qualify.
 */
const REACTION_EMOJI_PICTURE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{20E3}]/u;

/**
 * Whether a string may be stored as a reaction: emoji, and nothing else.
 *
 * **The bar this clears is "not a text label".** A reaction row renders as a
 * pill next to a message, so a column that accepted free text would turn the
 * pill row into a second composer — and one nobody can delete a word from.
 * Everything here is about that: pictographs and the pieces emoji are assembled
 * from (joiners, variation selectors, skin-tone modifiers, regional indicators,
 * keycaps), a length bound, and nothing else.
 *
 * **It deliberately is NOT `\p{RGI_Emoji}`**, which would be the exact set an
 * emoji picker offers. That property needs the `v` regex flag, and the flag is a
 * `SyntaxError` — thrown while the module loads, taking every importer with it —
 * on any engine below Chrome 112 / Safari 17 / Firefox 116. This package loads in
 * the browser, and the client builds for Vite's baseline target, which is below
 * all three. A validator that can brick the app it validates for is not a better
 * validator.
 *
 * What it gives up in exchange is precision at the edges: `👍👍` passes, because
 * telling one grapheme cluster from two needs `Intl.Segmenter`, whose support
 * floor is the same problem. Be exact about how much that gives up — the cap is
 * sixteen CODE POINTS, and a plain emoji is one, so the widest thing that slips
 * through is a run of about sixteen of them. That is a silly pill on a row of
 * pills, not a text field: it cannot hold a word, a tag, or a sentence, which is
 * the whole property the column needs.
 *
 * @param value - The candidate reaction, exactly as it arrived.
 * @returns Whether it may be stored.
 */
export function isReactionEmoji(value: string): boolean {
  const codePoints = [...value];
  if (codePoints.length === 0 || codePoints.length > REACTION_EMOJI_MAX_CODE_POINTS) return false;
  return REACTION_EMOJI_ONLY.test(value) && REACTION_EMOJI_PICTURE.test(value);
}

/** One emoji, validated. The wire type of every reaction field. */
export const ReactionEmojiSchema = z
  .string()
  .refine(isReactionEmoji, { message: 'A reaction has to be a single emoji' })
  .openapi('ReactionEmoji', {
    description:
      'One emoji, stored as the string that was sent — grapheme clusters, joiners, skin tones and flags all survive verbatim. There is no enum: an install that only ever accepted a fixed list would have to ship a migration to add a face.',
    example: '👍',
  });

/**
 * How many emoji the quick row in the message capsule holds.
 *
 * Three, from the approved design (`specs/room-messaging-design` §2): one hover
 * and one click to thank an agent. The server always returns exactly this many,
 * padding from {@link REACTION_FREQUENTS_DEFAULT}, so the row never reflows as a
 * person's history fills in.
 */
export const REACTION_FREQUENTS_COUNT = 3;

/**
 * The quick row before anybody has reacted to anything.
 *
 * Declared here rather than in the client so both sides cannot disagree about
 * what a new install's capsule offers. They are also the padding: somebody who
 * has only ever used 👀 gets `['👀', '👍', '❤️']`, never a row with two gaps in it.
 */
export const REACTION_FREQUENTS_DEFAULT: readonly string[] = ['👍', '❤️', '🎉'];

/**
 * Everyone who left one emoji on one entry.
 *
 * **Ids, not names**, exactly as {@link RoomEntrySchema.mentions} carries ids: a
 * reader already holds the roster, and a reaction from somebody who has since
 * left the room resolves to nothing on either shape — so carrying ids keeps one
 * resolution path instead of two and keeps the payload flat when fifty people
 * react to one message.
 *
 * `firstAt` is what orders the pill row. Ordering by it means a pill appears
 * where it appeared and stays there: sorting by count would make pills swap
 * places under the reader's cursor every time somebody else reacted.
 */
export const RoomEntryReactionSchema = z
  .object({
    emoji: ReactionEmojiSchema,
    authorIds: z
      .array(z.string().min(1))
      .describe(
        'Who reacted with this emoji, in the order they did — and, for two that landed inside the same millisecond, by author id, so two installs holding identical rows draw identical rows rather than leaving the order to whichever index the planner picked. Match against the room roster to render names; an id that is not on it belongs to somebody who has left.'
      ),
    firstAt: z
      .string()
      .describe(
        'When the first of these landed. The pill row is ordered by it, so a pill keeps its place as more people join it.'
      ),
  })
  .openapi('RoomEntryReaction');

export type RoomEntryReaction = z.infer<typeof RoomEntryReactionSchema>;

/** How the timeline may render an attachment inline, or `null` for a chip. */
export const RoomAttachmentPreviewSchema = z.enum(['image']).openapi('RoomAttachmentPreview');

/** One of {@link RoomAttachmentPreviewSchema}'s values. */
export type RoomAttachmentPreview = z.infer<typeof RoomAttachmentPreviewSchema>;

/** The longest original filename a room stores, in UTF-16 code units. */
export const ROOM_ATTACHMENT_NAME_MAX = 255;

/**
 * The most attachment ids one post may name.
 *
 * The SCHEMA's static ceiling, deliberately not the limit a person feels: it is
 * the maximum `config.uploads.maxFiles` may be set to
 * (`packages/shared/src/config-schema.ts` — `z.number().int().min(1).max(50).default(10)`).
 * The CONFIGURED value is enforced in the service, because config is read per
 * request and a Zod literal cannot be.
 */
export const ROOM_ATTACHMENT_MAX_PER_ENTRY = 50;

/**
 * One file posted with a room entry.
 *
 * Every field is SERVER-DERIVED. `name` is the uploaded filename after the same
 * sanitization `upload-handler.ts` applies, `size` is what actually landed on
 * disk, and `mimeType` is what the bytes were sniffed to be for an image and
 * what the client declared for everything else — which is why nothing is served
 * inline unless `preview` says the bytes themselves were checked.
 */
export const RoomAttachmentSchema = z
  .object({
    id: z.string().min(1).describe('ULID. Stable, unique within the room.'),
    name: z.string().min(1).max(ROOM_ATTACHMENT_NAME_MAX),
    mimeType: z.string().min(1),
    size: z.number().int().nonnegative(),
    preview: RoomAttachmentPreviewSchema.nullable().describe(
      'Non-null only when the BYTES were verified as that kind. A declared Content-Type never sets this.'
    ),
    url: z
      .string()
      .min(1)
      .describe(
        'Where to fetch it. Server-relative today; a remote store would answer an absolute https URL and no renderer changes.'
      ),
  })
  .openapi('RoomAttachment');

/** One file posted with a room entry, as it reaches a reader. */
export type RoomAttachment = z.infer<typeof RoomAttachmentSchema>;

/** What `POST /api/rooms/:id/attachments` answers with, in request order. */
export const RoomAttachmentUploadResponseSchema = z
  .object({ attachments: z.array(RoomAttachmentSchema) })
  .openapi('RoomAttachmentUploadResponse');

/** The body of a successful room attachment upload. */
export type RoomAttachmentUploadResponse = z.infer<typeof RoomAttachmentUploadResponseSchema>;

/**
 * One resolved `@mention`, located by where it sits in the entry's raw body.
 *
 * **The per-occurrence sibling of {@link RoomEntrySchema.mentions}**, and the
 * two answer different questions. `mentions` is the deduped set of author ids a
 * message reached — what addressing, dispatch and the cascade guard key on.
 * A span says *where* one `@handle` sits in {@link RoomEntryBody.text} so the
 * client can draw a pill exactly over it, without ever re-parsing the body (the
 * one thing "mentions resolve once, at write time" forbids). So there is one
 * span per written `@handle`, not one per author: `@ana @ana` yields two spans
 * and a single-id `mentions`.
 *
 * `offset` and `length` index the RAW body by UTF-16 code unit, the same units
 * a `string` is indexed and sliced by, so `body.text.slice(offset, offset +
 * length)` is exactly the matched `@handle`. When trailing sentence punctuation
 * was shaved to resolve the name (`@ana.` → `ana`), `length` covers only the
 * handle the resolver actually used (`@ana`), never the full stop.
 *
 * A span is emitted only for a handle that resolved to a LIVE author. A quoted
 * `@name` (blockquote, fenced or inline code) addresses nobody and gets none,
 * exactly as it contributes nothing to `mentions`; an unreachable ghost gets
 * none either, since there is no live pill to draw.
 */
export const MentionSpanSchema = z
  .object({
    offset: z
      .number()
      .int()
      .min(0)
      .describe('UTF-16 code-unit offset of the `@` in the raw body text.'),
    length: z
      .number()
      .int()
      .min(1)
      .describe('Length in UTF-16 code units of the matched `@handle`, `@` included.'),
    authorId: z.string().min(1).describe('The live author this occurrence resolved to.'),
  })
  .openapi('MentionSpan');

export type MentionSpan = z.infer<typeof MentionSpanSchema>;

/**
 * One durable item in a room's log.
 *
 * `seq` is per-room and monotonic — it is the cursor an unread divider, a
 * resume, and a paginated read all key on. The log is never trimmed: unlike the
 * session `EventLog` (capped at 5000, oldest evicted) a room that forgets what
 * was said is not a room.
 *
 * `cascadeRoot` / `cascadeDepth` carry the provenance the cascade guard reads
 * (ADR 260726-170127). A post by a human always starts fresh — its own id at
 * depth 0 — which is what lets a person re-engage a room the guard has stopped.
 */
export const RoomEntrySchema = z
  .object({
    roomId: z.string().min(1),
    seq: z.number().int().min(1),
    id: z.string().min(1).describe('Stable entry id (ULID). What a reaction would attach to.'),
    authorId: z.string().min(1),
    kind: RoomEntryKindSchema,
    body: RoomEntryBodySchema,
    mentions: z
      .array(z.string())
      .describe('Author ids resolved from @name at write time. Never re-parsed by the client.'),
    mentionSpans: z
      .array(MentionSpanSchema)
      .optional()
      .describe(
        "Where each resolved @mention sits in the raw body, so the client can draw a pill over it without re-parsing the text. One span per written @handle (not deduped like `mentions`), resolved once at write time. Optional for the same reason as `reactions`: the server's internal entry shape and entries that predate the field carry none, and absent should be read as empty — every wire path that carries a local room entry populates it."
      ),
    sessionId: z.string().nullable(),
    cascadeRoot: z.string().min(1),
    cascadeDepth: z.number().int().min(0),
    parentEntryId: z
      .string()
      .nullable()
      .describe(
        'The entry in this same room that this one answers, or null for a top-level entry. A thread is a relation between entries, never a room of its own (ADR 260728-022013).'
      ),
    threadRootEntryId: z
      .string()
      .nullable()
      .describe(
        "The entry at the head of this entry's thread, or null when it is top-level — including for a root that has replies, so a thread's reply count never counts its own root. The default timeline is every entry whose parentEntryId is null."
      ),
    signature: z.string().nullable().describe('Reserved for phase 4. Always null in v1.'),
    createdAt: z.string(),
    reactions: z
      .array(RoomEntryReactionSchema)
      .optional()
      .describe(
        "The entry's reactions right now, oldest pill first. Every path that delivers an entry to a reader carries it — the history page, the stream's hydration snapshot, a resume replay, and a live `entry` event, which carries `[]` because an entry a millisecond old has none. It is optional only because the server's internal entry shape exists before the roll-up runs; on the wire it is always present, and absent should be read as empty."
      ),
    attachments: z
      .array(RoomAttachmentSchema)
      .optional()
      .describe(
        "The files posted with this entry. Every path that delivers an entry to a reader carries it — the history page, the stream's hydration snapshot, a resume replay, and a live `entry` event. Optional only because the server's internal entry shape exists before the roll-up runs; on the wire it is always present, and absent should be read as empty."
      ),
  })
  .openapi('RoomEntry');

export type RoomEntry = z.infer<typeof RoomEntrySchema>;

// === Requests ===

export const CreateRoomRequestSchema = z
  .object({
    kind: z
      .enum(['channel', 'dm'])
      .describe(
        'A thread is not a room: it is a relation between entries, written by replying with POST /:id/threads (ADR 260728-022013).'
      ),
    title: z.string().min(1).max(200).optional(),
    slug: z.string().regex(ROOM_SLUG_REGEX).optional(),
    topic: z.string().max(500).optional(),
    workspaceId: z.string().min(1).optional(),
    members: z
      .array(z.string().min(1))
      .default([])
      .describe('Author ids to seed the roster with, besides the creator.'),
    agentPaths: z
      .array(z.string().min(1))
      .default([])
      .describe(
        'Agent directories to seed the roster with, minting an author row for any agent that has never been in a room. The cockpit knows agents by path and not by author id, so without this a DM takes two calls and a failed second one leaves a room with nobody in it. A DM may name any number of agents: one gives a one-to-one conversation, several give a group.'
      ),
  })
  .refine((v) => v.title !== undefined || v.slug !== undefined, {
    message: 'A room needs a title or a slug',
    path: ['title'],
  })
  // A slug is a channel's `#name`; a DM has no slug, so a DM named only by one
  // used to render as the bare "#" its title fell back to.
  .refine((v) => v.kind !== 'dm' || v.title !== undefined, {
    message: 'A direct message needs a title',
    path: ['title'],
  })
  .openapi('CreateRoomRequest');

export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

export const UpdateRoomRequestSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    topic: z.string().max(500).nullable().optional(),
    archived: z.boolean().optional(),
    deliverNotices: z
      .boolean()
      .optional()
      .describe(
        "The one per-bridge override for outbound notices (chats-as-channels spec §6.2, D-6 Q5): whether a turn_failed or halted notice reaches this room's bridged chat. Valid only on a bridged room; a room with no bridge refuses this field with NOT_A_BRIDGED_ROOM."
      ),
  })
  .openapi('UpdateRoomRequest');

export type UpdateRoomRequest = z.infer<typeof UpdateRoomRequestSchema>;

export const PostToRoomRequestSchema = z
  .object({
    text: z.string().min(1).max(100_000),
    sessionId: z
      .string()
      .min(1)
      .optional()
      .describe('The session that produced this post, when one did.'),
    attachmentIds: z
      .array(z.string().min(1))
      .max(ROOM_ATTACHMENT_MAX_PER_ENTRY)
      .optional()
      .describe(
        'Ids from POST /api/rooms/:id/attachments, in the order they should render. Yours, from this room, and not already posted.'
      ),
  })
  .openapi('PostToRoomRequest');

export type PostToRoomRequest = z.infer<typeof PostToRoomRequestSchema>;

export const AddRoomMemberRequestSchema = z
  .object({
    authorId: z.string().min(1).optional(),
    agentPath: z
      .string()
      .min(1)
      .optional()
      .describe('Add an agent by its directory, minting the author row if this is its first room.'),
    responseMode: ResponseModeSchema.optional().describe(
      'Omit to seed from the room kind: the agent manifest for a DM, "engaged" for a channel.'
    ),
  })
  .refine((v) => v.authorId !== undefined || v.agentPath !== undefined, {
    message: 'Provide authorId or agentPath',
    path: ['authorId'],
  })
  .openapi('AddRoomMemberRequest');

export type AddRoomMemberRequest = z.infer<typeof AddRoomMemberRequestSchema>;

export const UpdateMembershipRequestSchema = z
  .object({ responseMode: ResponseModeSchema })
  .openapi('UpdateMembershipRequest');

export type UpdateMembershipRequest = z.infer<typeof UpdateMembershipRequestSchema>;

/**
 * Set (or clear) an author's handle.
 *
 * **`handle` is the raw string a person typed**, not a pre-validated one: the
 * server normalizes and judges it, so a client that skipped its own check
 * cannot store something the grammar forbids. An empty string clears the
 * handle, tombstoning whatever they had — that is the coercion the partial
 * unique index depends on, and it lives on the server for the same reason.
 */
export const SetAuthorHandleRequestSchema = z
  .object({
    handle: z
      .string()
      .max(64)
      .describe(
        'The new handle, without its `@`. Empty clears it. Refused with INVALID_HANDLE, HANDLE_TAKEN or HANDLE_RESERVED.'
      ),
  })
  .openapi('SetAuthorHandleRequest');

export type SetAuthorHandleRequest = z.infer<typeof SetAuthorHandleRequestSchema>;

/**
 * Post a reply inside a thread.
 *
 * There is nothing to create first: a thread comes into existence when the first
 * reply points at a root entry, and this same request posts the second reply and
 * the twentieth (ADR 260728-022013). It carries `text` rather than a `title`
 * because what it writes is a message, not a room.
 */
export const PostThreadReplyRequestSchema = z
  .object({
    rootEntryId: z
      .string()
      .min(1)
      .describe(
        'The entry this reply hangs off, in this same room. Refused with NESTED_THREAD when it is itself a reply — one level deep is a service policy, not a shape the schema decided.'
      ),
    text: z.string().min(1).max(100_000),
    sessionId: z
      .string()
      .min(1)
      .optional()
      .describe('The session that produced this reply, when one did.'),
    attachmentIds: z
      .array(z.string().min(1))
      .max(ROOM_ATTACHMENT_MAX_PER_ENTRY)
      .optional()
      .describe(
        'Ids from POST /api/rooms/:id/attachments, in the order they should render. Yours, from this room, and not already posted.'
      ),
  })
  .openapi('PostThreadReplyRequest');

export type PostThreadReplyRequest = z.infer<typeof PostThreadReplyRequestSchema>;

/**
 * Toggle one emoji on one entry, or put it into a state you name.
 *
 * There is no `remove` verb and there is not going to be one: the pill IS the
 * toggle (`specs/room-messaging-design` §2, behaviour 1), so a second click on a
 * pill you already added takes it back. The server keys that on
 * `(entry, you, emoji)` rather than on anything the request says, which is what
 * holds at most one reaction there however many times anyone asks.
 *
 * `on` is the escape hatch from the one thing a toggle cannot survive, which is
 * a retry: send a flip twice and you have undone yourself. Naming the state you
 * want makes the call idempotent in effect, so a client that retries on a
 * timeout — or reconciles an optimistic pill against what the stream says — has
 * something safe to send. Omit it and the flip is what you get, which is the
 * right default for a click.
 */
export const ToggleReactionRequestSchema = z
  .object({
    emoji: ReactionEmojiSchema,
    on: z
      .boolean()
      .optional()
      .describe(
        'The state to land in: `true` puts the reaction there, `false` takes it away, and both are safe to send twice. Omit to flip whatever is there, which is what a click means. Sending `true` for a reaction you already have does NOT restamp it, so the pill keeps its place in a row ordered by first appearance.'
      ),
  })
  .openapi('ToggleReactionRequest');

export type ToggleReactionRequest = z.infer<typeof ToggleReactionRequestSchema>;

/**
 * What toggling a reaction answers with.
 *
 * 202 and identity-shaped, exactly like posting: the entry's new reaction set
 * reaches every reader — this one included — over `GET /api/rooms/{id}/events`,
 * so there is one delivery path rather than two. What the body adds is the two
 * things a reader cannot derive from its own click: which way the toggle went,
 * and what the quick row holds now that this reaction has been counted.
 */
export const ToggleReactionResponseSchema = z
  .object({
    accepted: z.literal(true),
    entryId: z.string().min(1),
    emoji: ReactionEmojiSchema,
    reacted: z
      .boolean()
      .describe(
        'The state your pill is in NOW: true when this call added the reaction, false when it took one back.'
      ),
    frequents: z
      .array(z.string())
      .describe(
        'Your quick row, recomputed with this reaction counted. Returned so the capsule stays current without a second request.'
      ),
  })
  .openapi('ToggleReactionResponse');

export type ToggleReactionResponse = z.infer<typeof ToggleReactionResponseSchema>;

export const ListRoomsQuerySchema = z
  .object({
    kind: RoomKindSchema.optional(),
    includeArchived: z.coerce.boolean().optional(),
  })
  .openapi('ListRoomsQuery');

export type ListRoomsQuery = z.infer<typeof ListRoomsQuerySchema>;

/** Page size `GET /api/rooms/:id/entries` uses when the caller names none. */
export const ROOM_ENTRY_PAGE_SIZE_DEFAULT = 50;

/** Largest page `GET /api/rooms/:id/entries` will serve. Beyond it, 400. */
export const ROOM_ENTRY_PAGE_SIZE_MAX = 200;

export const ListRoomEntriesQuerySchema = z
  .object({
    before: z.coerce.number().int().min(1).optional().describe('Return entries with seq < this.'),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(ROOM_ENTRY_PAGE_SIZE_MAX)
      .default(ROOM_ENTRY_PAGE_SIZE_DEFAULT),
  })
  .openapi('ListRoomEntriesQuery');

export type ListRoomEntriesQuery = z.infer<typeof ListRoomEntriesQuerySchema>;

// === Threads across rooms ===

/** How many threads `GET /api/rooms/threads` returns when the caller names none. */
export const THREAD_LIST_LIMIT_DEFAULT = 50;

/** Largest thread list that route will serve. Beyond it, 400. */
export const THREAD_LIST_LIMIT_MAX = 200;

/** Longest root excerpt a {@link ThreadSummary} carries. */
export const THREAD_PREVIEW_MAX_CHARS = 160;

export const ListThreadsQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(THREAD_LIST_LIMIT_MAX)
      .default(THREAD_LIST_LIMIT_DEFAULT),
  })
  .openapi('ListThreadsQuery');

export type ListThreadsQuery = z.infer<typeof ListThreadsQuerySchema>;

/**
 * One thread the reader is in, as the sidebar's Threads section reads it
 * (spec `room-messaging-design` §3, cross-room surface 1).
 *
 * **Participation selects a thread; the room's roster permits it.** A thread is
 * here because the reader wrote its root or wrote one of its replies AND is on
 * that room's roster today — participation implies membership when the words
 * were written, never when they are read, so somebody removed from a room sees
 * none of its threads. There is no follow list and no stored membership — that
 * was assessed as real server lift and deferred until threads are noisy enough
 * to need the valve — so nothing about this shape is persisted anywhere; it is
 * derived from the room log on every read.
 *
 * The room is carried FLAT rather than nested, because that is every field a
 * row needs to name the room it belongs to and none of the ones it does not:
 * a thread row draws `#general`, never that channel's roster, topic, or
 * archived flag.
 */
export const ThreadSummarySchema = z
  .object({
    roomId: z.string().min(1),
    roomKind: RoomKindSchema,
    roomSlug: z.string().nullable().describe('Channels only, as on the room itself.'),
    roomTitle: z.string().min(1),
    rootEntryId: z.string().min(1).describe('The entry the thread hangs off.'),
    rootAuthorId: z.string().min(1),
    rootPreview: z
      .string()
      .describe(
        `The root's text, truncated to ${THREAD_PREVIEW_MAX_CHARS} characters. Empty when the root carried no text — a row draws a placeholder rather than pretending the message was blank.`
      ),
    replyCount: z.number().int().min(1).describe('Replies below the root. Never counts the root.'),
    unreadCount: z
      .number()
      .int()
      .min(0)
      .describe(
        "Replies above the reader's `(member, room)` read cursor. Opening the room clears this, exactly as it clears the room's own badge: there is one cursor per (member, room) and threads share it. A reply of the reader's OWN counts while it sits above that cursor — unread is measured against the cursor and nothing else, which is how `countUnread` measures the room's badge, and one rule measured in one place is worth more here than a special case for your own words. In practice the room you just wrote in is the room you have open, so the cursor passes it immediately."
      ),
    lastActivityAt: z.string().describe("The newest reply's timestamp. The list is sorted on it."),
  })
  .openapi('ThreadSummary');

export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

// === Responses ===

/**
 * One community that could not contribute to the room list — the wire form of
 * `CommunityWarning` (`community-adapter.ts` §8).
 *
 * **Restated here rather than imported, and the reason is a module cycle**: the
 * `CommunityAdapter` port imports this file for `RoomKindSchema`,
 * `AuthorKindSchema` and `RoomPresenceStateSchema`, so importing back would put
 * two top-level Zod modules in a cycle and leave whichever loaded second reading
 * an undefined schema. Nothing is duplicated by it: `community` is a branded
 * `CommunityRef` in the server's types and a plain string once it is JSON, which
 * is exactly the boundary this schema sits on, and a `CommunityWarning` passes
 * through unchanged.
 */
export const RoomListWarningSchema = z
  .object({
    community: z.string().min(1).describe('The community that degraded.'),
    label: z.string().min(1).describe('What a person calls that community.'),
    message: z
      .string()
      .min(1)
      .describe('Plain language, already safe to render — never a raw protocol string.'),
  })
  .openapi('RoomListWarning');

export type RoomListWarning = z.infer<typeof RoomListWarningSchema>;

/**
 * The `GET /api/rooms` envelope.
 *
 * `rooms` is this machine's own rooms and nothing else. `warnings` is the
 * per-community degradation every other configured community reports — empty on
 * an install that is only in this one, which is every install today.
 */
export const RoomListResponseSchema = z
  .object({
    rooms: z.array(RoomSummarySchema),
    warnings: z
      .array(RoomListWarningSchema)
      .describe(
        'Communities that could not contribute to this list, each already carrying the sentence to show. Empty is the normal case; a non-empty entry is never a reason to hide the rooms that did list.'
      ),
  })
  .openapi('RoomListResponse');

export type RoomListResponse = z.infer<typeof RoomListResponseSchema>;

/** The `GET /api/rooms/threads` envelope, most recent activity first. */
export const ThreadListResponseSchema = z
  .object({ threads: z.array(ThreadSummarySchema) })
  .openapi('ThreadListResponse');

export type ThreadListResponse = z.infer<typeof ThreadListResponseSchema>;

/** The `GET /api/rooms/:id/entries` envelope, oldest-first within the page. */
export const RoomEntryListResponseSchema = z
  .object({ entries: z.array(RoomEntrySchema) })
  .openapi('RoomEntryListResponse');

export type RoomEntryListResponse = z.infer<typeof RoomEntryListResponseSchema>;

/**
 * What `POST /api/rooms/:id/entries` answers with.
 *
 * Identity, not delivery: the entry itself reaches every reader — including the
 * poster — over `GET /api/rooms/:id/events`, so the 202 carries only enough to
 * correlate an optimistic echo with the committed entry.
 */
export const PostToRoomResponseSchema = z
  .object({
    accepted: z.literal(true),
    entryId: z.string().min(1),
    seq: z.number().int().min(1),
  })
  .openapi('PostToRoomResponse');

export type PostToRoomResponse = z.infer<typeof PostToRoomResponseSchema>;

/**
 * What stopping a room did.
 *
 * `stopped: 0` is a real and useful answer rather than a failure: it says the
 * room was already idle, which is what pressing stop a second time means. The
 * room's own `halted` notice says the same thing to everybody in it.
 */
export const HaltRoomResponseSchema = z
  .object({
    stopped: z.number().int().min(0),
  })
  .openapi('HaltRoomResponse');

export type HaltRoomResponse = z.infer<typeof HaltRoomResponseSchema>;

/**
 * What asking to be answered first did.
 *
 * `promoted: false` is a real answer rather than a failure: it says there was
 * nothing waiting, which is what a button left over from a wait that has already
 * ended looks like. Nothing was reordered and nothing went wrong.
 */
export const PromoteHoldResponseSchema = z
  .object({
    promoted: z.boolean(),
  })
  .openapi('PromoteHoldResponse');

export type PromoteHoldResponse = z.infer<typeof PromoteHoldResponseSchema>;

/** Which session one agent's work in a room runs in. */
export const RoomSessionBindingSchema = z
  .object({
    /** The agent's author id in this room. */
    authorId: z.string().min(1),
    /** The session its turns run in. */
    sessionId: z.string().min(1),
  })
  .openapi('RoomSessionBinding');

export type RoomSessionBinding = z.infer<typeof RoomSessionBindingSchema>;

/**
 * What `GET /api/rooms/:id/sessions` answers with: ids, and nothing else.
 *
 * **The narrowness is the security claim.** This exists so the room's live lane
 * can offer "Open its session" — a link, which needs a session id and nothing
 * more. No session content, no working directory, no status: a route that
 * answered those would be a second, unreviewed way to read a session, reached
 * through a room.
 */
export const RoomSessionsResponseSchema = z
  .object({ bindings: z.array(RoomSessionBindingSchema) })
  .openapi('RoomSessionsResponse');

export type RoomSessionsResponse = z.infer<typeof RoomSessionsResponseSchema>;

// === SSE ===

/**
 * The hydration frame a cold `GET /api/rooms/:id/events` connect opens with.
 * `cursor` is the seq the live subscription resumes from, so a client that
 * reconnects with `Last-Event-ID` never re-reads what it already has.
 */
export const RoomSnapshotSchema = z
  .object({
    room: RoomWithRosterSchema,
    entries: z.array(RoomEntrySchema),
    cursor: z.number().int().min(0),
  })
  .openapi('RoomSnapshot');

export type RoomSnapshot = z.infer<typeof RoomSnapshotSchema>;

/**
 * Where a working indicator is in its life: an agent has taken a turn, has
 * outrun the room's wait, is waiting to start one, or has finished.
 *
 * **`held` is the one member that describes work which has NOT started.** This
 * room's message is waiting behind a turn the same agent is running somewhere
 * else — one agent is one working directory, so the second turn cannot start
 * beside the first. It resolves into `working` when the other turn ends, or into
 * `done` when the wait is given up on.
 *
 * Declared once and reused by `community-adapter.ts`'s presence payload, so the
 * lifecycle a room publishes locally and the one a community carries outward can
 * never drift into two vocabularies. The two payloads DO differ on optionality —
 * `entryId` and `since` are required here and optional on the port — and that is
 * capability-honest rather than drift: this room is the producer and always knows
 * both, while a remote backend may be able to say only that somebody is working.
 *
 * **Adding a member is additive for a remote producer**, which is what keeps
 * that reuse honest: a backend that has no notion of holding simply never sends
 * `held`, and `communityConformance` requires nothing of it.
 */
export const RoomPresenceStateSchema = z
  .enum(['working', 'working_late', 'held', 'done'])
  .openapi('RoomPresenceState');

/** Where a working indicator is in its life. See {@link RoomPresenceStateSchema}. */
export type RoomPresenceState = z.infer<typeof RoomPresenceStateSchema>;

/**
 * What a `held` indicator is waiting behind.
 *
 * **Ids only, and that is the whole disclosure design.** A reader in this room
 * may not be a member of the room whose turn is in the way, so the wire carries
 * no title, no topic, no author and no message text — and a room id grants
 * nothing on its own, because "not a member" answers exactly as "no such room".
 * The client resolves the id against the rooms it can already see: a reader who
 * can see that room reads its name, and a reader who cannot reads "another
 * conversation".
 */
export const RoomHeldBehindSchema = z
  .object({
    roomId: z
      .string()
      .min(1)
      .describe(
        'The room whose turn is in the way. An id and nothing else: the reader resolves it against the rooms they can already see, and a reader who cannot see it reads "another conversation".'
      ),
    othersWaiting: z
      .boolean()
      .describe(
        'This agent is holding a message in at least one OTHER conversation too. A boolean, never a count or a list — it exists only to decide whether "Answer here first" would do anything.'
      ),
  })
  .openapi('RoomHeldBehind');

/** What a `held` indicator is waiting behind. See {@link RoomHeldBehindSchema}. */
export type RoomHeldBehind = z.infer<typeof RoomHeldBehindSchema>;

/** A committed log entry arriving live. Carries `seq`, so it replays. */
export const RoomEntryEventSchema = z
  .object({
    type: z.literal('entry'),
    seq: z.number().int().min(1),
    entry: RoomEntrySchema,
  })
  .openapi('RoomEntryEvent');

/**
 * An ephemeral signal — typing, presence, a receipt. Delivered live and dropped
 * on replay, so it carries no `seq` and never enters the log. A room's record
 * is what another member should be able to read later; "Ana is typing" is not
 * that.
 */
export const RoomSignalEventSchema = z
  .object({
    type: z.literal('signal'),
    signal: SignalTypeSchema,
    authorId: z.string().min(1),
    at: z.string(),
    /** Where in the working lifecycle this author is, on a `'progress'` signal. */
    state: RoomPresenceStateSchema.optional(),
    /**
     * The entry whose trigger this presence is about. With `(room, authorId)` it
     * is the indicator's whole identity, which is what lets one agent be working
     * on two things at once without either release clearing the other.
     */
    entryId: z.string().optional(),
    /**
     * When the work started, ISO 8601 — never when this event was sent. Elapsed
     * time is derived from it, and it rides EVERY publish rather than only the
     * first: signals never replay, so an event has to be renderable on its own by
     * a client that connected after the work began.
     */
    since: z.string().optional(),
    /**
     * What this agent's turn is doing right now, when the room has heard a tool
     * call for it — the same structured reading `SessionStatus.activity`
     * carries, reused rather than restated.
     *
     * **Structure, never prose.** {@link SessionActivitySchema}'s own contract
     * is that the client owns the wording, so a reading minted by an older
     * server can never put stale copy on a newer screen, and one turn cannot be
     * described two ways by the session lane and the room lane.
     *
     * Optional on every publish, and absent far more often than the other three:
     * a turn before its first tool has none, a turn that has ended has had it
     * cleared, and a claim held for a turn that never started never had one. An
     * absent reading is not a gap to fill — the room's own sentence ("Kai is
     * working on it") is the honest thing to say instead.
     */
    activity: SessionActivitySchema.optional(),
    /**
     * What a `state: 'held'` indicator is waiting behind. Present on that state
     * and on no other, because nothing else is waiting on another room.
     */
    heldBehind: RoomHeldBehindSchema.optional(),
  })
  .openapi('RoomSignalEvent');

/**
 * One entry's reactions, after somebody changed them.
 *
 * ## Why this is a third event and not an entry update
 *
 * A reaction is DURABLE state — unlike a typing signal, which is gone the moment
 * nobody is looking — so a reader has to end up with the right pills after a
 * disconnect, not merely after a lucky one. Two shapes could carry that, and the
 * room's own stream decides between them:
 *
 * - **Version the entry and re-send it.** The stream has no such thing. A room
 *   entry is immutable, replay is `WHERE seq > cursor`, and `seq` is allocated
 *   once at insert — so a re-sent entry would either need a new `seq` (a second
 *   copy of the message in every reader's log) or keep its old one (below the
 *   cursor, therefore never replayed). Reactions on messages older than the
 *   cursor are the common case, so this shape is wrong exactly where it matters.
 * - **A reaction event carrying the entry's WHOLE current set.** That is this.
 *
 * ## What makes it correct across a gap
 *
 * Three properties, together:
 *
 * 1. **It is state, never a delta.** `reactions` is everything on the entry
 *    right now, so a reader that missed five of these and caught the sixth is
 *    correct again. A `reaction_added` / `reaction_removed` pair could not say
 *    that — one missed frame and the pills stay wrong until a reload.
 * 2. **It carries no `seq` and no `id:` line**, so it never moves the reader's
 *    `Last-Event-ID`. The cursor stays what it has always been: the highest
 *    durable ENTRY this reader holds. Giving reactions their own number would
 *    mean two cursors in one header, and a client that got the packing wrong
 *    would silently skip real messages.
 * 3. **A resume re-sends them for the window it can render, EVERY entry of it.**
 *    Replay covers entries above the cursor and each of those carries its own
 *    reactions; a reaction that changed on an OLDER message while the reader was
 *    away is covered by the handler emitting one of these per entry in the
 *    trailing window, after the replay — **including entries with no reactions
 *    at all**. Skipping the empties would look like a saving and would silently
 *    lose every REMOVAL: take a pill back while somebody is disconnected and the
 *    entry is unchanged, so nothing replays it, and it has no pills, so a resync
 *    that only named entries still holding some would say nothing about it and
 *    leave that reader showing a reaction the server no longer has. The empty
 *    event is the correction. Beyond the window a reader holds no entries to put
 *    pills on, and pages back through `GET /api/rooms/{id}/entries`, which
 *    carries reactions too.
 *
 * So the invariant is: **every path that hands a reader an entry hands over that
 * entry's reactions with it**, and this event keeps them fresh in between.
 */
export const RoomReactionEventSchema = z
  .object({
    type: z.literal('reaction'),
    entryId: z.string().min(1).describe('The entry in this room whose reactions changed.'),
    reactions: z
      .array(RoomEntryReactionSchema)
      .describe(
        "The entry's COMPLETE reaction set now, not a delta — an empty array means the last pill was taken back."
      ),
  })
  .openapi('RoomReactionEvent');

/** Everything that travels on a room's SSE stream. */
export const RoomEventSchema = z
  .discriminatedUnion('type', [
    RoomEntryEventSchema,
    RoomSignalEventSchema,
    RoomReactionEventSchema,
  ])
  .openapi('RoomEvent');

export type RoomEvent = z.infer<typeof RoomEventSchema>;
export type RoomEntryEvent = z.infer<typeof RoomEntryEventSchema>;
export type RoomSignalEvent = z.infer<typeof RoomSignalEventSchema>;
export type RoomReactionEvent = z.infer<typeof RoomReactionEventSchema>;

/**
 * The three required fields a `'progress'` signal carries on the rooms path,
 * plus the one that rides only a `held` state.
 *
 * Derived from the event rather than declared beside it, so the producer cannot
 * drift from the wire. They are optional on the event — a `'typing'` signal has
 * no lifecycle — and required HERE because of what a partial one costs
 * downstream: an indicator with no `entryId` cannot be keyed, and one with no
 * `since` cannot be aged or shown an elapsed time.
 *
 * **Required of the producer that always knows all three, not of every caller.**
 * `RoomTriggerDispatcher` owns the claim map, so its `publishPresence` dep takes
 * this whole type and is held to it. `RoomService.publishSignal` accepts a
 * `Partial` of it, because a `CommunityAdapter` caller's payload is optional
 * field by field (a remote backend may only be able to say that somebody is
 * working), and inventing an `entryId` to satisfy a required type would put a
 * fabricated key on the wire. The client is what makes that safe rather than
 * lossy: `useRoomPresenceStore.observe` DROPS any progress frame missing one of
 * the three, so an unkeyable indicator is never rendered and never has to be
 * cleared.
 *
 * `activity` and `heldBehind` are the two fields that stay OPTIONAL for the
 * producer, and that is capability-honest rather than a hole: the dispatcher
 * always knows which entry a claim answers and when it was taken, genuinely does
 * not know what a turn is doing before its first tool call, and has nothing to
 * point at unless the indicator is `held`.
 */
export type RoomPresencePayload = Required<Pick<RoomSignalEvent, 'state' | 'entryId' | 'since'>> &
  Pick<RoomSignalEvent, 'activity' | 'heldBehind'>;

/**
 * The same presence, with the one field that names a person's work removed.
 *
 * The verb survives ("running a command", "reading a file"); the file name, the
 * command excerpt, the search pattern and the host do not. What is left is the
 * shape of the work rather than its content, which is the most any audience
 * beyond this operator's own cockpit is owed — the same rule the room's durable
 * waiting notice already follows.
 *
 * A function rather than a comment on each call site because there are two call
 * sites today, and the third one somebody adds is the one that would forget.
 *
 * Constrained on `object` with the field intersected in rather than on the field
 * itself: a constraint that is nothing BUT optional properties is a weak type,
 * so passing the ordinary payload — one that carries no reading — failed to
 * compile with an error about having "no properties in common", which is the
 * opposite of what this function is for.
 *
 * @param payload - The presence a producer is about to hand outward.
 * @returns The same payload with `activity.target` gone. A payload carrying no
 *   activity at all comes back untouched — never with an empty one invented for
 *   it.
 */
export function withoutActivityTarget<T extends object>(
  payload: T & { activity?: SessionActivity }
): T & { activity?: SessionActivity } {
  if (payload.activity === undefined) return payload;
  return { ...payload, activity: { toolName: payload.activity.toolName } };
}

// === Canonical serialization (reserved for signing) ===

/**
 * The subset of an entry a signature would cover. Deliberately excludes `seq`
 * (server-allocated), `mentions` (server-resolved) and the cascade columns
 * (server provenance): a signature attests to what the author wrote, not to
 * what the server decided about it.
 */
export interface SignableRoomEntry {
  roomId: string;
  id: string;
  authorId: string;
  kind: RoomEntryKind;
  body: RoomEntryBody;
  createdAt: string;
}

/** Code-unit ordering — deterministic everywhere, unlike `localeCompare`. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Recursively normalize a value: every string (key or value) to Unicode NFC,
 * every object's keys sorted by code unit, `undefined` properties dropped.
 */
function canonicalizeValue(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value === null || typeof value !== 'object') return value;

  const normalized: Array<[string, unknown]> = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    // `undefined` is dropped by JSON.stringify anyway; dropping it here keeps
    // the sorted key list and the emitted key list identical.
    if (raw === undefined) continue;
    normalized.push([key.normalize('NFC'), canonicalizeValue(raw)]);
  }
  normalized.sort((a, b) => compareCodeUnits(a[0], b[0]));
  return Object.fromEntries(normalized);
}

/**
 * Deterministic serialization of the signable subset of a room entry.
 *
 * Nothing signs in v1. This exists now so phase 4 can add a signature without a
 * migration and without re-deciding what "the same message" means: two installs
 * that disagree about key order or Unicode composition would produce different
 * bytes for identical content, and every signature would fail for a reason
 * nobody could see. Its output is pinned byte-for-byte by tests.
 *
 * The rules, in full: only the six {@link SignableRoomEntry} fields; object
 * keys sorted by UTF-16 code unit at every depth; every string NFC-normalized;
 * `undefined` properties dropped; no whitespace. Numbers use `JSON.stringify`'s
 * shortest round-trip form, so a non-finite number would serialize as `null` —
 * a body that needs one must carry it as a string.
 *
 * @param entry - The entry to serialize.
 * @returns The canonical UTF-8 JSON string.
 */
export function canonicalizeEntry(entry: SignableRoomEntry): string {
  return JSON.stringify(
    canonicalizeValue({
      authorId: entry.authorId,
      body: entry.body,
      createdAt: entry.createdAt,
      id: entry.id,
      kind: entry.kind,
      roomId: entry.roomId,
    })
  );
}
