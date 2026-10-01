/**
 * The one line that says whether this computer is signed in to a DorkOS
 * account — what the header menu's "DorkOS account" row and the phone's You tab
 * show under the row's name.
 *
 * It reads two cache entries the account tab already owns (the link summary
 * and the plan), so asking costs nothing a visit to the tab would not. The plan
 * is read only once the summary says linked: an install that never linked
 * sends nothing on its behalf.
 *
 * @module features/cloud-plan/model/use-dorkos-account-line
 */
import { formatPosition } from '@dork-labs/cloud-api/display';
import type { CloudPlanResponse } from '@dorkos/shared/cloud-schemas';
import { useCloudStatus } from '@/layers/features/cloud-link';
import { withCreditUnit } from '../lib/credits';
import { remainingFraction } from '../lib/remaining-fraction';
import { useCloudPlan } from './use-cloud-plan';

/**
 * Below this share of the included allowance, with nothing added on top, the
 * credits are low enough to say so in the menu. A fraction of what the service
 * granted, so it holds on any plan without knowing what any plan includes.
 */
export const LOW_CREDIT_FRACTION = 0.1;

/** What the account row knows. */
export type DorkosAccountLine =
  | { state: 'loading' }
  | { state: 'signed-out' }
  | {
      state: 'signed-in';
      /** The service's own label for the account, or `null` until it syncs. */
      label: string | null;
      /** "4 credits left" when credits are low, else `null`. */
      lowCredits: string | null;
    };

/**
 * The credits left, as a figure, when they are low — and `null` otherwise.
 *
 * Low means the included allowance is under {@link LOW_CREDIT_FRACTION} of what
 * was granted and no added credits remain behind it. Added credits are counted
 * into the figure, so the number shown is everything there is left to spend.
 * A response without a readable unit shows nothing, never a guessed number.
 *
 * @param plan - The plan read, as `GET /api/cloud/plan` answered it.
 */
export function lowCreditsFigure(plan: CloudPlanResponse | undefined): string | null {
  if (!plan?.available || plan.balance === null) return null;
  const { allowance, purchased, denomination } = plan.balance;
  const fraction = remainingFraction(allowance.remainingMicro, allowance.grantedMicro);
  if (fraction === null || fraction >= LOW_CREDIT_FRACTION) return null;
  if (!/^\d+$/.test(allowance.remainingMicro) || !/^\d+$/.test(purchased.remainingMicro)) {
    return null;
  }
  if (BigInt(purchased.remainingMicro) > 0n) return null;
  const left = withCreditUnit(formatPosition(allowance.remainingMicro, denomination));
  return left === null ? null : `${left} left`;
}

/**
 * Turn the account line into the words under the row's name.
 *
 * @param line - What {@link useDorkosAccountLine} answered.
 * @returns The description, or `undefined` while it is still being read.
 */
export function describeDorkosAccountLine(line: DorkosAccountLine): string | undefined {
  if (line.state === 'loading') return undefined;
  if (line.state === 'signed-out') return 'Not signed in';
  return ['Signed in', line.label, line.lowCredits].filter(Boolean).join(' · ');
}

/** Read whether this computer is signed in to a DorkOS account, and as whom. */
export function useDorkosAccountLine(): DorkosAccountLine {
  const status = useCloudStatus();
  const linked = status.data?.linked === true;
  const plan = useCloudPlan({ enabled: linked });

  if (status.data === undefined) return { state: 'loading' };
  if (!linked) return { state: 'signed-out' };
  return {
    state: 'signed-in',
    label: status.data.accountLabel,
    lowCredits: lowCreditsFigure(plan.data),
  };
}
