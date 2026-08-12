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
     * The author's address: what somebody types after an `@` to reach them
     * (spec `handles` §2).
     *
     * Unlike `display_name`, this IS a key, and it is the only one that reaches
     * a client. Lowercase by grammar (`@dorkos/shared/handle`), unique by index,
     * and — unlike everything else on this row except `natural_key` — **written
     * once at mint and never refreshed on resolve**. `agents` is a derived cache
     * whose reconciler rebuilds it from disk every five minutes (ADR-0043), so a
     * handle re-derived on each resolve would be silently overwritten by
     * whatever the manifest currently says, spaces included.
     *
     * Nullable, because the migration needs a legal intermediate state and
     * because "this author cannot be addressed" is an honest thing for a row to
     * say — the local human's stays null until they are asked. Never the empty
     * string: the partial unique index below permits many NULLs and exactly
     * one `''`, so the write boundary coerces empty to NULL.
     */
    handle: text('handle'),

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
     * Render cache: the URL of the author's photo, or null when they have none.
     *
     * The fourth render-cache field beside `display_name`, `emoji` and `color`,
     * and on exactly their lifecycle — refreshed on resolve, never a key, never
     * looked up by. A photo is an addition to that triplet, not a replacement:
     * an author with a photo AND an emoji keeps both, and the renderer decides
     * which one a given disc shows.
     *
     * **Source-agnostic by construction.** The column stores whatever URL the
     * avatar store handed back — today a server-relative `/api/profile/avatar/…`
     * from the local store, tomorrow an absolute `https://…` from a synced one —
     * so nothing that reads this may join a directory or assume the bytes are
     * on this machine.
     */
    imageUrl: text('image_url'),

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
    // `lower(handle)` even though the grammar already forbids uppercase. It is
    // redundant GIVEN the grammar and it costs nothing, and the redundancy is
    // the point: the constraint stops depending on every future write path
    // remembering to normalize. PARTIAL for the same reason
    // `rooms_channel_slug_unique` is — the predicate is the query. Every handle
    // lookup asks for a non-null one, and during the backfill window most rows
    // have none. NULLs coexist under it; two empty strings would not, which is
    // why the write boundary coerces `''` to NULL.
    uniqueIndex('authors_handle_unique')
      .on(sql`lower("handle")`)
      .where(sql`"handle" is not null`),
  ]
);

/**
 * A handle its author released, reserved to that author forever (spec
 * `handles` §3).
 *
 * **Renaming is already safe; reuse is the vector.** Mentions resolve once at
 * write time and store author ids, so a rename can never re-address an old
 * message. What that does not protect is the person who remembers a name:
 * `@bella-codebase` is released, somebody else claims it, and every message a
 * person addresses to the name they remember reaches a different entity.
 *
 * Three positions exist in the field. GitHub releases — immediately on a rename,
 * after 90 days on a deletion — and retires only the popular `OWNER/REPO`
 * combination rather than the login, which is how repojacking got its name and
 * why four bypasses were documented across 2021–2023. Matrix never frees a
 * handle, because no MXID rename exists at all: safe, and a bad choice is
 * permanent. A permanent reservation takes Matrix's safety without Matrix's
 * price, and it is affordable only because of scale — in a namespace of a few
 * dozen entities nobody is competing for `@bella-codebase`.
 *
 * The original author may always reclaim its own: that is the case that would
 * otherwise be infuriating, and the one `author_id` exists to answer.
 *
 * **Also the reservation table.** `everyone`, `here` and `channel` are seeded
 * here at boot, owned by the system author, because a model writes `@everyone`
 * whether or not that is our spelling for a broadcast — and an unreserved
 * `everyone` is a name an adversarial agent could claim precisely to harvest
 * broadcast-intent messages. That is not a blocklist: nothing consults a list of
 * forbidden words at any enforcement point. It is three rows under one index.
 */
