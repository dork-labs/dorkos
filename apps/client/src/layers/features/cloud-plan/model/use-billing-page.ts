/**
 * Money changes on the web: open the billing portal, checkout for one offer,
 * or the page that buys credits, in the person's own browser. Beside them, ask
 * for a copy of everything the account holds.
 *
 * The app asks this DorkOS for a short-lived page address and sends a window
 * there. It never takes a payment, never names a price of its own and never
 * keeps the address: the address goes straight into the window and is
 * dropped, out of React state and out of the query cache.
 *
 * @module features/cloud-plan/model/use-billing-page
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Problem } from '@dork-labs/cloud-api';
import type {
  CloudAccountExport,
  CloudBillingPage,
  CloudOffersResponse,
} from '@dorkos/shared/cloud-schemas';
import { openExternalLink, openExternalWindowLater } from '@/layers/shared/lib';
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
  const queryClient = useQueryClient();
  const refreshOnReturn = useRefreshPlanOnReturn();
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
        .createCloudBillingSession(target.page, target.skuId)
        .then((answer) => {
          if (!answer.ok) {
            win.close();
            // A refused checkout may mean the offer left the list since it
            // was read; read the list again.
            if (target.page === 'checkout') {
              void queryClient.invalidateQueries({ queryKey: cloudPlanKeys.offers() });
            }
            setNotice(
              'problem' in answer ? { problem: answer.problem } : { message: answer.message }
            );
            return;
          }
          // Straight into the waiting window, never stored.
          if (win.go(answer.url)) refreshOnReturn();
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
    [transport, queryClient, refreshOnReturn]
  );

  return { open, pending, notice };
}

/**
 * Refresh every plan read the next time this window gets focus.
 *
 * A billing page changes the plan, the balance or both somewhere this app
 * cannot see, and the person comes back to it by switching windows. One
 * listener at a time, removed after it fires and when the component goes.
 *
 * @returns Arms the refresh.
 */
function useRefreshPlanOnReturn(): () => void {
  const queryClient = useQueryClient();
  const disarm = useRef<(() => void) | null>(null);
  useEffect(() => () => disarm.current?.(), []);
  return useCallback(() => {
    disarm.current?.();
    const onFocus = () => {
      disarm.current?.();
      void queryClient.invalidateQueries({ queryKey: cloudPlanKeys.all });
    };
    window.addEventListener('focus', onFocus);
    disarm.current = () => {
      window.removeEventListener('focus', onFocus);
      disarm.current = null;
    };
  }, [queryClient]);
}

/** Where an account export stands in this view. */
export type AccountExportState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'requested'; export: CloudAccountExport }
  | { kind: 'failed'; notice: BillingNotice };

/** What the export control needs. */
export interface AccountExportControl {
  state: AccountExportState;
  /** Ask for the export. Ignored while a request is in flight. */
  request: () => void;
  /** Open the download link, when the export is ready. */
  download: () => void;
}

/**
 * Ask for a copy of everything the account holds, and say honestly where it
 * stands: asked for and being prepared, ready with its link, or refused.
 *
 * The link stays in this hook's own state for the life of the view; it is
 * never written to the query cache, and it is opened from a press.
 */
export function useAccountExport(): AccountExportControl {
  const transport = useTransport();
  const [state, setState] = useState<AccountExportState>({ kind: 'idle' });
  const busy = useRef(false);

  const request = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setState({ kind: 'requesting' });
    transport
      .requestCloudAccountExport()
      .then((answer) => {
        if (answer.ok) setState({ kind: 'requested', export: answer.export });
        else
          setState({
            kind: 'failed',
            notice: 'problem' in answer ? { problem: answer.problem } : { message: answer.message },
          });
      })
      .catch(() => setState({ kind: 'failed', notice: BILLING_UNREACHABLE }))
      .finally(() => {
        busy.current = false;
      });
  }, [transport]);

  const download = useCallback(() => {
    if (state.kind === 'requested' && state.export.downloadUrl !== null) {
      openExternalLink(state.export.downloadUrl);
    }
  }, [state]);

  return { state, request, download };
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
