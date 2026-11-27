/**
 * Web push Transport method factory (spec `notification-system` task 4.3),
 * through the generated API client (DOR-5473).
 *
 * Four calls: read the key a browser needs before it can subscribe, hand over a
 * subscription, list the ones this install has, and drop one. Nothing streams —
 * a push arrives at the service worker, not at the app.
 *
 * @module shared/lib/transport/push-methods
 */
import type {
  DeletePushSubscriptionResponse,
  ListPushSubscriptionsResponse,
  RegisterPushSubscriptionRequest,
  RegisterPushSubscriptionResponse,
  VapidPublicKeyResponse,
} from '@dorkos/shared/notification-schemas';
import { createTransportApiClient } from './api-client';
import { fetchAllPages } from './http-client';

/**
 * Create the web push methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createPushMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    getPushVapidPublicKey(): Promise<VapidPublicKeyResponse> {
      return api.call('push.getVapidPublicKey', {});
    },

    registerPushSubscription(
      subscription: RegisterPushSubscriptionRequest
    ): Promise<RegisterPushSubscriptionResponse> {
      return api.call('push.createSubscriptions', { body: subscription });
    },

    // Stays on fetchAllPages: the list pages (DOR-4982), and the read-all loop owns the cursor.
    // It comes in pages, newest first; Settings shows it whole, in that order.
    async listPushSubscriptions(): Promise<Pick<ListPushSubscriptionsResponse, 'subscriptions'>> {
      const { rows } = await fetchAllPages(
        baseUrl,
        '/push/subscriptions',
        {},
        (page: ListPushSubscriptionsResponse) => page.subscriptions
      );
      return { subscriptions: rows };
    },

    deletePushSubscription(id: string): Promise<DeletePushSubscriptionResponse> {
      return api.call('push.deleteSubscriptions', { path: { id } });
    },
  };
}
