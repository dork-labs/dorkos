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
import { problem } from '@dorkos/http-kit';
import {
  finishPasskeyCheck,
  startPasskeyCheck,
  thisComputerPasskeyHosts,
} from '../../services/core/auth/factors/owner-passkeys.js';

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
        // The address is this computer's own, shown to its owner: never a path or secret.
        return problem(c, 'passkey_on_other_address', {
          detail: `Open DorkOS at ${hosts[0]} on this computer to check your passkey.`,
        });
      }
      if (options.ifAny) return true;
      return problem(c, PASSKEY_NEEDED_CODE, { detail: 'Add a passkey on this computer first.' });
    }
    if (typeof check === 'string') {
      return problem(c, 'origin_not_allowed', { detail: 'Do this in the DorkOS app.' });
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ code: PASSKEY_CHECK_CODE, options: check }, 428);
  }
  const checked = await finishPasskeyCheck(
    purpose,
    passkey as Parameters<typeof finishPasskeyCheck>[1]
  );
  if (typeof checked === 'string') {
    return problem(c, 'passkey_refused', { detail: 'That passkey check didn’t work. Try again.' });
  }
  return true;
}
