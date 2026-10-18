/**
 * TanStack Query keys for chat from the web on this computer, shared by the
 * Settings section and the top-bar indicator so a change in one refreshes the
 * other.
 *
 * @module features/web-access/model/query-keys
 */

/** Where the link stands (`GET /api/session-relay/status`). */
export const WEB_ACCESS_STATUS_KEY = ['session-relay', 'status'] as const;

/** Whether someone is using this computer from the web (`GET /api/session-relay/presence`). */
export const WEB_ACCESS_PRESENCE_KEY = ['session-relay', 'presence'] as const;

/** Every browser seen here (`GET /api/session-relay/devices`). */
export const WEB_ACCESS_DEVICES_KEY = ['session-relay', 'devices'] as const;
