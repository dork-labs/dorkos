/**
 * Reading the message index — the ONE search path over these rows
 * (message-search spec §4 and §6.1, room-participation spec §10.3 as amended by
 * DOR-672).
 *
 * It is deliberately one function rather than one per caller: the amendment that
 * sent `search_room_history` here rather than letting it scan `body.text` itself
 * gives the reason in one line — **two search paths over the same rows is the
 * tolerated legacy pattern the codebase refuses.** They would answer the same
 * question differently (one matching infixes, the other matching stems) and the
 * difference would be invisible until somebody compared them. The person-facing
 * `GET /api/search` calls this too, through `search-service.ts`.
 *
 * ## What it returns, and what it does not
 *
 * Coordinates, the row's own facts, and optionally an excerpt: which container,
 * which ordinal, who said it, when, and the matching words in their sentence.
 * Not entries — resolving a coordinate back to a message is the OWNING store's
 * job, and it has to be, because the index holds a copy of the text and none of
 * the access rules. `RoomService` applies membership, the join floor and the
 * thread filter to the rows it resolves; the index is queried inside a scope it
 * is handed, never trusted to enforce one. A room id is not a capability, and
 * neither is a query string.
 *
 * ## The scope is per container, and that is the whole access model
 *
 * A caller hands in {@link SourceScope}s. Each is either **every container of
 * one source** — which is what the owner gets, and which OMITS the clause rather
 * than enumerating every room on the machine — or an explicit list of containers
 * with **a floor each**. Per container rather than one floor for the whole
 * query, because a member joins different rooms at different points: a single
 * global floor either leaks what was said before they arrived in a room they
 * joined late, or hides what they are entitled to in a room they joined early.
 *
 * **Every scope names its source.** `origin_key` is opaque and composed per
 * source (spec §4), so it is unique WITHIN a source and carries no guarantee
 * across sources; a bare `origin_key IN (...)` would let a room key collide with
 * a session key and hand a session row to an agent.
 *
 * ## Two honest limits
 *
 * **It matches word stems, not substrings.** `porter unicode61` finds `dog`,
 * `dogs` and `DOGGED` for a search for `dogs`, and finds nothing at all for
 * `ogs`. That is better for the question anybody actually asks and worse for one
 * specific trick, and every caller's own documentation says so rather than
 * leaving it to be discovered.
 *
 * ## One word of SQL is load-bearing: `CROSS JOIN`
 *
 * It is a **join-order directive**, not a different join — it forbids SQLite from
 * reordering, and the order it forbids is the one the planner picks by default on
 * a NARROW scope. With a single container in the visibility clause the planner
 * believes `messages` is the selective side: it drives from the covering index
 * `(source_id, origin_key, ordinal)` and probes FTS5 once per row, which is a
 * full scan of that room dressed as an index lookup. Measured on a 40,000-row
 * index with one room in scope, term `the`: **7,786 ms as a plain `JOIN`, 4.5 ms
 * with the directive** — and the owner path unchanged at 10.3 → 10.2 ms, because
 * the FTS-driven order was already right there.
 *
 * The FTS-driven order is right for EVERY scope shape, since `MATCH` is the only
 * predicate here with an index that answers it; the visibility clause is a filter
 * over what it returns. DorkOS never runs `ANALYZE`, so the planner has no
 * statistics with which to reach that conclusion itself.
 *
 * This is not a new problem introduced by the search route: `search_room_history`
 * has been on the slow plan since DOR-680, because a single room is exactly the
 * narrow scope that triggers it. Both callers share this function, so both are
 * fixed by this word.
 *
 * **It is as fresh as the last sweep.** The indexer reconciles on
 * {@link SEARCH_RECONCILE_INTERVAL_MS} (five minutes), so something said a minute
 * ago may not be findable yet. Nothing here hides that; the tool that calls it
 * tells the agent to read the recent log instead when it wants the last few
 * messages.
 *
 * @module server/services/search/query
 */
import { sql, type Db, type SQL } from '@dorkos/db';
import { searchTokens } from '@dorkos/shared/search-schemas';

