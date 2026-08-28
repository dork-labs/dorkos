/**
 * `GET /api/search` — one request answers "where did we talk about X", and
 * answers it only for whoever may see it (message-search spec §6.1, §7).
 *
 * One route, one envelope, no writes. It is thin by the route rule: it resolves
 * WHO is asking, asks the rooms domain what that caller may see, and hands both
 * to {@link answerSearch}. Every access rule it enforces is one that already
 * exists somewhere else — this router owns none of them, which is what keeps the
 * answer here and the answer in a room identical.
 *
 * **What is left here is the caller, and only the caller.** Everything that
 * happens once WHO is known — the schema refusal, the unknown-source refusal,
 * the default limit, the ranked read — moved to {@link answerSearch} when the
 * search service grew a second, HTTP-less caller (DOR-691). Two surfaces, one
 * decision.
 *
 * **Identity is resolved BEFORE the query is read, and the order is deliberate.**
 * It used to be the other way round, so a caller presenting an agent token this
 * machine could not verify was told their query was malformed: a 400 describing
 * the request of somebody who was never going to be answered either way. Now they
 * get the 401, and nothing about what they asked for is echoed back. A caller
 * this machine CAN identify still gets the 400 their query earned.
 *
 * ## Who gets what
 *
 * | Caller | Rooms | Sessions |
 * | --- | --- | --- |
 * | The operator, in the cockpit | all | all |
 * | An agent | the rooms it is in, above its `joinedSeq` | **none** |
 *
 * **Sessions are owner-only in v1, and a caller that presented an agent identity
 * never reaches them** — resolved or not, since a revoked token still says a
 * machine is calling. Two independent conditions have to hold, and either one
 * failing is enough to close the door: the caller is the install owner's author,
 * and no agent header was presented. Spec §7 records why one is not enough — the
 * external MCP surface collapses every caller onto a single Relay sender, and a
 * caller that simply omits the header resolves to the owner. Absence is never
 * consent.
 *
 * ## Why this route refuses a short query
 *
 * Ranking is `ORDER BY bm25()`, whose cost is a function of how many rows MATCH
 * rather than how many come back (spec Amendment 1). So `t` is the most
 * expensive search there is and the least useful one, and a box that fires on
 * every keystroke pays for the two searches nobody wanted before the one they
 * did. The minimum length is enforced here; the debounce that goes with it
 * cannot be — this surface sees requests, not keystrokes — so it ships as
 * `SEARCH_DEBOUNCE_MS` for every caller to hold to.
 *
 * @module routes/search
 */
import { Router, type Request, type Response } from 'express';
import type { Db } from '@dorkos/db';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import { isOwnerRecord } from '../services/rooms/author-registry.js';
import { getRoomService } from '../services/rooms/index.js';
import { answerSearch } from '../services/search/index.js';
import { resolveCaller } from './room-caller.js';
import { sendRoomError } from './room-error-response.js';

/** What the search router reads. It writes nothing and holds no state. */
export interface SearchRouterDeps {
  /** The database holding the message index. */
  db: Db;
}

/**
 * Build the search router.
 *
 * @param deps - The index to read.
 * @returns The router, to mount at `/api/search`.
 */
export function createSearchRouter(deps: SearchRouterDeps): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    try {
      const rooms = getRoomService();
      const caller = resolveCaller(req, res);
      // `isOwnerRecord` answers "is this the person who owns the install", and it
      // is the half that decides today: an agent resolves to an agent author and
      // fails it, and a caller whose token did not verify never gets this far
      // (`resolveCaller` throws a 401 first).
      //
      // **`presentsAgentIdentity` is deliberately redundant, and stays.** It is
      // the WIDER question — "is a machine calling at all" — and it is a second
      // lock on one specific regression: an unverifiable agent token used to fall
      // through to the install owner, and DOR-1361 is the fix that stopped it. If
      // that branch order is ever loosened again, this line is what keeps session
      // history closed while the room routes are being argued about. No test here
      // can turn its key, because nothing today can reach it with the first lock
      // open; that is the point of it rather than an omission.
      const sessions =
        isOwnerRecord(caller, readOwnerAccount()?.id ?? null) && !presentsAgentIdentity(req, res);

      const answer = answerSearch(
        deps.db,
        { rooms: rooms.searchScope(caller.id), sessions },
        req.query
      );
      if (!answer.ok) {
        res.status(answer.status).json({ error: answer.error, code: answer.code });
        return;
      }
      res.json(answer.response);
    } catch (err) {
      sendRoomError(res, err, 'GET /api/search');
    }
  });

  return router;
}
