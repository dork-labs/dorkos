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

    /**
     * Render cache: the author's emoji avatar (`agents.icon` for an agent), or
     * null when it has none. Same lifecycle as `display_name` — refreshed on
     * resolve, never the key, and never looked up by.
     */
    emoji: text('emoji'),

    /**
     * Render cache: the author's identity colour (`agents.color`), or null.
     * Same lifecycle as `display_name`.
     */
    color: text('color'),

    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('authors_kind_natural_key_unique').on(table.kind, table.naturalKey)]
);

/**
 * A membership-scoped durable stream: a channel or a DM (ADR 260726-170125).
 *
 * **There is no third kind, and there is no room hierarchy.** A thread is a
 * relation between entries in ONE room's log, carried by
 * `room_entries.parent_entry_id` / `thread_root_entry_id`
 * (ADR 260728-022013) — never a child room. `parent_id`, `root_entry_id` and
 * `idx_rooms_parent_id` were the child-room shape and retired in migration
 * 0038, which moved any surviving thread room's entries into its parent.
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

    /** `'channel' | 'dm'`. */
    kind: text('kind').notNull(),

    /** Channels only. Unique among non-archived channels. */
    slug: text('slug'),

    title: text('title').notNull(),
    topic: text('topic'),

    /**
     * Optional workspace reference. Stored and returned in v1; how it composes
     * with the agent-workspace-binding precedence chain is that spec's business.
     */
    workspaceId: text('workspace_id'),

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
 * time — seeded from the manifest for a DM and `'mention-only'` for a channel —
 * so the stored value is inspectable and there is no dynamic rule to reason
 * about later. There is no third seed: a thread is a position inside a channel,
 * so a reply there reads the channel's row (ADR 260728-022013).
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
 *
 * `parent_entry_id` / `thread_root_entry_id` are the thread relation
 * (ADR 260728-022013). A thread is a set of entries in THIS room pointing at a
 * common root; it is not a room, has no roster of its own, and never appears in
 * a room list. The default timeline is `WHERE parent_entry_id IS NULL`.
 *
 * **Two columns, because they answer two questions.** `thread_root_entry_id` is
 * the SCOPE — one indexed column every thread query filters on, so counting a
 * thread's replies, and later narrowing the engaged window or the history tools
 * to a thread (room-participation spec §3.2, §3.3), is one predicate rather than
 * a recursive walk. `parent_entry_id` is the RELATION — which entry this one
 * answers. Keeping it is how the schema stops having a vote on nesting: the
 * one-level rule is a service policy (`RoomService.post` refuses a reply whose
 * root is itself a reply) rather than a shape the table has already decided, and
 * a future ADR that opens a second level changes an `if` and no migration. While
 * that policy holds the two columns coincide on every row, which is the expected
 * state and not redundancy waiting to be collapsed.
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

    /** The entry this one answers, in this same room. Null for a top-level entry. */
    parentEntryId: text('parent_entry_id'),

    /**
     * The entry at the head of this entry's thread, in this same room. Null for
     * a top-level entry — including for a root that has replies, so a thread's
     * reply count is `COUNT(*)` over this column and never counts the root.
     */
    threadRootEntryId: text('thread_root_entry_id'),

    /** Reserved for phase 4 message signing. Always null in v1. */
    signature: text('signature'),

    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.seq] }),
    uniqueIndex('room_entries_room_id_entry_id_unique').on(table.roomId, table.id),
    index('idx_room_entries_cascade_root').on(table.roomId, table.cascadeRoot),
    // PARTIAL, like `rooms_channel_slug_unique` above and for the same reason:
    // the predicate is the query. Every thread read asks for a NON-NULL root
    // (`WHERE room_id = ? AND thread_root_entry_id = ?`), and in a channel that
    // is a small minority of rows, so a full index would carry one entry per
    // ordinary message to serve a lookup that never asks for them. The opposite
    // half — the default timeline's `parent_entry_id IS NULL` — is deliberately
    // NOT indexed: it is a residual filter on a `(room_id, seq)` range the
    // primary key already serves, and an index whose predicate matches most of
    // the table saves nothing.
    index('idx_room_entries_thread_root')
      .on(table.roomId, table.threadRootEntryId)
      .where(sql`"thread_root_entry_id" IS NOT NULL`),
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
