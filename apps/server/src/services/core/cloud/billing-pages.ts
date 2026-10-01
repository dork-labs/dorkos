/**
 * The web pages where money changes: the billing portal (change or end a plan,
 * payment method, invoices), checkout for one offer, and buying credits.
 *
 * The app never takes a payment and never names what anything costs. Each call
 * here asks the service for a short-lived page address and hands back only
 * that address; the person finishes in their own browser. The list of offers
 * is the one read here, and it is passed through as the service sent it, in
 * the service's order, so a page can show what is on sale without the app
 * knowing a single plan or price.
 *
 * Writes fail loudly rather than degrading: a request to open a page that
 * quietly did nothing would leave the person staring at a button. The route
 * above turns a refusal into the service's own words.
 *
 * @module services/core/cloud/billing-pages
 */
import {
  HostedPageResponseSchema,
  OffersResponseSchema,
  V1_ROUTES,
  type OffersResponse,
} from '@dork-labs/cloud-api';
import { createCloudV1Client, readOrNull } from './v1-client.js';

/** Which hosted page to open. */
export type BillingPageKind = 'portal' | 'checkout' | 'topup';

/** What the caller asks for. `skuId` is required for checkout and ignored otherwise. */
export interface BillingPageRequest {
  kind: BillingPageKind;
  /** An opaque identifier from {@link readOffers}; never built by the app. */
  skuId?: string;
}

/**
 * Everything the service will sell this account right now, or `null` when this
 * instance is not linked or the service does not serve the list.
 *
 * @param signal - Aborts the request.
 */
export async function readOffers(signal?: AbortSignal): Promise<OffersResponse | null> {
  return readOrNull((client) => client.get(V1_ROUTES.offers, OffersResponseSchema, { signal }));
}

/**
 * Ask the service for one hosted page and return its address.
 *
 * No return address is sent. Where the page sends the person afterwards is the
 * service's decision, and this instance's own address (a loopback port, a
 * tunnel) is nothing the service should be asked to trust.
 *
 * The top-up names no amount: the person chooses it on the page, so the app
 * never holds a figure of its own about what credit costs.
 *
 * @param request - Which page, and the offer for a checkout.
 * @param signal - Aborts the request.
 * @throws When this instance is not linked, when the answer is not an https
 *   address, or when the service refuses (a `CloudApiProblemError` the caller
 *   can read with `problemOf`).
 */
export async function openBillingPage(
  request: BillingPageRequest,
  signal?: AbortSignal
): Promise<string> {
  const client = createCloudV1Client();
  if (client === null) throw new Error('This instance is not linked to a DorkOS account.');
  const route = { portal: V1_ROUTES.portal, checkout: V1_ROUTES.checkout, topup: V1_ROUTES.topup }[
    request.kind
  ];
  const body = request.kind === 'checkout' ? { skuId: request.skuId } : {};
  const page = await client.post(route, HostedPageResponseSchema, { body, signal });
  if (!isSafePageUrl(page.url)) {
    throw new Error('The DorkOS account answered with a page address that is not https.');
  }
  return page.url;
}

/** Hosts a local development service may answer from over plain http. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a page address is one this app will send a person to.
 *
 * The contract types the address as any URL, which would let a `javascript:`
 * or plain-http payment page through. Only https passes, plus http on a
 * loopback host, which is a service running on the developer's own machine.
 *
 * @param url - The address the service answered with.
 */
export function isSafePageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}