export const handleTombstones = sqliteTable(
  'handle_tombstones',
  {
    /** The released handle. Lowercase by grammar — and by index, not by comment. */
    handle: text('handle').notNull(),

    /** Who released it. They, and only they, may take it back. */
    authorId: text('author_id').notNull(),

    releasedAt: text('released_at').notNull(),
  },
  (table) => [
    // NOT a bare `text().primaryKey()`, and the reason is the argument the
    // partial index above already makes. A `TEXT PRIMARY KEY` in SQLite is
    // BINARY-collated, so `Ana` and `ana` would be two distinct tombstones and
    // "already lowercased" would be enforced by a doc comment rather than by the
    // database. The two indexes are checked together on every claim, so folding
    // one and not the other would be incoherent.
    uniqueIndex('handle_tombstones_handle_unique').on(sql`lower("handle")`),
    index('idx_handle_tombstones_author').on(table.authorId),
  ]
);

/**
 * How much ambient history a new room replays to a turn, before anybody tunes it
 * (room-participation spec §8.3).
 *
 * Exported so the column default and the value {@link rooms} rows are INSERTED
 * with are the same literal spelled once: `better-sqlite3` applies a column
 * default only to a statement that omits the column, and the insert path builds
 * the row it returns to its caller, so a second number here would be a room whose
 * stored cap and reported cap disagree.
 */
