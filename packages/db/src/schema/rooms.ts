import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
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
 *
 * `minted_for_manifest_id` **partially supersedes** that ADR's "the ULID is
 * never written into an author column" clause (ADR 260801-003051), and the
 * distinction it draws is narrow: the directory is still the identity key, and
 * the stamp only says WHICH occupant of that directory a row was minted for. It
 * exists because the inverse of the moved-agent case was unhandled — registering
 * a NEW agent in a previously-occupied directory silently inherited the previous
 * agent's entire message history. The clause's premise (a reconciler rebuild
 * re-minting ids) is unreachable in current code: no reconciler path mints, and
 * an ADR-0043 rebuild reads ids back from the files that store them. The one
 * event that changes a manifest id — re-initializing it — is exactly the
 * generation boundary this stamp detects.
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

    /**
     * The manifest ULID of the occupant this row was minted for, or null on a
     * legacy row minted before the stamp existed (which adopts the current
     * occupant the next time it resolves, and never retires on its own).
     *
     * Agent rows only — a human has no manifest to stamp.
     */
    mintedForManifestId: text('minted_for_manifest_id'),

    /**
     * When this row stopped being the active author for its directory, or null
     * while it still is. A retired row keeps its id, its history and its
     * memberships forever; it simply stops claiming handles and receiving turns.
     */
    retiredAt: text('retired_at'),

    createdAt: text('created_at').notNull(),
  },
  (table) => [
    // Partial: one ACTIVE author per directory, and any number of retired ones.
    // A directory that changes hands retires its author and mints a fresh one
    // (ADR 260801-003051), so the pair has to be able to coexist — while two
    // live authors for one directory stay impossible. The predicate is raw SQL
    // because that is what a partial index takes.
    uniqueIndex('authors_kind_natural_key_unique')
      .on(table.kind, table.naturalKey)
      .where(sql`"retired_at" is null`),
  ]
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
 * time — seeded from the manifest for a DM and `'engaged'` for a channel — so
 * the stored value is inspectable and there is no dynamic rule to reason about
 * later. There is no third seed: a thread is a position inside a channel, so a
 * reply there reads the channel's row (ADR 260728-022013).
 *
 * **The column stores no provenance**, which is why migration 0039 could rewrite
 * `'mention-only'` to `'engaged'` for agent memberships in LIVE channels once
 * and can never do it again: it cannot tell a seeded default from a value
 * somebody chose. It was safe only because the members panel that first exposed
 * the field shipped one day earlier (room-participation spec §9.4).
 *
 * ARCHIVED channels were deliberately skipped, so their rows still read
 * `'mention-only'`. An archived room refuses its own voice, so it could not be
 * given the notice every widened room got — and widening what cannot be
 * announced is the one thing §9.4 forbids.
 */
export const roomMembers = sqliteTable(
  'room_members',
  {
    roomId: text('room_id').notNull(),
    authorId: text('author_id').notNull(),

    /** `'always' | 'engaged' | 'direct-only' | 'mention-only' | 'silent'`. */
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
    //
    // **`seq` IS THE THIRD COLUMN BECAUSE OF THE PLANNER, NOT BECAUSE OF THE
    // FILTER** (migration 0040). `listRecentPostsByOthers` asks for the NEWEST
    // few rows of a thread, so it carries `ORDER BY seq DESC LIMIT n` — and
    // against the two-column index that ordering could only be satisfied by
    // sorting the matches, which made the `(room_id, seq)` primary key look
    // cheaper to a planner with no statistics. Nothing in DorkOS runs `ANALYZE`,
    // so "no statistics" IS the shipped state: the planner took the primary key
    // and, for a thread holding fewer rows than the limit, walked the room's
    // ENTIRE log before giving up. Measured on a 50k-entry channel: 5.5ms per
    // call against 0.0025ms with `seq` here, and the query runs once per engaged
    // agent per message. With `seq` in the index the planner needs no statistics
    // and no hint — it reads the rows in order and stops at the limit.
    index('idx_room_entries_thread_root')
      .on(table.roomId, table.threadRootEntryId, table.seq)
      .where(sql`"thread_root_entry_id" IS NOT NULL`),
  ]
);

/**
 * One person, one emoji, one entry (spec `room-messaging-design` §2).
 *
 * **The primary key IS the toggle.** `(room_id, entry_id, author_id, emoji)` is
 * unique by construction, so "react twice with the same emoji" cannot mean two
 * rows — it means delete the one that is there. The service does not have to
 * read before it writes, and two clients double-firing one click cannot leave a
 * pill counted twice.
 *
 * **It hangs off `(room_id, id)`, not off `(room_id, seq)`.** The entry's ULID
 * is the identifier that survives being talked about — a client holds it, a
 * reaction event names it, and the room-context acknowledgment points at it —
 * whereas `seq` is a position in one room's log. The composite unique index
 * `room_entries_room_id_entry_id_unique` already exists and is exactly the
 * parent key SQLite needs, so this costs no new index on the parent side.
 *
 * **`ON DELETE CASCADE`, for a delete that does not exist yet.** Nothing removes
 * a room entry today — the log is append-only and never trimmed. The design says
 * reactions on a deleted message die with it (§4), and the honest place to put
 * that is the constraint rather than a cleanup step somebody has to remember to
 * write beside a future `deleteEntry`. `createDb` turns `foreign_keys` ON, so it
 * is enforced rather than decorative.
 *
 * **`author_id` is not constrained to a human**, and that is deliberate rather
 * than an opening. Agents do not send reactions — no route accepts one, and
 * `RoomService.toggleReaction` refuses a non-human author (etiquette E16b). That
 * gate lives in the service because it is a conduct decision, and conduct
 * decisions get revisited; a column that had already decided would have to be
 * migrated on the day one is. What the schema decides is only that a reaction
 * has an author.
 *
 * The second index serves the quick row: a person's most-used emoji is
 * `GROUP BY emoji` over their own rows, across every room, which
 * `(author_id, emoji)` answers without a sort. The primary key cannot — it leads
 * with `room_id`, and the quick row is not a room's business.
 */
export const roomEntryReactions = sqliteTable(
  'room_entry_reactions',
  {
    roomId: text('room_id').notNull(),

    /** The `room_entries.id` ULID this reaction sits on. */
    entryId: text('entry_id').notNull(),

    /** Who reacted. A human today; see this table's doc for why the column is not narrower. */
    authorId: text('author_id').notNull(),

    /**
     * The emoji, stored as the string that was sent — a grapheme cluster, so a
     * ZWJ sequence, a flag or a skin tone survives verbatim. Never an enum:
     * adding a face must not take a migration.
     */
    emoji: text('emoji').notNull(),

    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.entryId, table.authorId, table.emoji] }),
    index('idx_room_entry_reactions_author').on(table.authorId, table.emoji),
    foreignKey({
      columns: [table.roomId, table.entryId],
      foreignColumns: [roomEntries.roomId, roomEntries.id],
      name: 'room_entry_reactions_entry_fk',
    }).onDelete('cascade'),
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
