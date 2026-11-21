/**
 * A fresh passkey check for one action, done by the person at this computer
 * (DOR-4744, DOR-3647). The first call answers `428` with the check; the
 * second sends the browser's response in `passkey`. Each check covers this one
 * action once. Never a password: with no passkey here, `409` says to add one,
 * unless the action asks for the check only when a passkey exists. A passkey
 * for another of this computer's addresses is never "none": `409` names the
 * address to open DorkOS at.
 *
 * @module http/sign-in/passkey-check
 */
import type { Context } from 'hono';
import { PASSKEY_CHECK_CODE, PASSKEY_NEEDED_CODE } from '@dorkos/shared/signed-in-devices';

import type { ApiEnv } from '../api-chain.js';
import { NOT_FROM_OWN_PAGE } from '../../lib/http/own-origin-write.js';
import { errorBody } from '../../lib/route-utils.js';
import {
  finishPasskeyCheck,
  startPasskeyCheck,
  thisComputerPasskeyHosts,
} from '../../services/core/auth/factors/owner-passkeys.js';

/** Refusal code when the passkey is for another of this computer's addresses. */
export const PASSKEY_ELSEWHERE_CODE = 'PASSKEY_ON_OTHER_ADDRESS';

/**
 * Run the passkey check for one action.
 *
 * @param c - The request.
 * @param owner - The owner at this computer, with their sign-in.
 * @param action - What the check covers, so it covers nothing else.
 * @param passkey - The browser's response, once it has one.
 * @param options - `ifAny`: with no passkey on this computer, skip the check.
 * @returns `true` once checked (or skipped), otherwise the answer to send.
 */
export async function passkeyChecked(
  c: Context<ApiEnv>,
  owner: { userId: string; sessionId: string },
  action: string,
  passkey: unknown,
  options: { ifAny?: boolean } = {}
): Promise<true | Response> {
  const purpose = { kind: 'confirm', ...owner, action } as const;
  if (passkey === undefined) {
    const check = await startPasskeyCheck(purpose, String(c.req.header('origin')));
    if (check === 'no-passkey') {
      // A passkey made for another of this computer's addresses still counts:
      // the check is asked for there, never skipped.
      const hosts = thisComputerPasskeyHosts(owner.userId);
      if (hosts.length > 0) {
        return c.json(
          errorBody(
            `Open DorkOS at ${hosts[0]} on this computer to check your passkey.`,
            PASSKEY_ELSEWHERE_CODE
          ),
          409
        );
      }
      if (options.ifAny) return true;
      return c.json(errorBody('Add a passkey on this computer first.', PASSKEY_NEEDED_CODE), 409);
    }
    if (typeof check === 'string') {
      return c.json(errorBody('Do this in the DorkOS app.', NOT_FROM_OWN_PAGE), 403);
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ code: PASSKEY_CHECK_CODE, options: check }, 428);
  }
  const checked = await finishPasskeyCheck(
    purpose,
    passkey as Parameters<typeof finishPasskeyCheck>[1]
  );
  if (typeof checked === 'string') {
    return c.json(errorBody('That passkey check didn’t work. Try again.', 'PASSKEY_REFUSED'), 401);
  }
  return true;
}
