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
 */
export const RoomNoticeCodeSchema = z
  .enum(['cascade_stopped', 'budget_reached', 'agent_busy', 'turn_failed'])
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
 * `displayName`, `emoji` and `color` are all the same thing — a render cache
 * refreshed whenever the author is resolved. None of them is ever the key, and
 * nothing may look an author up by one.
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
    agentRef: z
      .string()
      .optional()
      .describe(
        'Agents only: the stable handle from `agentAuthorRef(agentPath)`. Compare this, never a display name.'
      ),
    mentionHandle: z
      .string()
      .optional()
      .describe(
        "What to type after an `@` to address this author, when anything does. A mention picker inserts it verbatim, so the string written is the string the server resolves — and it is resolved against the whole roster, so it reaches THIS author and not another member who happens to answer to the same name. Carried on every resolved roster (`RoomWithRoster`: create, read, update, and the room stream's hydration snapshot), and absent from the bulk room list, which addresses nobody. Absent also means this author cannot be addressed by `@` at all — every name it answers to either contains a space, which the mention pattern cannot span, or belongs to an earlier member. Never assume a display name works: those routinely contain spaces."
      ),
  })
  .openapi('AuthorRef');

export type AuthorRef = z.infer<typeof AuthorRefSchema>;

// === Rooms ===

/** Characters a channel slug may use — lowercase, digits, hyphens. */
export const ROOM_SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,79}$/;

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
    createdAt: z.string(),
    lastActivityAt: z.string(),
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
      'Per-room override, written explicitly at join time. Seeded from the manifest for a DM and "mention-only" for a channel. A thread is a position inside a channel rather than a room of its own, so a reply there reads the channel\'s value.'
    ),
    joinedAt: z.string(),
    lastReadSeq: z.number().int().min(0).describe('The (member, room) read cursor.'),
  })
  .openapi('RoomMember');

export type RoomMember = z.infer<typeof RoomMemberSchema>;

/** A membership with its author resolved, which is what a roster renders. */
export const RoomRosterEntrySchema = RoomMemberSchema.extend({
  author: AuthorRefSchema,
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
}).openapi('RoomWithRoster');

export type RoomWithRoster = z.infer<typeof RoomWithRosterSchema>;

// === Entries ===

/**
 * The payload of a log entry.
 *
 * One shape rather than a union, because `kind` on the entry already says
 * whether this is someone talking or the room reporting: `notice` is set
 * exactly when `kind === 'notice'`, and `subjectAuthorId` names who the notice
 * is about when that is not the entry's own author (a refused trigger is
 * written by the system but is about the agent that did not reply).
 */
export const RoomEntryBodySchema = z
  .object({
    text: z.string(),
    notice: RoomNoticeCodeSchema.optional(),
    subjectAuthorId: z.string().optional(),
  })
  .openapi('RoomEntryBody');

export type RoomEntryBody = z.infer<typeof RoomEntryBodySchema>;

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
      'Omit to seed from the room kind: the agent manifest for a DM, "mention-only" for a channel.'
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

export const SetReadCursorRequestSchema = z
  .object({ lastReadSeq: z.number().int().min(0) })
  .openapi('SetReadCursorRequest');

export type SetReadCursorRequest = z.infer<typeof SetReadCursorRequestSchema>;

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
  })
  .openapi('PostThreadReplyRequest');

export type PostThreadReplyRequest = z.infer<typeof PostThreadReplyRequestSchema>;

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

// === Responses ===

/** The `GET /api/rooms` envelope. */
export const RoomListResponseSchema = z
  .object({ rooms: z.array(RoomSummarySchema) })
  .openapi('RoomListResponse');

export type RoomListResponse = z.infer<typeof RoomListResponseSchema>;

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
  })
  .openapi('RoomSignalEvent');

/** Everything that travels on a room's SSE stream. */
export const RoomEventSchema = z
  .discriminatedUnion('type', [RoomEntryEventSchema, RoomSignalEventSchema])
  .openapi('RoomEvent');

export type RoomEvent = z.infer<typeof RoomEventSchema>;
export type RoomEntryEvent = z.infer<typeof RoomEntryEventSchema>;
export type RoomSignalEvent = z.infer<typeof RoomSignalEventSchema>;

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
