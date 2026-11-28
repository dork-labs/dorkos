/**
 * Inbox Transport method factory (spec `notification-system`).
 *
 * Three calls and no more: read a page, mark one read, mark them all read.
 * Everything else the Inbox does — a row arriving, a badge clearing on the other
 * device — rides the global SSE stream, so there is nothing to poll here.
 * All three go through the generated API client (DOR-5473).
 *
 * @module shared/lib/transport/notification-methods
 */
import type {
  ListNotificationsQuery,
  ListNotificationsResponse,
  MarkNotificationsReadResponse,
} from '@dorkos/shared/notification-schemas';
import { createTransportApiClient } from './api-client';

/**
 * Create the notification methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createNotificationMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    listNotifications(query?: Partial<ListNotificationsQuery>): Promise<ListNotificationsResponse> {
      const values = {
        limit: query?.limit,
        cursor: query?.cursor,
        agentId: query?.agentId,
        sessionId: query?.sessionId,
        // Comma-joined, the flat spelling the route parses and the same one
        // `ListActivityQuery.categories` uses. An empty list is not a filter,
        // so it sends nothing rather than `kind=`.
        kind: query?.kind !== undefined && query.kind.length > 0 ? query.kind.join(',') : undefined,
        // The route parses the literal strings rather than coercing, so an
        // absent lens must send nothing at all: `unread=false` and no `unread`
        // mean the same thing, and sending `false` for every unfiltered read
        // would put a meaningless parameter in every URL.
        unread: query?.unread === true ? ('true' as const) : undefined,
      };
      return api.call('notifications.list', { query: values });
    },

    markNotificationRead(id: string): Promise<MarkNotificationsReadResponse> {
      return api.call('notifications.mark_read', { path: { id }, body: { read: true } });
    },

    markAllNotificationsRead(): Promise<MarkNotificationsReadResponse> {
      return api.call('notifications.mark_all_read', { body: { read: true } });
    },
  };
}
