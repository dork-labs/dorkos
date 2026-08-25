/**
 * One question — "where did we talk about X" — answered only for whoever may see
 * it (message-search spec §6.1 and §7).
 *
 * This is the whole of the read side above the SQL: it turns a caller's resolved
 * scope into {@link SourceScope}s, runs the one ranked query, joins the working
 * directory each hit opens in, and reports any source that is behind. It never
 * resolves a caller itself and never asks who anybody is — the route does that,
 * through the rooms domain that already owns the answer, and hands the result
 * here as data.
 *
 * ## Two rules this module exists to keep
 *
 * **The owner's clause is absent, not exhaustive.** A caller who may see every
 * room gets `visibility: 'all'` — no container list at all. Building one would
 * be a filter that has to enumerate everything, which silently starts excluding
 * things the day enumeration misses one.
 *
 * **A source nobody has scoped is owner-only.** {@link buildScopes} knows one
 * source by name, `rooms`; every other registered source is treated as session
 * history and reached only by the operator. So Codex arriving as a third
 * registry row is invisible to agents on the day it lands rather than on the day
 * somebody remembers, which is the direction a default has to fail in.
 *
 * @module server/services/search/search-service
 */
import { searchSources as searchSourcesTable, and, eq, isNotNull, sql, type Db } from '@dorkos/db';
import {
  SEARCH_MAX_LIMIT,
  type SearchHit,
  type SearchResponse,
  type SearchSourceWarning,
} from '@dorkos/shared/search-schemas';
import { searchMessages, type SourceScope } from './query.js';
import { roomsSource, SEARCH_SOURCES } from './registry.js';

/**
 * What one caller may search, as the rooms domain and the owner check resolved
 * it.
 *
 * Data, not a capability: it is built per request from an identity the route
 * verified, and this module cannot widen it.
 */
export interface SearchScope {
  /**
   * Every room (the operator), or the rooms this caller is in keyed to the `seq`
   * each may be read from — their `joinedSeq`, because a member does not
   * retroactively read what was said before they arrived.
   */
  rooms: 'all' | ReadonlyMap<string, number>;
  /**
   * Whether session transcripts are in reach. **Owner-only in v1**, and false
   * for anything that presented an agent identity.
   *
   * The two open holes that make this the only safe answer are recorded in spec
   * §7: the external MCP surface collapses every caller onto one Relay sender,
   * and a caller that simply omits `X-DorkOS-Agent` resolves to the install
   * owner, who may see everything. Absence is never consent.
   */
  sessions: boolean;
}

/** What to search for, and how much to bring back. */
export interface SearchRequest {
  /** What the caller typed. Matched by word stem, never by substring. */
  query: string;
  /** How many hits, clamped to {@link SEARCH_MAX_LIMIT}. */
  limit: number;
  /** Narrow to one source id. Absent searches everything in reach. */
  source?: string;
}

/**
 * Search every source this caller may read, best first.
 *
 * @param db - The database holding the index.
 * @param scope - What this caller may see, resolved by the route.
 * @param request - What they asked for.
 * @returns The envelope: ranked hits across sources, plus one warning per source
 *   that is behind. Both fields are always present, `[]` included.
 */
export function searchForCaller(
  db: Db,
  scope: SearchScope,
  request: SearchRequest
): SearchResponse {
  const scopes = buildScopes(scope, request.source);
  const hits = searchMessages(db, {
    scopes,
    query: request.query,
    limit: Math.min(Math.max(1, Math.trunc(request.limit)), SEARCH_MAX_LIMIT),
    excerpts: true,
  });

  const paths = containerPaths(
    db,
    hits.map((hit) => ({ sourceId: hit.sourceId, originKey: hit.originKey }))
  );
  const results: SearchHit[] = hits.map((hit) => ({
    source: hit.sourceId,
    container: hit.originKey,
    containerPath: paths.get(containerKey(hit.sourceId, hit.originKey)) ?? null,
    ordinal: hit.ordinal,
    role: hit.role,
    createdAt: hit.createdAt,
    // Non-null by construction — `excerpts: true` above — and defaulted rather
    // than asserted, because an empty string is a worse answer than a missing
    // one only when somebody is lying about which they got.
    excerpt: hit.excerpt ?? '',
  }));

  return { results, warnings: sourceWarnings(db, scopes) };
}

/**
 * The sources this caller may read, narrowed to the one they asked for.
 *
 * @param scope - What the caller may see.
 * @param source - The `?source=` filter, if any. A source outside the caller's
 *   reach simply yields nothing — the access model is public, and the honest
 *   answer to "search my sessions" from something that may not is an empty list
 *   rather than a hint about what exists.
 * @returns The scopes, possibly empty.
 */
