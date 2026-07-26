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
 * The three shapes a room takes. A `thread` is the same entity with a parent —
 * one level deep, never a thread of a thread (ADR 260726-170125).
 */
export const RoomKindSchema = z.enum(['channel', 'dm', 'thread']).openapi('RoomKind');

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
 */
export const RoomNoticeCodeSchema = z.enum(['cascade_stopped']).openapi('RoomNoticeCode');

export type RoomNoticeCode = z.infer<typeof RoomNoticeCodeSchema>;

// === Authors ===

/**
 * How an author appears to a reader: the opaque persisted id plus enough to
 * render it. The `naturalKey` behind the id (an agent's `agentPath`) never
 * leaves the server — a room is a shared surface, and a home-directory path is
 * not something to put on the wire (ADR 260726-170126).
 */
export const AuthorRefSchema = z
  .object({
    id: z.string().min(1).describe('Opaque author id (ULID). Stable across agent re-registration.'),
    kind: AuthorKindSchema,
    displayName: z.string().min(1),
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
    parentId: z.string().nullable().describe('Non-null exactly when kind is "thread".'),
    slug: z.string().nullable().describe('Channels only. Unique among non-archived channels.'),
    title: z.string().min(1),
    topic: z.string().nullable(),
    workspaceId: z
      .string()
      .nullable()
      .describe('Optional workspace reference. How it resolves a cwd is out of scope for v1.'),
    rootEntryId: z
      .string()
      .nullable()
      .describe('Threads only: the parent entry this thread hangs off.'),
    archived: z.boolean(),
    createdAt: z.string(),
    lastActivityAt: z.string(),
  })
  .openapi('Room');

export type Room = z.infer<typeof RoomSchema>;

/**
 * A room as the sidebar reads it: the room plus this viewer's unread count.
 *
 * `unreadCount` is `null` when the viewer is not a member. Unread is a property
 * of a read cursor and a non-member has none — so there is no number to give,
 * and the honest answer is "not applicable" rather than the room's whole entry
 * count dressed up as an unread badge.
 */
export const RoomSummarySchema = RoomSchema.extend({
  unreadCount: z.number().int().min(0).nullable(),
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
      'Per-room override, written explicitly at join time. Seeded from the manifest for a DM, "mention-only" for a channel, inherited from the parent for a thread.'
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

/** One room with its roster — the `GET /api/rooms/:id` body. */
export const RoomWithRosterSchema = RoomSchema.extend({
  members: z.array(RoomRosterEntrySchema),
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
    signature: z.string().nullable().describe('Reserved for phase 4. Always null in v1.'),
    createdAt: z.string(),
  })
  .openapi('RoomEntry');

export type RoomEntry = z.infer<typeof RoomEntrySchema>;

// === Requests ===

export const CreateRoomRequestSchema = z
  .object({
    kind: z.enum(['channel', 'dm']).describe('Threads are created via POST /:id/threads.'),
    title: z.string().min(1).max(200).optional(),
    slug: z.string().regex(ROOM_SLUG_REGEX).optional(),
    topic: z.string().max(500).optional(),
    workspaceId: z.string().min(1).optional(),
    members: z
      .array(z.string().min(1))
      .default([])
      .describe('Author ids to seed the roster with, besides the creator.'),
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

export const CreateThreadRequestSchema = z
  .object({
    rootEntryId: z.string().min(1).describe('The parent entry this thread hangs off.'),
    title: z.string().min(1).max(200).optional(),
  })
  .openapi('CreateThreadRequest');

export type CreateThreadRequest = z.infer<typeof CreateThreadRequestSchema>;

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
