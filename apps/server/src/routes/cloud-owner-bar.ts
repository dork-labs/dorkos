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
import type { Request, Response } from 'express';
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
  req: Request,
  res: Response,
  wording: AccountOwnerWording
): { code: string; message: string } | undefined {
  const refusal = refuseUnlessAccountOwner(req, res);
  if (refusal === undefined) return undefined;
  return refusal === 'not-a-person'
    ? { code: PERSON_ONLY_CODE, message: wording.personOnly }
    : {
        code: OWNER_ONLY_CODE,
        message: `Only the owner of this DorkOS can ${wording.action}.`,
      };
}

/**
 * Answer 403 `{ ok: false, code, message }` unless the caller owns this
 * install.
 *
 * @param req - The incoming request.
 * @param res - The response, written on refusal.
 * @param wording - What this write says when it refuses.
 * @returns `true` when the request was answered, so the caller must return.
 */
export function refuseEnvelopeUnlessOwner(
  req: Request,
  res: Response,
  wording: AccountOwnerWording
): boolean {
  const refusal = refusalFor(req, res, wording);
  if (refusal === undefined) return false;
  res.status(403).json({ ok: false, ...refusal });
  return true;
}

/**
 * Answer 403 `{ error, code }` unless the caller owns this install.
 *
 * @param req - The incoming request.
 * @param res - The response, written on refusal.
 * @param wording - What this write says when it refuses.
 * @returns `true` when the request was answered, so the caller must return.
 */
export function refuseErrorUnlessOwner(
  req: Request,
  res: Response,
  wording: AccountOwnerWording
): boolean {
  const refusal = refusalFor(req, res, wording);
  if (refusal === undefined) return false;
  res.status(403).json({ error: refusal.message, code: refusal.code });
  return true;
}
