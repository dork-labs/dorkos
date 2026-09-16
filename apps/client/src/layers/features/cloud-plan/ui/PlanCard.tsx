import { FieldCard, FieldCardContent } from '@/layers/shared/ui';
import type { Entitlements } from '@dork-labs/cloud-api';
import { formatMicro } from '../lib/micro';
import { useCloudPlan } from '../model/use-cloud-plan';

/**
 * How each remote-access mode reads in plain words.
 *
 * These describe the MECHANISM — how the connection behaves — and name no plan
 * and no price, which is exactly the line the contract itself draws: the enum is
 * published because it says how the tunnel works, not what anybody bought. The
 * words are the app's, the value is the service's, and nothing here can drift
 * into a catalog.
 */
const REMOTE_ACCESS_WORDING: Record<Entitlements['limits']['remoteAccess'], string> = {
  byo: 'Bring your own tunnel',
  on_demand: 'Reachable when you open it',
  always_available: 'Always reachable',
};

/** How each custom-address mode reads. Mechanism, like the one above. */
const CUSTOM_ADDRESS_WORDING: Record<Entitlements['limits']['customAddress'], string> = {
  none: 'Not available',
  // "Available separately", not "costs extra": what it costs is the service's to
  // say, on the page that announces it. This says only that it is reachable by a
  // route other than the entitlement above.
  addon: 'Available separately',
  included: 'Included',
};

/** Which support channel this account reaches. */
const SUPPORT_WORDING: Record<Entitlements['limits']['support'], string> = {
  community: 'Community',
  priority: 'Priority',
};

/**
 * The plan card — what this DorkOS account is entitled to.
 *
 * Every plan-shaped string on it comes off the wire: the heading is the
 * service's `planDisplayName`, and every number is a figure the service sent.
 * The app knows no plan names and no prices, which is why this component can
 * render an account on any plan, including one that did not exist when it was
 * written.
 *
 * With no cloud account it renders nothing at all — the panel above it draws the
 * empty state once, for the whole section.
 */
export function PlanCard() {
  // No loading branch here: the panel above gates on the settled read before it
  // renders this at all, so a second skeleton would be unreachable — and two
  // components deciding what "still loading" looks like is how they drift.
  const { data } = useCloudPlan();

  if (!data?.available) return null;

  const { entitlements, balance } = data;
  const { limits, seats } = entitlements;
  const includedCredits = formatMicro(limits.includedCreditsMicro);
  const allowanceLeft = formatMicro(balance?.allowance.remainingMicro);
  const purchasedLeft = formatMicro(balance?.purchased.remainingMicro);
  const owed = formatMicro(balance?.owedMicro);

  return (
    <FieldCard>
      <FieldCardContent className="space-y-4">
        <div>
          <p className="text-muted-foreground text-xs tracking-wide uppercase">Your plan</p>
          {/* The service's own words for what this account is on. */}
          <p className="text-base font-semibold">{entitlements.planDisplayName}</p>
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <Fact
            label="People"
            value={`${entitlements.used.personSeats} of ${limits.personSeatsIncluded}`}
          />
          <Fact
            label="Agents with an address"
            value={`${entitlements.used.agentSeats} of ${limits.agentSeatsIncluded}`}
          />
          <Fact label="Seats assigned" value={`${seats.assigned} of ${seats.total}`} />
          {includedCredits !== null && <Fact label="Included credits" value={includedCredits} />}
          <Fact label="Cloud hours" value={`${limits.cloudHours}`} />
          <Fact label="Storage" value={`${limits.storageGb} GB`} />
          <Fact label="Remote access" value={REMOTE_ACCESS_WORDING[limits.remoteAccess]} />
          <Fact label="Custom address" value={CUSTOM_ADDRESS_WORDING[limits.customAddress]} />
          <Fact label="Support" value={SUPPORT_WORDING[limits.support]} />
        </dl>

        {balance !== null && (
          <div className="border-t pt-3">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              {allowanceLeft !== null && <Fact label="Allowance left" value={allowanceLeft} />}
              {purchasedLeft !== null && <Fact label="Credits bought" value={purchasedLeft} />}
              {/* Debt carried from a turn that overran its reservation. It is
                  never folded quietly into a smaller balance — when it exists it
                  gets its own line. */}
              {owed !== null && owed !== '0.00' && <Fact label="Owed" value={owed} />}
            </dl>
          </div>
        )}

        {/* The permanent, visible distinction between local agents and addressed
            ones. Stated as MECHANISM — what takes a seat — rather than as a
            price, because what anything costs is announced elsewhere and this
            app does not know it. */}
        <p className="text-muted-foreground text-xs">
          Only an agent you give an address takes a seat. Agents that run just on this machine have
          no address and take none.
        </p>
      </FieldCardContent>
    </FieldCard>
  );
}

/**
 * One labelled figure in the card's grid.
 *
 * @param props.label - What the figure is.
 * @param props.value - The figure, already formatted.
 */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