function buildScopes(scope: SearchScope, source?: string): SourceScope[] {
  const scopes: SourceScope[] = [];

  if (source === undefined || source === roomsSource.id) {
    scopes.push(
      scope.rooms === 'all'
        ? { sourceId: roomsSource.id, visibility: 'all' }
        : {
            sourceId: roomsSource.id,
            visibility: 'containers',
            containers: [...scope.rooms].map(([roomId, joinedSeq]) => ({
              originKey: roomId,
              afterOrdinal: joinedSeq,
            })),
          }
    );
  }

  if (scope.sessions) {
    for (const registered of SEARCH_SOURCES) {
      if (registered.id === roomsSource.id) continue;
      if (source !== undefined && source !== registered.id) continue;
      scopes.push({ sourceId: registered.id, visibility: 'all' });
    }
  }

  return scopes;
}

/**
 * The working directory each returned hit opens in.
 *
 * A second small query rather than a join, and deliberately: the ranked query is
 * the one whose cost scales with how many rows MATCH, so nothing that scales
 * with the answer's size belongs inside it. This one reads at most `limit` rows
 * by primary key.
 *
 * @param db - The database.
 * @param containers - The containers the hits landed in.
 * @returns `sourceId\u0000originKey` to path, for the containers that have one.
 */
function containerPaths(
  db: Db,
  containers: ReadonlyArray<{ sourceId: string; originKey: string }>
): Map<string, string | null> {
  const paths = new Map<string, string | null>();
  if (containers.length === 0) return paths;

  // Grouped by source and OR'd, exactly as the visibility clause is, and for the
  // same reason: `origin_key` is unique WITHIN a source and carries no guarantee
  // across sources, so a bare `origin_key IN (...)` could read one source's path
  // onto another source's hit.
  const bySource = new Map<string, Set<string>>();
  for (const container of containers) {
    const keys = bySource.get(container.sourceId);
    if (keys) keys.add(container.originKey);
    else bySource.set(container.sourceId, new Set([container.originKey]));
  }
  const groups = sql.join(
    [...bySource].map(
      ([sourceId, keys]) =>
        sql`(source_id = ${sourceId} AND origin_key IN (${sql.join(
          [...keys].map((key) => sql`${key}`),
          sql`, `
        )}))`
    ),
    sql` OR `
  );
  const rows = db.all<{ source_id: string; origin_key: string; container_path: string | null }>(sql`
    SELECT source_id, origin_key, container_path
    FROM search_sources
    WHERE ${groups}
  `);
  for (const row of rows) {
    paths.set(containerKey(row.source_id, row.origin_key), row.container_path);
  }
  return paths;
}

/**
 * The composite key a container is looked up by, source first.
 *
 * Joined on a NUL, written as an ESCAPE rather than pasted in as a byte — a raw
 * one in the source makes git treat this whole file as binary and stop diffing
 * it. It is the right separator because `origin_key` is opaque and may hold
 * anything a projection composes, and NUL is the one character it cannot.
 */
function containerKey(sourceId: string, originKey: string): string {
  return `${sourceId}\u0000${originKey}`;
}

/**
 * One warning per source in this caller's scope that has a container it could
 * not index.
 *
 * ADR-0310's envelope: a source whose projection an upstream format change broke
 * contributes zero rows and one warning naming it, never a failed request. It
 * reads `search_sources.last_error`, which is the column that exists to make
 * "produced nothing" visible rather than silent.
 *
 * @param db - The database.
 * @param scopes - The sources this caller may read.
 * @returns One warning per failing source, in registry order.
 */
function sourceWarnings(db: Db, scopes: readonly SourceScope[]): SearchSourceWarning[] {
  const warnings: SearchSourceWarning[] = [];
  for (const scope of scopes) {
    const failed = db
      .select({ sourceId: searchSourcesTable.sourceId })
      .from(searchSourcesTable)
      .where(
        and(
          eq(searchSourcesTable.sourceId, scope.sourceId),
          isNotNull(searchSourcesTable.lastError)
        )
      )
      .limit(1)
      .all();
    if (failed.length === 0) continue;
    warnings.push({
      source: scope.sourceId,
      // Names the source and nothing inside it. A container id here would be a
      // room id or a session id, and a response anybody may ask for is not the
      // place to confirm one exists (spec §9.5).
      message: 'Some of this could not be read, so results from it may be missing.',
    });
  }
  return warnings;
}
