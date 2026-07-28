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
import type { Response } from 'express';
import { getRoomService, type AuthorRecord } from '../services/rooms/index.js';
import { readOwnerAccount, type RequestUser } from '../services/core/auth/index.js';
import { getRequestAgentIdentity } from '../middleware/agent-identity.js';

/**
 * Who this request is.
 *
 * Three branches, in this order:
 *
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
 * @param res - The response holding the resolved agent identity and, when login
 *   is on, the resolved account.
 */
export function resolveCaller(res: Response): AuthorRecord {
  const registry = getRoomService().authorRegistry;
  const identity = getRequestAgentIdentity(res);
  if (identity) {
    return registry.resolveAgent(identity.agentPath, identity.displayName);
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