export const DEFAULT_AMBIENT_MAX_ENTRIES = 30;

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

    /**
     * How many entries of ambient history reach a turn in this room at most,
     * oldest dropped first (room-participation spec §8.3).
     *
     * Per room rather than a constant, because "how much backlog is worth
     * replaying" is a property of the room: a two-person DM and a channel that
     * takes two hundred messages a day do not want the same number. 30 is the
     * default the hardcoded cap it replaced already used, so an upgrade changes
     * nothing about what any existing room shows.
     *
     * **It is a bound on what a turn reads, never a bound on the log.** Nothing
     * here trims `room_entries` — a room never forgets what was said. Dropping
     * the oldest of an over-long window is reported to the model as
     * `pendingTruncated`, so a turn always knows it is looking at a tail.
     */
    ambientMaxEntries: integer('ambient_max_entries')
      .notNull()
      .default(DEFAULT_AMBIENT_MAX_ENTRIES),

    /**
     * The stable name a room the PRODUCT depends on is found by — `'team'` for
     * the #team channel every install gets at boot — and `null` for every room
     * a person or an agent opened (team-room-home spec D3.1).
     *
     * **A second key, because the first one moves.** A channel's slug is its
     * name, and renaming one rewrites the slug with the title; a boot hook that
     * re-derived #team from `slug = 'team'` would therefore mint a second one
     * the first time somebody renamed it. This column never changes, so
     * `ensureTeamRoom` is idempotent across a rename, an archive, and a restart.
     *
     * **It is also the system-room flag**, and one column rather than two on
     * purpose: "DorkOS created this room and the product needs it" and "nothing
     * else may take its key" are the same fact. A non-null value is what makes
     * `RoomService.updateRoom` refuse a rename or an archive from anyone but
     * the owner (DOR-608's hole, closed for exactly the rooms it matters for).
     *
     * Unique, and NULL is distinct from NULL in a SQLite unique index, so every
     * ordinary room sits under it for free.
     */
    wellKnown: text('well_known'),

    /**
     * The author id holding this room's **fallback seat** — the one member that
     * answers a message a person typed without addressing anybody (#team's
     * default agent, team-room-home spec D3.4). `null` in every ordinary room.
     *
     * **Stored, rather than inferred from `response_mode = 'always'`, because
     * the mode cannot tell two different facts apart.** A person may set any
     * agent to "Everything" from the room's own member menu, and that is their
     * deliberate choice; the seat is DorkOS's, moved by the default-agent
     * setting. Reading the mode as the marker made a person's `always` stand
     * down when somebody else was named, and made the boot reconcile silently
     * revert it. One column, on the ROOM rather than the membership, so "at most
     * one seat" is true by construction instead of by a sweep — and so the
     * dispatcher gets it for free from a room it already holds, with no extra
     * query per post.
     *
     * Not a foreign key, and not cleaned up when the agent goes: an author row
     * is retired rather than deleted (`author-registry.ts`), so a stale id names
     * a member that is still on the roster and simply no longer answers. The
     * next reconcile moves it.
     */
    fallbackSeatAuthorId: text('fallback_seat_author_id'),

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
    // One room per well-known key, forever — an archive does NOT release it the
    // way it releases a slug, because the key is what a restart finds the room
    // by and a released one would let the next boot open a second #team beside
    // the archived first.
    uniqueIndex('rooms_well_known_unique').on(table.wellKnown),
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

    /**
     * The room's highest `seq` at the moment this membership was written, or 0
     * for a member who joined an empty room (room-participation spec §8.3).
     *
     * **The floor under the ambient window, and the reason it is a seq rather
     * than a timestamp.** A member who joins a channel does not retroactively
     * read what was said before they were in it, and an agent is a member — so
     * the history a turn replays starts here. Comparing integers on the primary
     * key is cheaper and less ambiguous than comparing ISO strings, and it makes
     * the clamp a `WHERE seq > ?`.
     *
     * Written once at join and never moved: it says when somebody arrived, which
     * `last_read_seq` (where they have read up to) can never answer, because
     * that column starts at 0 for everybody.
     */
    joinedSeq: integer('joined_seq').notNull().default(0),

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

    /**
     * JSON array of `{ offset, length, authorId }` — where each resolved
     * `@mention` sits in `body.text`, so the client can draw a pill over it
     * without re-parsing. One entry per written `@handle` (not deduped like
     * `mentions`), resolved in the SAME pass at write time. Defaults `'[]'` so
     * a row that predates this column reads as "no spans", never null.
     */
    mentionSpans: text('mention_spans').notNull().default('[]'),

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
    // "Which rooms has this author written in?" — `RoomStore.roomsPostedInBy`,
    // one query for a whole room list (`RoomSummary.viewerHasPosted`).
    //
    // **It leads with `author_id` because the question does.** Every other index
    // here leads with `room_id`, and none of them can answer this: the primary
    // key `(room_id, seq)` would have to scan the ENTIRE log of every room to
    // find one author's rows, and the answer that costs the most to reach is
    // exactly the one the sidebar asks on a fresh install — "no, never" is only
    // provable by looking at everything. With this index the scan is bounded by
    // what that author wrote, which for the operator of a busy install is a
    // small fraction of a channel agents fill.
    //
    // `room_id` is the second column so the index COVERS the query: the rows are
    // already grouped by author and ordered by room inside that group, so
    // `SELECT DISTINCT room_id` reads the index alone and never touches a row's
    // body. Not partial — there is no predicate to make it one, since every
    // author kind can be the subject of the question.
    //
    // **The write side is the cost, and it was accepted rather than overlooked.**
    // This is a fifth index on `room_entries`, so every message insert — the
    // hot path, inside the `seq`-allocating transaction — pays one more b-tree
    // write. Taken because the read it serves runs on every room-list request,
    // where the alternative is a full scan of the largest table in the schema.
    index('idx_room_entries_author_room').on(table.authorId, table.roomId),
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
 * One file uploaded into a room, before and after the message that carries it.
 *
 * **`entry_id` is nullable ON PURPOSE, and that is the whole design.** A file is
 * uploaded first and posted second, so between those two moments the row exists
 * with no entry to belong to. SQLite skips a foreign-key check when any column
 * of the key is NULL, which is exactly that state — and enforces it the instant
 * the row is bound, so "a bound attachment always points at a real entry" is a
 * fact the database holds rather than a convention the service remembers.
 * `createDb` turns `foreign_keys` ON, so the constraint is enforced rather than
 * decorative.
 *
 * **It hangs off `(room_id, id)`, like a reaction does**, and for the same
 * reason: the entry's ULID is the identifier that survives being talked about,
 * whereas `seq` is a position in one room's log. The composite unique index
 * `room_entries_room_id_entry_id_unique` already exists and is exactly the
 * parent key SQLite needs, so this costs no new index on the parent side.
 *
 * **`ON DELETE CASCADE`, for a delete that does not exist yet** — the same
 * bet `room_entry_reactions` makes. Nothing removes a room entry today, but the
 * design says a message's files die with it, and the honest place for that is
 * the constraint rather than a cleanup step somebody has to remember to write
 * beside a future `deleteEntry`.
 *
 * The two indexes serve the two questions asked of this table: the roll-up
 * fetches every file on a page of entries, and the staging sweep wants the
 * files nobody ever posted. The second is partial because "unbound" is the rare
 * state — a full index would carry a row per posted file to serve a lookup that
 * only ever asks for a null entry.
 *
 * **What reclaims rows here, and what does not.** Unbound rows are collected by
 * `attachments/unbound-sweep.ts` once they are a day old — a person who
 * attaches a file and closes the tab leaves bytes nobody can reach. BOUND rows
 * are reclaimed by nothing, because nothing in this product deletes a room or
 * an entry; the `ON DELETE CASCADE` above is the standing answer for entries.
 * **When room deletion arrives it must bring attachment cleanup with it** —
 * these rows and, separately, the bytes behind `RoomAttachmentStore.delete`,
 * which the cascade cannot reach.
 */
