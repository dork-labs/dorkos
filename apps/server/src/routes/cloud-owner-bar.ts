/**
 * The one bar every DorkOS account write runs: is this the person who owns this
 * install? Shared by `routes/cloud.ts` and `routes/cloud-communities.ts`, so
 * the link, billing, export, deletion, seats, credits and hosted-space writes
 * all refuse the same callers with the same codes.
 *
 * The decision itself is `refuseUnlessAccountOwner` in `lib/caller-authority.ts`,
 * beside the other person bars. This module only words it, in the two shapes
 * these routes answer with:
 *
 * - **An envelope** (`{ ok: false, code, message }`) for the writes whose
 *   answer is already an `ok` envelope — billing pages, export, deletion,
 *   seats, the link check, hosted spaces. The app reads the sentence out of it
 *   instead of saying the account could not be reached.
 * - **An error** (`{ error, code }`) for the writes that answer with a status
 *   object — the link flow and the credits choices — so the transport's thrown
 *   error carries the sentence as its message.
 *
 * Both answer 403: a refusal of the caller, not of the request.
 *
 * @module routes/cloud-owner-bar
 */
import type { RequestFacts } from '../http/request-facts.js';
import { refuseUnlessAccountOwner } from '../lib/caller-authority.js';

/** Refusal code when anything but a person asks for a DorkOS account action. */
const PERSON_ONLY_CODE = 'person_only';

/** Refusal code when a signed-in person who does not own this install asks. */
const OWNER_ONLY_CODE = 'owner_only';

/** How one write words its refusals. */
export interface AccountOwnerWording {
  /** The whole sentence an agent, or anything but the person, is told. */
  personOnly: string;
  /**
   * What the write does, completing "Only the owner of this DorkOS
   * can …" (no capital, no full stop).
   */
  action: string;
}

/** A refusal, worded, or `undefined` when the caller may act. */
function refusalFor(
  caller: RequestFacts,
  wording: AccountOwnerWording
): { code: string; message: string } | undefined {
  const refusal = refuseUnlessAccountOwner(caller);
  if (refusal === undefined) return undefined;
  return refusal === 'not-a-person'
    ? { code: PERSON_ONLY_CODE, message: wording.personOnly }
    : {
        code: OWNER_ONLY_CODE,
        message: `Only the owner of this DorkOS can ${wording.action}.`,
      };
}

/**
 * The 403 body for the writes that answer with an envelope, for a route on the
 * Hono chain that answers it itself: `c.json(body, 403)`.
 *
 * @param caller - The request's facts.
 * @param wording - What this write says when it refuses.
 * @returns `{ ok: false, code, message }`, or `undefined` when the caller owns
 *   this install.
 */
export function envelopeRefusalUnlessOwner(
  caller: RequestFacts,
  wording: AccountOwnerWording
): { ok: false; code: string; message: string } | undefined {
  const refusal = refusalFor(caller, wording);
  return refusal === undefined ? undefined : { ok: false, ...refusal };
}

/**
 * The 403 body for the writes that answer with a status object, for a route on
 * the Hono chain that answers it itself: `c.json(body, 403)`.
 *
 * @param caller - The request's facts.
 * @param wording - What this write says when it refuses.
 * @returns `{ error, code }`, or `undefined` when the caller owns this install.
 */
export function errorRefusalUnlessOwner(
  caller: RequestFacts,
  wording: AccountOwnerWording
): { error: string; code: string } | undefined {
  const refusal = refusalFor(caller, wording);
  return refusal === undefined ? undefined : { error: refusal.message, code: refusal.code };
}
