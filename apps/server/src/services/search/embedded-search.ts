/**
 * Message search where there is no server to ask: the in-process half of
 * `Transport.search`, for a host that embeds DorkOS (DOR-691, message-search
 * task 5.3).
 *
 * `DirectTransport` is the embedded Transport, and it has no HTTP anywhere in it
 * — an embedding host wires server services straight into the client (see
 * `createEmbeddedTurnTrigger`, the same pattern one domain over). This module is
 * the seam it would wire for search: the caller resolution `GET /api/search`
 * does from a request, done for a surface that has no request.
 *
 * ## What a host must provide, and who provides it
 *
 * An open {@link Db} holding the index, kept swept by a `SearchIndexer` the host
 * owns, and a {@link RoomService} over the same database. A host that cannot
 * provide all three has no business offering a search box.
 *
 * The Obsidian plugin is the one that does (DOR-1563,
 * `apps/obsidian-plugin/src/lib/embedded-index.ts`). It opens `~/.dork/dork.db`
 * through a SQLite build staged beside its bundle, checks that the tables search
 * needs are there, and wires nothing at all when either is missing — an absent
 * seam makes `DirectTransport.search` refuse in a sentence rather than answer
 * emptily. **It never migrates**: whoever owns the install owns the schema
 * (ADR 260825-194924).
 *
 * ## The embed is the operator, and that is a fact about the surface
 *
 * There is exactly one identity in an embedded window: the person whose machine
 * it is, where the index lives. No agent can reach this seam — an agent talks to
 * DorkOS over HTTP or MCP, both of which carry `X-DorkOS-Agent` and both of which
 * resolve an agent author from it. There is no header here to carry and no second
 * caller to be.
 *
 * So the scope is the route's OWNER ROW, derived rather than asserted:
 * {@link resolveOperatorAuthor} is the same last branch of `resolveCaller` the
 * route falls to for the person at the keyboard, `RoomService.searchScope` is the
 * same question about rooms, and `isOwnerRecord` is the same question about
 * session history. Nothing here hard-codes `'all'` or `true`. If the rooms domain
 * ever narrows what an operator may search, this narrows with it on the same
 * commit — which is the property that stops an embed becoming a way around the
 * access model.
 *
 * The route's other two branches are absent rather than reimplemented, and the
 * ONE thing that makes that safe is stated: `presentsAgentIdentity` is the wider
 * "is a machine calling at all", and it is structurally false here because there
 * is no request to present anything. A future host that wires this seam behind
 * something an agent CAN reach has to resolve its own caller and call
 * {@link answerSearch} directly — not this.
 *
 * @module server/services/search/embedded-search
 */
import type { Db } from '@dorkos/db';
import type { SearchAnswer, SearchQuery } from '@dorkos/shared/search-schemas';
import { readOwnerAccount } from '../core/auth/index.js';
import { isOwnerRecord } from '../rooms/author-registry.js';
import { peekOperatorAuthor } from '../rooms/index.js';
import type { RoomService } from '../rooms/room-service.js';
import { answerSearch } from './answer-search.js';

/**
 * What a search says on a database no DorkOS has ever run against.
 *
 * Reachable only when the index tables exist but the operator's own author row
 * does not, which no install DorkOS has booted can be in — it mints that row
 * itself. It is a refusal rather than an empty result for the reason every
 * refusal in this feature is: "nothing matched" and "I could not tell who you
 * are" must never look the same to somebody hunting for a sentence they
 * remember writing.
 */
const NO_OPERATOR_YET = {
  ok: false,
  status: 503,
  error:
    'This copy of your message history has not been set up yet. Open DorkOS once and it will be ready here.',
  code: 'SEARCH_OPERATOR_UNKNOWN',
} as const satisfies SearchAnswer;

/** The search seam an embedding host wires into `DirectTransport`. */
export interface EmbeddedSearch {
  /**
   * Answer one search as the operator.
   *
   * @param query - What the Transport was asked for. Re-parsed by
   *   {@link answerSearch}, so a typed caller on a stale build is refused here
   *   exactly as it would be over HTTP.
   */
  search(query: SearchQuery): SearchAnswer;
}

/**
 * Build the search seam over an already-open database and rooms domain.
 *
 * It opens nothing and owns nothing: the host holds the database handle and the
 * indexer, because the host is what knows when the window closes.
 *
 * @param deps - The index to read and the rooms domain that resolves what the
 *   operator may see.
 * @returns The seam.
 */
export function createEmbeddedSearch(deps: { db: Db; rooms: RoomService }): EmbeddedSearch {
  return {
    search(query: SearchQuery): SearchAnswer {
      // Re-resolved per call, never captured: an install becomes owned partway
      // through its life, and a caller captured at boot would search as the
      // pre-login sentinel forever.
      //
      // PEEKED rather than resolved, because a host here may be holding the
      // database read-only (DOR-1563) and `resolveOperatorAuthor` mints. Same
      // question, same two natural keys, no write.
      const caller = peekOperatorAuthor(deps.rooms.authorRegistry);
      if (caller === null) return NO_OPERATOR_YET;
      return answerSearch(
        deps.db,
        {
          rooms: deps.rooms.searchScope(caller.id),
          sessions: isOwnerRecord(caller, readOwnerAccount()?.id ?? null),
        },
        query
      );
    },
  };
}
