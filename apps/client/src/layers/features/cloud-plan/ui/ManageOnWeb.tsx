import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { formatMoney } from '@dork-labs/cloud-api/display';
import type { CloudBillingPage } from '@dorkos/shared/cloud-schemas';
import { openExternalLink } from '@/layers/shared/lib';
import { Badge, Button, FieldCard, FieldCardContent } from '@/layers/shared/ui';
import {
  useCloudOffers,
  useOpenBillingPage,
  type BillingNotice,
  type OpenBillingPage,
} from '../model/use-billing-page';
import { useCloudPlan } from '../model/use-cloud-plan';

/** How each offer interval reads after its price. Mechanism, not catalog. */
const INTERVAL_WORDING: Record<string, string> = {
  month: 'a month',
  year: 'a year',
};

/**
 * Where money changes: the billing portal, buying credits and changing plan,
 * each a page in the person's own browser.
 *
 * Self-contained so it can sit wherever account settings live. It owns one
 * {@link useOpenBillingPage} and shares it with every button inside, so only
 * one page opens at a time and one notice explains a refusal.
 *
 * Every plan name and price on it is what the service sent. With no cloud
 * account it renders nothing.
 */
export function ManageOnWeb() {
  const { data } = useCloudPlan();
  const billing = useOpenBillingPage();

  if (!data?.available) return null;

  return (
    <FieldCard>
      <FieldCardContent className="space-y-4">
        <div>
          <p className="text-muted-foreground text-xs tracking-wide uppercase">Manage on the web</p>
          <p className="text-muted-foreground text-sm">
            Payments happen on the DorkOS website. Each of these opens in your browser.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <BillingPageButton billing={billing} page="portal">
            Billing and invoices
          </BillingPageButton>
          <BillingPageButton billing={billing} page="topup">
            Add credits
          </BillingPageButton>
        </div>
        <PlanOffers billing={billing} currentPlanId={data.entitlements.planId} />
        <BillingNoticeView notice={billing.notice} />
      </FieldCardContent>
    </FieldCard>
  );
}

/** Props for {@link BillingPageButton}. */
export interface BillingPageButtonProps {
  /** The shared opener, from {@link useOpenBillingPage}. */
  billing: OpenBillingPage;
  /** Which page the button opens. */
  page: Exclude<CloudBillingPage, 'checkout'>;
  /** The button's words. */
  children: ReactNode;
}

/**
 * One button that opens a billing page in the browser.
 *
 * @param props - The opener, the page and the words.
 */
export function BillingPageButton({ billing, page, children }: BillingPageButtonProps) {
  const opening = billing.pending?.page === page;
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={billing.pending !== null}
      aria-busy={opening}
      onClick={() => billing.open({ page })}
    >
      {opening ? 'Opening…' : children}
      <ExternalLink className="size-3.5" aria-hidden />
    </Button>
  );
}

/** Props for {@link PlanOffers}. */
export interface PlanOffersProps {
  /** The shared opener, from {@link useOpenBillingPage}. */
  billing: OpenBillingPage;
  /** The account's current plan, to mark it instead of offering it again. */
  currentPlanId: string;
}

/**
 * What the account could switch to, each with a button to its checkout page.
 *
 * In the order the service sent, never re-sorted, with nothing marked as
 * recommended: the list is the service's and so is its order. A price the app
 * cannot read is left out rather than guessed; the checkout page shows it.
 * Nothing on sale renders nothing.
 *
 * @param props - The opener and the current plan.
 */
export function PlanOffers({ billing, currentPlanId }: PlanOffersProps) {
  const { data } = useCloudOffers();
  if (!data?.available || data.offers.offers.length === 0) return null;
  const { offers, denomination } = data.offers;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Change plan</p>
      <ul className="divide-y rounded-md border">
        {offers.map((offer) => {
          const price = denomination ? formatMoney(offer.amountMicro, denomination) : null;
          const interval = INTERVAL_WORDING[offer.interval];
          const current = offer.planId === currentPlanId;
          const opening = billing.pending?.skuId === offer.skuId;
          return (
            <li
              key={offer.skuId}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{offer.displayName}</p>
                {price !== null && (
                  <p className="text-muted-foreground text-xs">
                    {interval ? `${price} ${interval}` : price}
                  </p>
                )}
              </div>
              {current ? (
                <Badge variant="secondary">Your plan</Badge>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={billing.pending !== null}
                  aria-busy={opening}
                  aria-label={`Choose ${offer.displayName}${interval ? `, billed ${interval}` : ''}`}
                  onClick={() => billing.open({ page: 'checkout', skuId: offer.skuId })}
                >
                  {opening ? 'Opening…' : 'Choose'}
                  <ExternalLink className="size-3.5" aria-hidden />
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Why a billing page did not open: the service's own words, with its own
 * link when it gave one, or one plain sentence of ours.
 *
 * The link opens straight from the click, so no browser counts it as a pop-up.
 *
 * @param props.notice - What to say, or `null` for nothing.
 */
export function BillingNoticeView({ notice }: { notice: BillingNotice | null }) {
  if (notice === null) return null;
  if ('message' in notice) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {notice.message}
      </p>
    );
  }
  const { title, detail, requiredPlanDisplayName, actionUrl, actionLabel } = notice.problem;
  return (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 space-y-1 rounded-md border px-3 py-2"
    >
      {/* Every word below is the service's. */}
      <p className="text-sm font-medium">{title}</p>
      {detail !== undefined && <p className="text-sm">{detail}</p>}
      {requiredPlanDisplayName !== undefined && (
        <p className="text-muted-foreground text-sm">This needs {requiredPlanDisplayName}.</p>
      )}
      {actionUrl !== undefined && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => openExternalLink(actionUrl)}
        >
          {actionLabel ?? 'Open your account'}
          <ExternalLink className="size-3.5" aria-hidden />
        </Button>
      )}
    </div>
  );
}
