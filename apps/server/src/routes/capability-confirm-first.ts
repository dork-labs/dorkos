/**
 * Hold a confirm-first capability call for the "Confirm it's you" sheet
 * (ADR 261125-114705, decision 4). The capability mount calls this when
 * `registry.invoke` refuses a call with `ConfirmFirstRequired`.
 *
 * It reuses the step-up holds the account writes use (`runAccountWrite`), so
 * the call answers the same `428` and the app shows the same sheet:
 *
 * - **Bound to the browser that asked**: the hold records the asking sign-in,
 *   and only that sign-in may confirm it (`routes/step-up.ts`). A caller with
 *   no sign-in can't hold one once an owner exists.
 * - **Single use and short-lived**: the hold is taken before it commits, and
 *   dropped after `STEP_UP_TTL_MS` (`step-up-holds.ts`).
 * - **No agent path**: only the person's password, from the app's own page,
 *   commits it, and the registry runs the call only with the confirmation
 *   minted here, for that capability and that input, once.
 * - **The account-write extras**: the front-door and owner bars run again on
 *   the confirming request, and a relinked account needs a fresh ask.
 *
 * @module routes/capability-confirm-first
 */
import type { Context } from 'hono';

import type { ApiEnv } from '../http/api-chain.js';
import type { RequestFacts } from '../http/request-facts.js';
import { personConfirmed, type ConfirmFirstRequired } from '../services/core/capabilities/index.js';
import { runAccountWrite } from './cloud-owner-bar.js';

/**
 * Hold one refused call until the person confirms it.
 *
 * @param c - The request that asked.
 * @param capabilityId - The capability held.
 * @param held - The registry's refusal: the parsed input and the declaration.
 * @param commit - Run the call again as the confirming request, with the
 *   person's confirmation.
 * @returns The `428` with the held action's id, or a refusal; with no owner
 *   account yet, the front-door bar alone, and the call's own answer.
 */
export function holdConfirmFirst(
  c: Context<ApiEnv>,
  capabilityId: string,
  held: ConfirmFirstRequired,
  commit: (confirming: RequestFacts, confirmation: unknown) => Promise<Response>
): Promise<Response> {
  const { hold, input } = held;
  return runAccountWrite(c, {
    kind: hold.kind,
    target: hold.target,
    input,
    reason: hold.reason,
    run: (confirming) => commit(confirming, personConfirmed(capabilityId, input)),
  });
}
