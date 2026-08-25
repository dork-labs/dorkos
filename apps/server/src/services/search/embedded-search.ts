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
 * ## Nothing in production wires this yet, and that is deliberate
 *
 * The only embedding host DorkOS ships is the Obsidian plugin, and the plugin
 * cannot open the index today: `better-sqlite3` is a native `.node` addon that
 * the plugin bundle does not carry into a vault, and `@dorkos/db`'s migrations
 * folder resolves to a path that does not exist there. A seam wired over that
 * would answer "unavailable" to every search forever, so the embed's search
 * surfaces stay gated (`MessageSearchDialog`, `CommandPaletteDialog`) until the
 * addon ships. That work is filed separately.
 *
 * **So what a host must provide is stated here rather than built here**: an open
 * {@link Db} holding the index, kept swept by a `SearchIndexer` the host owns,
 * and a {@link RoomService} over the same database. A host that cannot provide
 * all three has no business offering a search box, which is the rule the gate on
 * the client enforces today.
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
import { resolveOperatorAuthor } from '../rooms/index.js';
import type { RoomService } from '../rooms/room-service.js';
import { answerSearch } from './answer-search.js';

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
      const caller = resolveOperatorAuthor(deps.rooms.authorRegistry);
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
