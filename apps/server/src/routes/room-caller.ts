/**
 * Resolves who a room request is, for both the REST routes and the SSE handler.
 *
 * It lives in its own module rather than in `rooms.ts` because `rooms.ts`
 * imports the SSE handler, so the handler cannot import back from it without a
 * cycle — and the handler needs the caller for exactly the same reason the REST
 * routes do: a room is membership-scoped, and the stream is a read.
 *
 * @module routes/room-caller
 */
import type { Request, Response } from 'express';
import { getRoomService, RoomError, type AuthorRecord } from '../services/rooms/index.js';
import { readOwnerAccount, type RequestUser } from '../services/core/auth/index.js';
import { getRequestAgentIdentity, presentsAgentIdentity } from '../middleware/agent-identity.js';

/**
 * Who this request is.
 *
 * A refusal, then three branches, in this order:
 *
 * 0. **A caller presenting an agent token this machine cannot verify is
 *    refused**, 401 `AGENT_IDENTITY_UNVERIFIED`. See below — it is the one
 *    branch that answers nobody.
 * 1. **An agent presenting a valid identity token** acts as itself, minted on
 *    its `agentPath`. First on purpose: an agent running under the owner's
 *    session still posts as itself, not as the owner.
 * 2. **A signed-in account** acts as the human author bound to it. `res.locals.user`
 *    is only ever set by `sessionGate`, which only runs when `auth.enabled` is
 *    `true`, so this branch is unreachable on a login-off install.
 * 3. **Anything else** is the person at the keyboard. With login off there is
 *    nothing left to tell a local program from them (the documented DOR-505
 *    residual), so they resolve to whoever owns this install — and to the
 *    unbound `'local'` author when nobody does.
 *
 * ## Why an unverifiable token is refused rather than ignored (DOR-1361)
 *
 * It used to fall through to branch 3, because branch 1 asks
 * {@link getRequestAgentIdentity} — "WHICH agent is this" — and a revoked or
 * expired token leaves that empty. So an agent that kept following the protocol
 * after its token died resolved to the INSTALL OWNER, and passed every
 * `caller.kind !== 'human'` gate the room routes hang off it.
 *
 * That is not privilege escalation on a single-identity install: dropping the
 * header entirely reaches branch 3 too, which is the documented DOR-505
 * residual. It is **attribution laundering**, and it is worse than a lenient
 * read looks. A dead agent's uploads, renames and halts were recorded as the
 * person's own, and the routes that state "only a person may do this" — the
 * attachment upload, the handle rename whose TSDoc rests the absence of a rate
 * limit on it, `POST /:id/halt` — were not enforcing the invariant they claim.
 *
 * So the question the refusal asks is the WIDER one,
 * {@link presentsAgentIdentity}: is a machine calling at all? A token that did
 * not resolve still says yes, and a person in the cockpit never sends the header
 * (the cockpit has no code that does). `GET /:id/sessions` refused on exactly
 * this predicate from DOR-1357, one route at a time; putting it here makes it
 * one answer for every room route, including the ones added after this line.
 *
 * **Throwing, rather than returning a refusal.** Every room route already funnels
 * a {@link RoomError} through `sendRoomError`, so a new route inherits this
 * without doing anything, and one that forgets a `try` fails loudly rather than
 * quietly acting as the owner.
 *
 * **It comes before visibility, and that is a narrower disclosure than the check
 * it generalizes.** DOR-1357 deliberately ran `GET /:id/sessions`'s visibility
 * check first, so an agent probing room ids could not tell 403 from 404. Here
 * nothing is looked up at all: a caller whose token does not verify gets the
 * same 401 for a room that exists and one that does not.
 *
 * The owner reaches this through {@link AuthorRegistry.bindOwner} in branches 2
 * and 3 alike, which is what rebinds the `'local'` sentinel onto their account
 * the first time they ask for anything.
 *
 * **Branch 3 is why turning login off again is not a data loss.** It resolves to
 * the same author id the signed-in owner uses, so their rooms, memberships and
 * read cursors are exactly where they left them. Minting a second `'local'`
 * author there would have stranded every one of them.
 *
 * **Branch 2 checks that the session IS the owner rather than assuming it.**
 * ADR 260727-184933 D6 keeps this install single-user for good, so a session
 * that is not the owner's cannot occur — and that is exactly why the check is
 * cheap and worth keeping. If the invariant ever broke, assuming would hand the
 * sentinel, and with it every room on the machine, to whoever asked first.
 *
 * Author identity is never read from the request body. A client that could name
 * its own author could post as anyone in the room — and, since every room read
 * is scoped to the caller's membership, could read any room by naming a member
 * of it.
 *
 * @param req - Anything holding the request's headers, for the raw
 *   `X-DorkOS-Agent` the refusal above reads: an Express `Request`, or the
 *   upgrade headers a WebSocket route is handed (`UpgradeAttempt.headers`). The
 *   raw header rather than a flag on `locals`, so a surface that somehow skips
 *   the identity middleware fails closed instead of open.
 * @param res - Anything holding the resolved agent identity and, when login is
 *   on, the resolved account: an Express `Response`, or the locals a WebSocket
 *   upgrade resolved for itself (an upgrade runs no middleware, so it fills the
 *   same two slots by hand — see `services/core/streams/stream-upgrade-auth.ts`).
 * @throws {RoomError} `AGENT_IDENTITY_UNVERIFIED` when the caller presented an
 *   agent token this machine could not verify.
 */
export function resolveCaller(
  req: Pick<Request, 'headers'>,
  res: Pick<Response, 'locals'>
): AuthorRecord {
  const registry = getRoomService().authorRegistry;
  const identity = getRequestAgentIdentity(res);
  if (identity) {
    return registry.resolveAgent(identity.agentPath, identity.displayName);
  }
  if (presentsAgentIdentity(req, res)) {
    throw new RoomError(
      'AGENT_IDENTITY_UNVERIFIED',
      'That agent identity could not be verified. Its token may have been revoked, or it may have expired.'
    );
  }

  const owner = readOwnerAccount();
  const session = res.locals.user as RequestUser | undefined;
  if (session) {
    return session.userId === owner?.id
      ? registry.bindOwner(owner.id)
      : registry.human(session.userId);
  }

  return owner ? registry.bindOwner(owner.id) : registry.localHuman();
}