/** One hit, as a coordinate the owning store resolves. */
export interface MessageHit {
  /** Which source the row came from — `'rooms'`, `'claude-code'`. */
  sourceId: string;
  /** The opaque container id the projection composed — a room id, a session id. */
  originKey: string;
  /** Position within that container. `room_entries.seq` for a room. */
  ordinal: number;
  /**
   * The message's own id in the store that owns it, or `null` when it has none
   * — a room, or a transcript record that carried no id (DOR-1579).
   *
   * A second coordinate, and a finer one: `ordinal` addresses the container's
   * position, this addresses the message. `null` is the honest answer and never
   * an error — it means a hit opens its conversation rather than its message.
   */
  messageId: string | null;
  /** Who said it. */
  role: 'user' | 'assistant';
  /** ISO-8601, or `null` for a source that records none. */
  createdAt: string | null;
  /**
   * The matching words in their sentence, marked — or `null` when the caller did
   * not ask for one.
   *
   * TEXT rather than HTML: `<mark>` and `</mark>` are the only markup, and
   * everything around them is whatever was typed.
   */
  excerpt: string | null;
}

/**
 * One container the caller may read, and the position it may read from.
 *
 * Not exported: it is a member of {@link SourceScope} and every caller builds one
 * as an object literal, so an export would be a name nothing says.
 */
interface ContainerScope {
  /** The opaque container id. */
  originKey: string;
  /**
   * Ignore hits at or below this ordinal in THIS container.
   *
   * A room member's `joinedSeq`, so an index-backed search cannot become the
   * fast, ranked backlog reader the room-participation amendment warned about.
   * Applied inside the query rather than after it, because a floor applied after
   * the `LIMIT` would silently return fewer results than asked for and look like
   * a ranking quirk.
   */
  afterOrdinal?: number;
}

/** What one source contributes to a query, and how much of it the caller may see. */
export type SourceScope =
  | {
      sourceId: string;
      /**
       * Every container of this source, with no container clause at all.
       *
       * The owner's path. Building a set of every container instead would be a
       * filter that has to enumerate everything, and a filter that has to
       * enumerate everything silently starts excluding things the day
       * enumeration misses one (spec §6.1).
       */
      visibility: 'all';
    }
  | {
      sourceId: string;
      /** Only these containers, each above its own floor. */
      visibility: 'containers';
      containers: readonly ContainerScope[];
    };

/** What to search, and how much of the answer to bring back. */
export interface MessageQuery {
  /**
   * The sources this caller may read, and what part of each.
   *
   * An empty array matches nothing, and so does a `'containers'` scope with an
   * empty list — the honest answer for a caller who is in no rooms.
   */
  scopes: readonly SourceScope[];
  /** What the caller typed. Tokenized before it reaches FTS5; see {@link toMatchExpression}. */
  query: string;
  /** The most hits to return, best first. */
  limit: number;
  /**
   * Ask for the marked excerpt — `snippet()` over the matched row.
   *
   * Off by default because it is the dominant per-row cost of this query
   * (measured at 5–9× the bare fetch, spec §6.3), and the caller that resolves
   * every hit back to a real message through its own store — `search_room_history`
   * — would pay it and throw the result away.
   */
  excerpts?: boolean;
}

/**
 * Search the index inside a scope the caller has already resolved.
 *
 * @param db - The database holding the index.
 * @param query - What to search and how much to bring back.
 * @returns The hits, best first. Empty when the query has no searchable word in
 *   it, when the scope is empty, or when nothing matches.
 */
