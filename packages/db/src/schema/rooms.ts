import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core';

/**
 * Everyone who can post: a human, an agent, or the system (spec `rooms` §2,
 * ADR 260726-170126).
 *
 * `id` is opaque and minted once. It is what every other table stores, and it
 * is deliberately NOT the agent manifest's ULID: `agents` is a derived cache
 * (ADR-0043) whose reconciler may rebuild a row under a fresh ULID, so a
 * manifest id names an agent well enough to address it today and not well
 * enough to attribute a message to it forever.
 *
 * `natural_key` is what survives that rebuild — for an agent, its `agentPath`
 * (`agents.project_path` is already `NOT NULL UNIQUE`, so it is genuinely
 * unique); for the local human, `'local'`; for the room's own voice,
 * `'system'`. Resolution is mint-on-first-use: look up `(kind, natural_key)`,
 * insert when absent, return `id`.
 *
 * `display_name` is a render cache, refreshed on every resolve. It is never
 * the key, and nothing may look an author up by it.
 */
export const authors = sqliteTable(
  'authors',
  {
    /** Opaque author id (ULID). The only author identifier that reaches the wire. */
    id: text('id').primaryKey(),

    /** `'human' | 'agent' | 'system'`. */
    kind: text('kind').notNull(),

    /**
     * The stable identity behind the id: an agent's `agentPath`, a human's
     * local account key, or `'system'`. Server-side only — a shared room must
     * not carry a home-directory path to its members.
     */
    naturalKey: text('natural_key').notNull(),

    /** Human-readable name, cached for rendering and refreshed on resolve. */
    displayName: text('display_name').notNull(),

    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('authors_kind_natural_key_unique').on(table.kind, table.naturalKey)]
);

/**
 * A membership-scoped durable stream: a channel, a DM, or a thread
 * (ADR 260726-170125).
 *
 * A thread is a room with a `parent_id`, one level only — creating a thread off
 * a thread is refused at the service boundary rather than silently flattened,
 * so the "N replies" summary row is a projection of a child room's log and not
 * a second conversation model.
 *
 * A room is not a session. Three agents in a room are three sessions posting
 * onto one stream, each keeping its own runtime binding (ADR-0255), which is
 * what makes a mixed-runtime room possible at all.
 */
export const rooms = sqliteTable(
  'rooms',
  {
    /** ULID. */
    id: text('id').primaryKey(),

    /** `'channel' | 'dm' | 'thread'`. */
    kind: text('kind').notNull(),

    /** Non-null exactly when `kind = 'thread'`. */
    parentId: text('parent_id'),

    /** Channels only. Unique among non-archived channels. */
    slug: text('slug'),

    title: text('title').notNull(),
    topic: text('topic'),

    /**
     * Optional workspace reference. Stored and returned in v1; how it composes
     * with the agent-workspace-binding precedence chain is that spec's business.
     */
    workspaceId: text('workspace_id'),

    /** Threads only: the parent entry this thread hangs off. */
    rootEntryId: text('root_entry_id'),

    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    lastActivityAt: text('last_activity_at').notNull(),
  },
  (table) => [
    // Partial unique index: an archived channel releases its slug for reuse,
    // while two live `#general`s stay impossible. The predicate is raw SQL
    // because that is what a partial index takes.
    uniqueIndex('rooms_channel_slug_unique')
      .on(table.slug)
      .where(sql`"kind" = 'channel' AND "archived" = 0`),
    index('idx_rooms_parent_id').on(table.parentId),
  ]
);

/**
 * One author's binding to one room — where per-room state lives.
 *
 * `last_read_seq` **is** the `(member, room)` read cursor: not per client, not
 * per session, not `localStorage`. The unread divider reads it.
 *
 * `response_mode` is the per-room override of the agent manifest's default
 * (`AgentBehaviorSchema.responseMode`). It is always written explicitly at join
 * time — seeded from the manifest for a DM, `'mention-only'` for a channel,
 * inherited from the parent for a thread — so the stored value is inspectable
 * and there is no dynamic rule to reason about later.
 */
export const roomMembers = sqliteTable(
  'room_members',
  {
    roomId: text('room_id').notNull(),
    authorId: text('author_id').notNull(),

    /** `'always' | 'direct-only' | 'mention-only' | 'silent'`. */
    responseMode: text('response_mode').notNull(),

    joinedAt: text('joined_at').notNull(),

    /** The `(member, room)` read cursor — the highest `seq` this member has seen. */
    lastReadSeq: integer('last_read_seq').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.roomId, table.authorId] })]
);

/**
 * The durable, append-only room log.
 *
 * **There is no trim.** Unlike the in-memory `EventLog` (capped at 5000, oldest
 * evicted) and `session_events` (trimmed to the same cap per session), a room
 * never discards an entry — a room that forgets what was said is not a room.
 * Retention, if it is ever wanted, is a product decision with its own spec.
 *
 * `seq` is per-room and monotonic, allocated inside the insert transaction with
 * `SELECT COALESCE(MAX(seq),0)+1 ... WHERE room_id = ?`. The transaction must
 * be IMMEDIATE: a deferred one takes a read lock for that SELECT and then fails
 * to upgrade it if another writer got there first, which SQLite reports as
 * `SQLITE_BUSY_SNAPSHOT` and does not retry. With IMMEDIATE the writer lock is
 * taken up front, `busy_timeout` does its job, and no counter table is needed.
 *
 * `cascade_root` / `cascade_depth` are the provenance the cascade guard reads
 * (ADR 260726-170127). A human's post always starts fresh — its own id at depth
 * 0 — so a person can always re-engage a room the guard has stopped.
 */
export const roomEntries = sqliteTable(
  'room_entries',
  {
    roomId: text('room_id').notNull(),

    /** Per-room monotonic sequence, allocated in-transaction. */
    seq: integer('seq').notNull(),

    /** Stable entry id (ULID) — what a reaction would attach to. */
    id: text('id').notNull(),

    authorId: text('author_id').notNull(),

    /** `'post' | 'notice'`. */
    kind: text('kind').notNull(),

    /** JSON `RoomEntryBody`. */
    body: text('body').notNull(),

    /** JSON array of author ids, resolved from `@name` once at write time. */
    mentions: text('mentions').notNull().default('[]'),

    /** The session that produced this entry, if any. */
    sessionId: text('session_id'),

    /** Entry id that began this cascade — the entry's own id at depth 0. */
    cascadeRoot: text('cascade_root').notNull(),

    cascadeDepth: integer('cascade_depth').notNull().default(0),

    /** Reserved for phase 4 message signing. Always null in v1. */
    signature: text('signature'),

    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.seq] }),
    uniqueIndex('room_entries_room_id_entry_id_unique').on(table.roomId, table.id),
    index('idx_room_entries_cascade_root').on(table.roomId, table.cascadeRoot),
  ]
);

/**
 * The session an agent member uses when it answers in this room.
 *
 * Three agents in a room means three rows here — three sessions on one stream,
 * each keeping its own runtime binding (ADR-0255). One row per `(room, author)`
 * is the point: an agent's context in `#backend` is not its context in a DM,
 * and conflating them would make a room a session by the back door.
 */
export const roomSessions = sqliteTable(
  'room_sessions',
  {
    roomId: text('room_id').notNull(),
    authorId: text('author_id').notNull(),
    sessionId: text('session_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.roomId, table.authorId] })]
);
