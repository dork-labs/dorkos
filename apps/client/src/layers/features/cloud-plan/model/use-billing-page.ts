/**
 * Money changes on the web: open the billing portal, checkout for one offer,
 * or the page that buys credits, in the person's own browser.
 *
 * The app asks this DorkOS for a short-lived page address and sends a window
 * there. It never takes a payment, never names a price of its own and never
 * keeps the address: the address goes straight into the window and is
 * dropped, out of React state and out of the query cache.
 *
 * @module features/cloud-plan/model/use-billing-page
 */
import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Problem } from '@dork-labs/cloud-api';
import type { CloudBillingPage, CloudOffersResponse } from '@dorkos/shared/cloud-schemas';
import { openExternalWindowLater } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { cloudPlanKeys } from './use-cloud-plan';

/** Something to tell the person: the service's own refusal, or one sentence of ours. */
export type BillingNotice = { problem: Problem } | { message: string };

/** Said when this DorkOS or the account could not be reached. */
export const BILLING_UNREACHABLE: BillingNotice = {
  message: 'Couldn’t reach your DorkOS account. Try again.',
};

/** Said when the browser refused to open the window. */
export const BILLING_POPUP_BLOCKED: BillingNotice = {
  message: 'Your browser blocked the new window. Allow pop-ups for DorkOS, then try again.',
};

/** Which page is being opened, and for which offer. */
export interface BillingPageTarget {
  page: CloudBillingPage;
  /** The offer, for a checkout. */
  skuId?: string;
}

/** What a billing button needs. */
export interface OpenBillingPage {
  /** Open the page. Call it from the click itself, or a browser blocks the window. */
  open: (target: BillingPageTarget) => void;
  /** The page being fetched right now, or `null`. One at a time. */
  pending: BillingPageTarget | null;
  /** Why the last attempt did not open, or `null`. */
  notice: BillingNotice | null;
}

/**
 * Open billing pages in the browser, one at a time.
 *
 * The window opens in the click and is pointed at the address when it
 * arrives ({@link openExternalWindowLater}; the desktop app hands it to the
 * system browser instead). A refusal closes the waiting window and is kept as
 * a notice in the service's own words.
 */
export function useOpenBillingPage(): OpenBillingPage {
  const transport = useTransport();
  const [pending, setPending] = useState<BillingPageTarget | null>(null);
  const [notice, setNotice] = useState<BillingNotice | null>(null);
  // A ref, not the state above: two presses inside one render would both see
  // `pending` as null and open two windows.
  const busy = useRef(false);

  const open = useCallback(
    (target: BillingPageTarget) => {
      if (busy.current) return;
      const win = openExternalWindowLater();
      if (win === null) {
        setNotice(BILLING_POPUP_BLOCKED);
        return;
      }
      busy.current = true;
      setPending(target);
      setNotice(null);
      transport
        .getCloudBillingPage(target.page, target.skuId)
        .then((answer) => {
          if (!answer.ok) {
            win.close();
            setNotice(
              'problem' in answer ? { problem: answer.problem } : { message: answer.message }
            );
            return;
          }
          // Straight into the waiting window, never stored.
          win.go(answer.url);
        })
        .catch(() => {
          win.close();
          setNotice(BILLING_UNREACHABLE);
        })
        .finally(() => {
          busy.current = false;
          setPending(null);
        });
    },
    [transport]
  );

  return { open, pending, notice };
}

/** How long the offers stay fresh. What is on sale does not move minute to minute. */
const OFFERS_STALE_MS = 60_000;

/** Read what the service will sell this account, in the service's order. */
export function useCloudOffers() {
  const transport = useTransport();
  return useQuery<CloudOffersResponse>({
    queryKey: cloudPlanKeys.offers(),
    queryFn: () => transport.getCloudOffers(),
    staleTime: OFFERS_STALE_MS,
  });
}
