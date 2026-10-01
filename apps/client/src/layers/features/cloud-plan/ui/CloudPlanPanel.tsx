import { Skeleton } from '@/layers/shared/ui';
import { useCloudPlan } from '../model/use-cloud-plan';
import { AccountContents } from './AccountContents';
import { CreditsGauge } from './CreditsGauge';
import { PlanCard } from './PlanCard';
import { SeatManagement } from './SeatManagement';
import { UpgradeNudge } from './UpgradeNudge';
import { UseCreditsFor } from './UseCreditsFor';

/**
 * The signed-in half of Settings › DorkOS account — what the account includes,
 * what it has, what runs on it, and the seats it holds, in that order: Plan,
 * Credits, Use credits for, What's on your account, Seats.
 *
 * It renders only once this computer is linked (the link panel around it shows
 * the signed-out page otherwise), so nothing here has to say "link first".
 *
 * The whole section is catalog-blind. It knows no plan names and no prices; the
 * heading on the card, the words on a refusal and every figure on screen are
 * what the service sent.
 */
export function CloudPlanPanel() {
  const { data, isError, isPending } = useCloudPlan();

  // NOTHING is known until the read settles. A skeleton says the one true
  // thing available: the answer is coming.
  if (isPending) return <Skeleton className="h-40 w-full" />;

  // An outage is NOT "you have no account". Telling a linked, paying person
  // anything else because the service was briefly unwell is worse than saying
  // nothing, so the two states are separate branches.
  if (isError) {
    return (
      <p className="text-muted-foreground text-sm">
        Couldn’t reach your DorkOS account just now. Your local agents are unaffected.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {data.available ? (
        <>
          {/* Above the cards, with no action of its own — it never stands
              between somebody and paying. */}
          <UpgradeNudge />
          <PlanCard />
          <CreditsGauge />
        </>
      ) : (
        // Linked, but the service has no plan to describe for this account.
        <p className="text-muted-foreground text-sm">
          Your DorkOS account has no plan details to show yet.
        </p>
      )}
      <UseCreditsFor />
      <AccountContents />
      <SeatManagement />
    </div>
  );
}