export const roomAttachments = sqliteTable(
  'room_attachments',
  {
    roomId: text('room_id').notNull(),

    /** ULID. Also the on-disk basename, and the id a post references. */
    id: text('id').notNull(),

    /**
     * The entry this file was posted with, or NULL while it is uploaded and not
     * yet posted. Bound exactly once, inside the entry's own transaction.
     */
    entryId: text('entry_id'),

    /** Who uploaded it. Only they may reference it in a post. */
    authorId: text('author_id').notNull(),

    /** The original filename, sanitized at write time. What a chip renders. */
    name: text('name').notNull(),

    /** The file suffix the bytes are stored under, without a dot. May be ''. */
    extension: text('extension').notNull(),

    /** What it is served as. Sniffed for an image, else the declared type. */
    mimeType: text('mime_type').notNull(),

    size: integer('size').notNull(),

    /** `'image'` when the bytes were VERIFIED previewable, else NULL. */
    preview: text('preview'),

    /**
     * Where to fetch the bytes — **whatever `RoomAttachmentStore.put` answered**,
     * stored verbatim and never rebuilt.
     *
     * This column is what makes the store a real seam rather than a shape. The
     * local store answers a server-relative `/api/rooms/…` that a reader could
     * in principle reconstruct from the two ids; a bucket-backed one answers an
     * absolute `https://…` that nothing could. Recomputing the URL on read would
     * therefore work today and silently break the day the bytes move, which is
     * precisely the day the seam exists for. Same reasoning, same shape as the
     * identity render cache storing `imageUrl` from `AvatarStore.put`
     * (ADR 260806-222546).
     *
     * **The `''` default exists for the migration, not for the model.** SQLite
     * refuses `ADD COLUMN ... NOT NULL` without one on any table that already
     * holds rows, so without it migration 0059 would fail outright for anyone
     * who had applied 0058 and stored a file. Nothing writes an empty url: the
     * upload route always has one from `RoomAttachmentStore.put` before the row
     * is created.
     */
    url: text('url').notNull().default(''),

    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.id] }),
    index('idx_room_attachments_entry').on(table.roomId, table.entryId),
    index('idx_room_attachments_unbound')
      .on(table.roomId, table.createdAt)
      .where(sql`"entry_id" IS NULL`),
    foreignKey({
      columns: [table.roomId, table.entryId],
      foreignColumns: [roomEntries.roomId, roomEntries.id],
      name: 'room_attachments_entry_fk',
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
 *
 * The primary key answers "which session does this member use here?". The
 * session-origin overlay asks the OPPOSITE question — "did a room start this
 * session?" — and the primary key cannot serve it, so `session_id` carries its
 * own index. That read runs on every session list a person loads AND on every
 * `session_upserted` the global stream fans out, one row at a time and
 * synchronously on the write path, so an unindexed scan of every binding on the
 * machine sat behind each broadcast (DOR-1141 review).
 */
export const roomSessions = sqliteTable(
  'room_sessions',
  {
    roomId: text('room_id').notNull(),
    authorId: text('author_id').notNull(),
    sessionId: text('session_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.authorId] }),
    index('idx_room_sessions_session').on(table.sessionId),
  ]
);
