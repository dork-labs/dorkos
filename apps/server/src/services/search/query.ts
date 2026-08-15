/**
 * Reading the message index — the ONE search path over these rows
 * (message-search spec §4, room-participation spec §10.3 as amended by DOR-672).
 *
 * The index itself has shipped; until now nothing read it. This is the read, and
 * it is deliberately one function rather than one per caller: the amendment that
 * sent `search_room_history` here rather than letting it scan `body.text` itself
 * gives the reason in one line — **two search paths over the same rows is the
 * tolerated legacy pattern the codebase refuses.** They would answer the same
 * question differently (one matching infixes, the other matching stems) and the
 * difference would be invisible until somebody compared them. The operator's own
 * search box, when it lands, calls this too.
 *
 * ## What it returns, and what it does not
 *
 * Coordinates: which container, which ordinal, ranked by relevance. Not entries —
 * resolving a coordinate back to a message is the OWNING store's job, and it has
 * to be, because the index holds a copy of the text and none of the access rules.
 * `RoomService` applies membership, the join floor and the thread filter to the
 * rows it resolves; the index is queried inside a scope it is handed, never
 * trusted to enforce one. A room id is not a capability, and neither is a query
 * string.
 *
 * ## Two honest limits
 *
 * **It matches word stems, not substrings.** `porter unicode61` finds `dog`,
 * `dogs` and `DOGGED` for a search for `dogs`, and finds nothing at all for
 * `ogs`. That is better for the question anybody actually asks and worse for one
 * specific trick, and every caller's own documentation says so rather than
 * leaving it to be discovered.
 *
 * **It is as fresh as the last sweep.** The indexer reconciles on
 * {@link SEARCH_RECONCILE_INTERVAL_MS} (five minutes), so something said a minute
 * ago may not be findable yet. Nothing here hides that; the tool that calls it
 * tells the agent to read the recent log instead when it wants the last few
 * messages.
 *
 * @module server/services/search/query
 */
import { sql, type Db } from '@dorkos/db';

/** One hit, as a coordinate the owning store resolves. */
export interface MessageHit {
  /** The opaque container id the projection composed — a room id, today. */
  originKey: string;
  /** Position within that container. `room_entries.seq` for a room. */
  ordinal: number;
}

/** What to search, and how much of the answer to bring back. */
export interface MessageQuery {
  /** Which source's rows to search — `'rooms'` today. */
  sourceId: string;
  /** The containers the caller is allowed to see. An empty list matches nothing. */
  originKeys: readonly string[];
  /** What the caller typed. Tokenized before it reaches FTS5; see {@link toMatchExpression}. */
  query: string;
  /** The most hits to return, best first. */
  limit: number;
  /**
   * Ignore hits at or below this ordinal in every container searched.
   *
   * The room history tool passes a member's `joinedSeq`, so an index-backed
   * search cannot become the fast, ranked backlog reader the amendment warned
   * about. Applied HERE rather than after the fact because a floor applied after
   * the limit would silently return fewer results than asked for and look like a
   * ranking quirk.
   */
  afterOrdinal?: number;
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
  if (match === null || query.originKeys.length === 0 || query.limit <= 0) return [];

  const scope = sql.join(
    query.originKeys.map((key) => sql`${key}`),
    sql`, `
  );
  const floor = query.afterOrdinal ?? 0;
  // `bm25()` is ascending-best in FTS5, so this is a plain ORDER BY rather than a
  // DESC on a score somebody inverted.
  const rows = db.all<{ origin_key: string; ordinal: number }>(sql`
    SELECT m.origin_key AS origin_key, m.ordinal AS ordinal
    FROM messages_fts f
    JOIN messages m ON m.id = f.rowid
    WHERE messages_fts MATCH ${match}
      AND m.source_id = ${query.sourceId}
      AND m.origin_key IN (${scope})
      AND m.ordinal > ${floor}
    ORDER BY bm25(messages_fts)
    LIMIT ${query.limit}
  `);
  return rows.map((row) => ({ originKey: row.origin_key, ordinal: row.ordinal }));
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
  const words = raw
    .split(/[^\p{L}\p{N}_]+/u)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  if (words.length === 0) return null;
  return words.map((word) => `"${word.replaceAll('"', '""')}"`).join(' ');
}
