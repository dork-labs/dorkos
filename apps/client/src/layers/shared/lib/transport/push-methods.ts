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
import { LIST_PAGE_LIMIT, readAllPages } from '../read-all-pages';
import { createTransportApiClient } from './api-client';

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

    // The list pages (DOR-4982), newest first; Settings shows it whole, in that order.
    async listPushSubscriptions(): Promise<Pick<ListPushSubscriptionsResponse, 'subscriptions'>> {
      const { rows } = await readAllPages(
        (cursor) =>
          api.call('push.listSubscriptions', { query: { cursor, limit: LIST_PAGE_LIMIT } }),
        (page) => page.subscriptions,
        '/push/subscriptions'
      );
      return { subscriptions: rows };
    },

    deletePushSubscription(id: string): Promise<DeletePushSubscriptionResponse> {
      return api.call('push.deleteSubscriptions', { path: { id } });
    },
  };
}
