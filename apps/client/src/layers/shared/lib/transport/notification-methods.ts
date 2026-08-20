/**
 * Inbox Transport method factory (spec `notification-system`).
 *
 * Three calls and no more: read a page, mark one read, mark them all read.
 * Everything else the Inbox does — a row arriving, a badge clearing on the other
 * device — rides the global SSE stream, so there is nothing to poll here.
 *
 * @module shared/lib/transport/notification-methods
 */
import type {
  ListNotificationsQuery,
  ListNotificationsResponse,
  MarkNotificationsReadResponse,
} from '@dorkos/shared/notification-schemas';
import { fetchJSON, buildQueryString } from './http-client';

/**
 * Create the notification methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createNotificationMethods(baseUrl: string) {
  return {
    listNotifications(query?: Partial<ListNotificationsQuery>): Promise<ListNotificationsResponse> {
      const qs = buildQueryString({
        limit: query?.limit,
        before: query?.before,
        agentId: query?.agentId,
        sessionId: query?.sessionId,
        kind: query?.kind,
        // The route parses the literal strings rather than coercing, so an
        // absent lens must send nothing at all: `unread=false` and no `unread`
        // mean the same thing, and sending `false` for every unfiltered read
        // would put a meaningless parameter in every URL.
        unread: query?.unread === true ? 'true' : undefined,
      });
      return fetchJSON<ListNotificationsResponse>(baseUrl, `/notifications${qs}`);
    },

    markNotificationRead(id: string): Promise<MarkNotificationsReadResponse> {
      return fetchJSON<MarkNotificationsReadResponse>(
        baseUrl,
        `/notifications/${encodeURIComponent(id)}/read`,
        { method: 'PATCH' }
      );
    },

    markAllNotificationsRead(): Promise<MarkNotificationsReadResponse> {
      return fetchJSON<MarkNotificationsReadResponse>(baseUrl, '/notifications/read-all', {
        method: 'POST',
      });
    },
  };
}
