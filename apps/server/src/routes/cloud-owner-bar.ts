/**
 * The one bar every DorkOS account write runs: is this the person who owns this
 * install? Shared by `routes/cloud.ts` and `routes/cloud-communities.ts`, so
 * the link, billing, export, deletion, seats, credits and hosted-space writes
 * all refuse the same callers with the same codes.
 *
 * The decision itself is `refuseUnlessAccountOwner` in `lib/caller-authority.ts`,
 * beside the other person bars. This module only words it, as a `403`
 * problem document (DOR-4979): `person_only` for anything but a person,
 * `owner_only` for a person signed in to another account. The app reads the
 * sentence out of its `detail`.
 *
 * One older shape is left, `errorRefusalUnlessOwner` (`{ error, code }`), for
 * the connected-apps spending routes that have not moved to problems yet.
 *
 * @module routes/cloud-owner-bar
 */
import { problem, problemBody } from '@dorkos/http-kit';
import type { Problem } from '@dorkos/shared/problem';
import type { RequestFacts } from '../http/request-facts.js';
import { refuseUnlessAccountOwner } from '../lib/caller-authority.js';
import type { Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { configManager } from '../services/core/config-manager.js';
import { getCloudLinkGeneration } from '../services/core/auth/cloud-link.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import { runFrontDoorWrite, type FrontDoorWrite } from './front-door-step-up.js';

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

/**
 * The 403 problem document for a write that answers problems, for a route on
 * the Hono chain: send it with `sendProblem`, or hand it back from a held
 * action's commit as its body.
 *
 * @param caller - The request's facts.
 * @param wording - What this write says when it refuses.
 * @returns `person_only` or `owner_only`, or `undefined` when the caller owns
 *   this install.
 */
export function problemRefusalUnlessOwner(
  caller: RequestFacts,
  wording: AccountOwnerWording
): Problem | undefined {
  const refusal = refusalFor(caller, wording);
  if (refusal === undefined) return undefined;
  return problemBody(refusal.code === PERSON_ONLY_CODE ? 'person_only' : 'owner_only', {
    detail: refusal.message,
  });
}

/**
 * Hold an account write, bound to the account link it was asked against.
 * The owner and front-door bars run again on confirmation; a relink needs a fresh ask.
 *
 * @param c - The request asking for the write.
 * @param action - The fixed account change.
 */
export function runAccountWrite(
  c: Context<ApiEnv>,
  action: Omit<FrontDoorWrite, 'subject'>
): Promise<Response> {
  if (readOwnerAccount() === null)
    return runFrontDoorWrite(c, { ...action, subject: 'the DorkOS account' });
  const generation = getCloudLinkGeneration();
  const token = configManager.get('cloud')?.instanceToken ?? null;
  return runFrontDoorWrite(c, {
    ...action,
    subject: 'the DorkOS account',
    run: async (confirming) => {
      if (refuseUnlessAccountOwner(confirming) !== undefined) {
        return problem(c, 'owner_only', { detail: 'Only the owner can change this account.' });
      }
      if (
        generation !== getCloudLinkGeneration() ||
        token !== (configManager.get('cloud')?.instanceToken ?? null)
      ) {
        return problem(c, 'precondition_failed', {
          detail: 'The account link changed. Try again.',
        });
      }
      return action.run(confirming);
    },
  });
}
