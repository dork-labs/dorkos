/**
 * The word the credits offer opens with, read off what the account reports.
 *
 * @module widgets/credits-offer/lib/credits-verb
 */
import type { CloudPlanResponse } from '@dorkos/shared/cloud-schemas';

/**
 * How the offer's button starts: "Try DorkOS credits", "Buy DorkOS credits" or
 * "Use DorkOS credits".
 */
export type CreditsVerb = 'Try' | 'Buy' | 'Use';

/** A decimal micro-unit amount as a bigint, or `null` when it is not one. */
function micro(amount: string): bigint | null {
  return /^\d+$/.test(amount) ? BigInt(amount) : null;
}

/**
 * Pick the button's first word from the account's own figures, never from a
 * plan's name or price, which this app does not know (catalog blindness):
 *
 * - **Buy** — signed in, and the account has nothing left to spend: no
 *   included credits remain and none were added. The button opens the page to
 *   add credits, on the web.
 * - **Try** — signed in, the account's included credits are all still there
 *   and nothing was ever added: it has credits it has never spent.
 * - **Use** — everything else: signed out (nothing is known about the account
 *   until it links), an account with credits it has spent from, and any answer
 *   this cannot read. "Use" promises nothing about money.
 *
 * @param linked - Whether this computer is linked to a DorkOS account.
 * @param plan - `GET /api/cloud/plan`, or `undefined` while it loads.
 */
export function creditsVerb(linked: boolean, plan: CloudPlanResponse | undefined): CreditsVerb {
  if (!linked || !plan?.available || plan.balance === null) return 'Use';
  const { allowance, purchased } = plan.balance;
  const granted = micro(allowance.grantedMicro);
  const remaining = micro(allowance.remainingMicro);
  const added = micro(purchased.remainingMicro);
  if (granted === null || remaining === null || added === null) return 'Use';
  if (remaining === 0n && added === 0n) return 'Buy';
  if (added === 0n && granted > 0n && remaining === granted) return 'Try';
  return 'Use';
}
