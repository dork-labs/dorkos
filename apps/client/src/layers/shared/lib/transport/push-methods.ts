/**
 * Web push Transport method factory (spec `notification-system` task 4.3).
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
import { fetchJSON } from './http-client';

/**
 * Create the web push methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createPushMethods(baseUrl: string) {
  return {
    getPushVapidPublicKey(): Promise<VapidPublicKeyResponse> {
      return fetchJSON<VapidPublicKeyResponse>(baseUrl, '/push/vapid-public-key');
    },

    registerPushSubscription(
      subscription: RegisterPushSubscriptionRequest
    ): Promise<RegisterPushSubscriptionResponse> {
      return fetchJSON<RegisterPushSubscriptionResponse>(baseUrl, '/push/subscriptions', {
        method: 'POST',
        body: JSON.stringify(subscription),
      });
    },

    listPushSubscriptions(): Promise<ListPushSubscriptionsResponse> {
      return fetchJSON<ListPushSubscriptionsResponse>(baseUrl, '/push/subscriptions');
    },

    deletePushSubscription(id: string): Promise<DeletePushSubscriptionResponse> {
      return fetchJSON<DeletePushSubscriptionResponse>(
        baseUrl,
        `/push/subscriptions/${encodeURIComponent(id)}`,
        { method: 'DELETE' }
      );
    },
  };
}
