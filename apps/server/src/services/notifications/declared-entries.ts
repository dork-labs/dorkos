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
 * - `account-signin-notifications.ts`: a Claude folder's sign-in is new or
 *   changed (DOR-3245).
 *
 * @module services/notifications/declared-entries
 */
import {
  CONNECTOR_HOLD_ENTRIES,
  type ConnectorHoldPayloads,
} from './connector-hold-notifications.js';
import {
  COMMUNITY_NOTIFICATION_ENTRIES,
  COMMUNITY_NOTIFICATION_KINDS,
  type CommunityNotificationPayloads,
} from './community-notifications.js';
import { WEB_DEVICE_ENTRIES, type WebDevicePayloads } from './web-device-notifications.js';
import { SECRET_FILE_ENTRIES, type SecretFilePayloads } from './secret-file-notifications.js';
import {
  ACCOUNT_SIGNIN_ENTRIES,
  type AccountSigninPayloads,
} from './account-signin-notifications.js';

/** The payloads of every declared kind, joined into `NotificationPayloads`. */
export interface DeclaredPayloads
  extends
    ConnectorHoldPayloads,
    WebDevicePayloads,
    CommunityNotificationPayloads,
    SecretFilePayloads,
    AccountSigninPayloads {}

/** Every declared entry, spread into the registry's `ENTRIES`. */
export const DECLARED_ENTRIES = {
  ...CONNECTOR_HOLD_ENTRIES,
  ...WEB_DEVICE_ENTRIES,
  ...COMMUNITY_NOTIFICATION_ENTRIES,
  ...SECRET_FILE_ENTRIES,
  ...ACCOUNT_SIGNIN_ENTRIES,
};

/**
 * The declared kinds that something raises today, joined into the registry's
 * `WIRED_NOTIFICATION_KINDS`.
 */
export const DECLARED_WIRED_KINDS = [
  ...COMMUNITY_NOTIFICATION_KINDS,
  'connector.destructive_pending',
  'connector.destructive_executed',
  'web.new_device',
  'agent.secret_files',
  'account.signin_review',
] as const;
