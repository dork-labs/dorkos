import { Skeleton } from '@/layers/shared/ui';
import { useCloudPlan } from '../model/use-cloud-plan';
import { CreditsGauge } from './CreditsGauge';
import { CreditsSource } from './CreditsSource';
import { PlanCard } from './PlanCard';
import { SeatManagement } from './SeatManagement';
import { UpgradeNudge } from './UpgradeNudge';

/**
 * The plan-aware section of Settings — everything this DorkOS account is
 * entitled to, what it has spent, and the seats it holds.
 *
 * It sits directly under the account-link panel, which is the point: the device
 * link is the door, and this is the room behind it. Before anybody walks
 * through, this renders one plain line instead of four empty cards.
 *
 * The whole section is catalog-blind. It knows no plan names and no prices; the
 * heading on the card, the words on a refusal and every figure on screen are
 * what the service sent.
 */
export function CloudPlanPanel() {
  const { data, isError, isPending } = useCloudPlan();

  // NOTHING is known until the read settles, and "not known yet" is not "not
  // linked". Deciding before then flashes "link this instance to a DorkOS
  // account" at somebody who linked months ago, on every single Settings open —
  // a sentence that is not merely premature but false. A skeleton says the one
  // true thing available: the answer is coming.
  if (isPending) return <Skeleton className="h-40 w-full" />;

  // An outage is NOT "you have no account". Telling a linked, paying person to
  // link their account because the service was briefly unwell is worse than
  // saying nothing, so the two states are separate branches.
  if (isError) {
    return (
      <p className="text-muted-foreground text-sm">
        Couldn’t reach your DorkOS account just now. Your local agents are unaffected.
      </p>
    );
  }

  if (!data?.available) {
    return (
      <p className="text-muted-foreground text-sm">
        Link this instance to a DorkOS account above to see what it includes, what you have spent,
        and the seats you hold.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* Above the cards, with no action of its own — it never stands between
          somebody and paying. */}
      <UpgradeNudge />
      <PlanCard />
      <CreditsGauge />
      <CreditsSource />
      <SeatManagement />
    </div>
  );
}
