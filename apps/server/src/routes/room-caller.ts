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
import {
  getRoomService,
  resolveOperatorAuthor,
  RoomError,
  type AuthorRecord,
} from '../services/rooms/index.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import type { RequestFacts } from '../http/request-facts.js';
import type { CallerAccess } from './caller-access.js';
import { notePersonSessionMissing } from '../lib/person-without-session.js';

/** What {@link resolveCaller} reads: the raw agent header and what the chain resolved. */
type CallerFacts = Pick<RequestFacts, 'headers' | 'agentIdentity' | 'user'>;

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
 * 2. **A signed-in account** acts as the human author bound to it. The caller's
 *    `user` is only ever set by the session gate. A write needs a browser
 *    session: an API key reads as its account but never writes as it
 *    (DOR-3330), 401 `PERSON_SESSION_REQUIRED`.
 * 3. **Anything else** is the person at the keyboard when it only reads, or
 *    when nobody owns this install yet: whoever owns it, or the unbound
 *    `'local'` author when nobody does. **A write needs the owner's session
 *    once an owner exists** (DOR-3330): any program here can omit the agent
 *    header, so it is refused, 401 `PERSON_SESSION_REQUIRED`, and the person's
 *    one step-up at this computer is what answers it. Reads stay free.
 *
 * ## Why an unverifiable token is refused rather than ignored (DOR-1361)
 *
 * It used to fall through to branch 3, because branch 1 asks
 * {@link getRequestAgentIdentity} — "WHICH agent is this" — and a revoked or
 * expired token left that empty. **It no longer does** (DOR-486): resolution now
 * NAMES a shut-off agent, so that the capability gate can tell one from a
 * stranger, and branch 1 tests `!identity.inactive` to keep answering exactly as
 * described here. So an agent that kept following the protocol
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
 * a {@link RoomError} through `roomRoute` (`routes/room-route.ts`), so a new
 * route inherits this without doing anything, and one that forgets a `try` fails loudly rather than
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
 * Takes a request's facts (`http/request-facts.ts`). A route builds them with
 * `honoRequestFacts`; a WebSocket upgrade runs no chain, so it builds them from
 * its headers and the identity it resolved for itself
 * (`upgradeCaller` in `services/core/streams/stream-upgrade-auth.ts`).
 * Only the raw `X-DorkOS-Agent` header decides the refusal above, so a surface
 * that somehow skips identity resolution fails closed instead of open.
 *
 * @param facts - The raw headers, the resolved agent identity and, when the
 *   gate proved one, the resolved account.
 * @param access - What the caller is about to do; a write unless said
 *   otherwise, so a new call site fails closed (`callerAccessOf` in `caller-access.ts`).
 * @throws {RoomError} `AGENT_IDENTITY_UNVERIFIED` when the caller presented an
 *   agent token this machine could not verify.
 * @throws {RoomError} `PERSON_SESSION_REQUIRED` for a write with no session
 *   once an owner exists.
 */
export function resolveCaller(facts: CallerFacts, access: CallerAccess = 'write'): AuthorRecord {
  const registry = getRoomService().authorRegistry;
  const identity = facts.agentIdentity;
  // `!identity.inactive` preserves this route's existing answer through a change
  // one module over (DOR-486 review). `resolve()` used to return `undefined` for
  // a revoked or expired token, so those callers fell into the 401 below by
  // omission; it now returns a NAMED identity, because the capability gate has to
  // tell a shut-off agent from a stranger to stop revocation widening a ceiling.
  // Without this check that change would have quietly turned a hard 401 here into
  // a full agent author — the exact inversion it exists to close, one seam over.
  if (identity && !identity.inactive) {
    return registry.resolveAgent(identity.agentPath, identity.displayName);
  }
  if (presentsAgentIdentity(facts)) {
    throw new RoomError(
      'AGENT_IDENTITY_UNVERIFIED',
      'That agent identity could not be verified. Its token may have been revoked, or it may have expired.'
    );
  }

  const owner = readOwnerAccount();
  const session = facts.user;
  // A key is a program, never the person's voice (DOR-3330): it may read as
  // the account it belongs to, but only a browser session writes as them.
  if (session && session.credential !== 'cookie' && access === 'write') {
    throw new RoomError('PERSON_SESSION_REQUIRED', 'Post as yourself from the DorkOS app.');
  }
  if (session) {
    return session.userId === owner?.id
      ? registry.bindOwner(owner.id)
      : registry.human(session.userId);
  }

  if (access === 'write' && owner) {
    notePersonSessionMissing(facts);
    throw new RoomError(
      'PERSON_SESSION_REQUIRED',
      'Confirm it’s you with your password to do this.'
    );
  }
  return resolveOperatorAuthor(registry);
}
