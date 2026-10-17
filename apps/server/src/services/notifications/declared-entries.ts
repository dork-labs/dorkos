/**
 * The notification kinds declared beside their emitters rather than inline in
 * `notification-registry.ts`, joined in one place so the registry reads them
 * as one spread and one payload type.
 *
 * - `connector-hold-notifications.ts`: an agent's held irreversible action in
 *   a connected app (DOR-2739).
 * - `web-device-notifications.ts`: a new browser used chat from the web here
 *   (DOR-2946).
 * - `community-notifications.ts`: a space's teammates reached their monthly
 *   limit, or it was changed (DOR-2956).
 *
 * @module services/notifications/declared-entries
 */
import {
  CONNECTOR_HOLD_ENTRIES,
  type ConnectorHoldPayloads,
} from './connector-hold-notifications.js';
import {
  COMMUNITY_NOTIFICATION_ENTRIES,
  type CommunityNotificationPayloads,
} from './community-notifications.js';
import { WEB_DEVICE_ENTRIES, type WebDevicePayloads } from './web-device-notifications.js';

/** The payloads of every declared kind, joined into `NotificationPayloads`. */
export interface DeclaredPayloads extends ConnectorHoldPayloads,
    WebDevicePayloads,
    CommunityNotificationPayloads {}

/** Every declared entry, spread into the registry's `ENTRIES`. */
export const DECLARED_ENTRIES = {
  ...CONNECTOR_HOLD_ENTRIES,
  ...WEB_DEVICE_ENTRIES,
  ...COMMUNITY_NOTIFICATION_ENTRIES,
};
