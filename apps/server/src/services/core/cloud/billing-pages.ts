/**
 * The web pages where money changes: the billing portal (change or end a plan,
 * payment method, invoices), checkout for one offer, and buying credits; and
 * asking for a copy of everything the account holds, or for the account to be
 * deleted.
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
  AccountDeletionResponseSchema,
  AccountExportResponseSchema,
  HostedPageResponseSchema,
  OffersResponseSchema,
  V1_ROUTES,
  type AccountDeletion,
  type AccountExport,
  type OffersResponse,
} from '@dork-labs/cloud-api';
import { resolveCloudBaseUrl } from '../auth/cloud-link-client.js';
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
  const client = requireClient();
  const route = { portal: V1_ROUTES.portal, checkout: V1_ROUTES.checkout, topup: V1_ROUTES.topup }[
    request.kind
  ];
  const body = request.kind === 'checkout' ? { skuId: request.skuId } : {};
  const page = await client.post(route, HostedPageResponseSchema, { body, signal });
  const url = safePageUrl(page.url);
  if (url === null) {
    throw new Error('The DorkOS account answered with a page address that is not https.');
  }
  return url;
}

/** An account export as this app hands it on: the service's answer, plus whether an email was asked for. */
export type RequestedAccountExport = AccountExport & {
  /** True only when this request asked the service to email the account once the export is ready. */
  emailRequested: boolean;
};

/**
 * Ask for a copy of everything the account holds.
 *
 * **The "it's ready" email is asked for only when the export is not ready.**
 * One request cannot know that beforehand, so this asks first without the
 * email. An answer that already carries a link is the whole job: the person
 * downloads it now, and an email about it would be noise. Only an answer
 * without a link is followed by a second request that asks for the email, and
 * only then may the app say one will come. A service that assembles exports at
 * once never sees the second request. A service that queues them must treat
 * that second request as the same export job, not a new one; the contract
 * does not say so yet.
 *
 * A link is held to the same rule as a billing page; one that fails it is
 * dropped, so the export reads as still being prepared rather than offering a
 * link this app would not open.
 *
 * @param signal - Aborts the requests.
 * @throws When this instance is not linked, or when the service refuses.
 */
export async function requestAccountExport(signal?: AbortSignal): Promise<RequestedAccountExport> {
  const client = requireClient();
  const ask = async (notifyEmail: boolean) => {
    const job = await client.post(V1_ROUTES.accountExport, AccountExportResponseSchema, {
      body: { notifyEmail },
      signal,
    });
    const downloadUrl = job.downloadUrl === null ? null : safePageUrl(job.downloadUrl);
    return {
      job: { ...job, downloadUrl, readyAt: downloadUrl === null ? null : job.readyAt },
      // Whether the service sent any link at all, before this app's own check.
      served: job.downloadUrl !== null,
    };
  };
  const first = await ask(false);
  // A link the service sent means the export is ready, even when it fails the
  // https check above and is dropped: asking again for an email would only
  // announce a link this app will not open.
  if (first.served) return { ...first.job, emailRequested: false };
  // The second request names the same export as the first. A service that
  // queues exports has to treat it as that job, not a new one; the contract
  // does not say so yet, and today's service never gets here, because it
  // answers the first request with a link.
  const second = await ask(true);
  return { ...second.job, emailRequested: true };
}

/**
 * Ask for the account to be deleted.
 *
 * This deletes nothing. The service emails the account's own address a link,
 * and the account is deleted only when the person follows it in their own
 * browser. Once it is, the service refuses this computer's key, and the next
 * heartbeat or link check (`CloudLinkManager.checkLink`) unlinks this computer.
 *
 * @param signal - Aborts the request.
 * @throws When this instance is not linked, or when the service refuses (a
 *   `CloudApiProblemError` the caller can read with `problemOf`).
 */
export async function requestAccountDeletion(signal?: AbortSignal): Promise<AccountDeletion> {
  const client = requireClient();
  return client.post(V1_ROUTES.accountDeletion, AccountDeletionResponseSchema, {
    body: {},
    signal,
  });
}

/** Hosts a local development service may answer from over plain http. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a parsed address is plain http on this machine.
 *
 * @param url - The parsed address.
 */
function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * A page address this app will send a person to, normalised, or `null`.
 *
 * The contract types the address as any URL, which would let a `javascript:`,
 * `data:` or plain-http page through. Only https passes. Plain http passes
 * only on a loopback host, and only while this instance itself talks to a
 * DorkOS account on a loopback host: that is a developer running the service
 * on their own machine, and nothing else.
 *
 * @param url - The address the service answered with.
 */
export function safePageUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === 'https:') return parsed.href;
  if (!isLoopbackHttp(parsed)) return null;
  let service: URL;
  try {
    service = new URL(resolveCloudBaseUrl());
  } catch {
    return null;
  }
  return isLoopbackHttp(service) ? parsed.href : null;
}

/**
 * A live `/v1` client, or a loud failure.
 *
 * @throws When this instance holds no cloud credential.
 */
function requireClient() {
  const client = createCloudV1Client();
  if (client === null) throw new Error('This instance is not linked to a DorkOS account.');
  return client;
}