export function searchMessages(db: Db, query: MessageQuery): MessageHit[] {
  const match = toMatchExpression(query.query);
  if (match === null || query.limit <= 0) return [];

  const scopes = query.scopes
    .map(scopePredicate)
    .filter((clause): clause is SQL => clause !== null);
  if (scopes.length === 0) return [];
  const visible = sql.join(scopes, sql` OR `);

  const excerpt = query.excerpts
    ? // The column index is 0 because `messages_fts` has exactly one indexed
      // column, `body`. Its NAME is what makes this work at all: with
      // `content='messages'` FTS5 re-reads the original text from the content
      // table by column name, and a mismatch fails here — and only here — with
      // `SQL logic error`, while MATCH and bm25() keep working.
      sql`snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12)`
    : sql`NULL`;

  // `bm25()` is ascending-best in FTS5, so this is a plain ORDER BY rather than a
  // DESC on a score somebody inverted.
  const rows = db.all<{
    source_id: string;
    origin_key: string;
    ordinal: number;
    message_id: string | null;
    role: string;
    created_at: string | null;
    excerpt: string | null;
  }>(sql`
    SELECT m.source_id AS source_id, m.origin_key AS origin_key, m.ordinal AS ordinal,
           m.message_id AS message_id, m.role AS role, m.created_at AS created_at,
           ${excerpt} AS excerpt
    FROM messages_fts f
    -- CROSS JOIN is a join-order DIRECTIVE, not a different join. See the
    -- module doc: without it a narrow scope runs 1,700x slower.
    CROSS JOIN messages m ON m.id = f.rowid
    WHERE messages_fts MATCH ${match}
      AND (${visible})
    ORDER BY bm25(messages_fts)
    LIMIT ${query.limit}
  `);
  return rows.map((row) => ({
    sourceId: row.source_id,
    originKey: row.origin_key,
    ordinal: row.ordinal,
    messageId: row.message_id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    createdAt: row.created_at,
    excerpt: row.excerpt,
  }));
}

/**
 * One source's half of the visibility clause, or `null` when it can match
 * nothing.
 *
 * Containers are **grouped by floor** rather than emitted one predicate each: a
 * caller in forty rooms who joined thirty-nine of them at the beginning is two
 * `IN (...)` lists, not forty `OR`s. Every group keeps `source_id` beside
 * `origin_key` for the reason the module doc gives.
 */
function scopePredicate(scope: SourceScope): SQL | null {
  if (scope.visibility === 'all') return sql`m.source_id = ${scope.sourceId}`;

  const byFloor = new Map<number, string[]>();
  for (const container of scope.containers) {
    const floor = container.afterOrdinal ?? 0;
    const keys = byFloor.get(floor);
    if (keys) keys.push(container.originKey);
    else byFloor.set(floor, [container.originKey]);
  }
  if (byFloor.size === 0) return null;

  const groups = [...byFloor].map(
    ([floor, keys]) =>
      sql`(m.origin_key IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `
      )}) AND m.ordinal > ${floor})`
  );
  return sql`(m.source_id = ${scope.sourceId} AND (${sql.join(groups, sql` OR `)}))`;
}

/**
 * Turn what somebody typed into an FTS5 `MATCH` expression that cannot be a
 * syntax error.
 *
 * **Every word becomes a quoted phrase, and the words are ANDed.** FTS5's query
 * language has operators (`AND`, `OR`, `NOT`, `NEAR`, `*`, `^`, column filters)
 * and a string carrying an unbalanced quote or a stray `NEAR` is not a bad search
 * — it is a `SQL logic error` thrown at the caller. Since the caller here is a
 * model writing a search box's worth of words, the honest handling is to treat
 * the whole input as words. Quoting is what makes that total: inside double
 * quotes FTS5 reads a bare string, and doubling any quote the input contained is
 * the whole escape.
 *
 * @param raw - What the caller typed.
 * @returns The `MATCH` expression, or `null` when the input holds no word at all.
 */
function toMatchExpression(raw: string): string | null {
  // `searchTokens` rather than a regex of its own, and that is the whole point of
  // it living in `@dorkos/shared`: the route refuses a query whose longest WORD is
  // below the minimum, and a second splitter here would let the two disagree about
  // what a word is — which is exactly how `a,` came to be a two-character query
  // that ran a one-letter search.
  const words = searchTokens(raw);
  if (words.length === 0) return null;
  return words.map((word) => `"${word.replaceAll('"', '""')}"`).join(' ');
}
