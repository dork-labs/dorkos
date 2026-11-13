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
 * - `browser-handoff-notifications.ts`: an agent handed a person the Agent browser
 *   (DOR-3218).
 * - `shell-check-notifications.ts`: the check on agents' shell commands can't
 *   start (DOR-3300).
 * - `session/chat-messages/report-undelivered-notice.ts`: a spin-off report
 *   never reached its parent chat (DOR-3561).
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
import { SHELL_CHECK_ENTRIES, type ShellCheckPayloads } from './shell-check-notifications.js';
import {
  REPORT_UNDELIVERED_ENTRIES,
  type ReportUndeliveredPayloads,
} from '../session/chat-messages/report-undelivered-notice.js';

import {
  BROWSER_HANDOFF_ENTRIES,
  type BrowserHandoffPayloads,
} from './browser-handoff-notifications.js';
import { ACCESS_CHANGE_ENTRIES, type AccessChangePayloads } from './access-change-notifications.js';
import {
  MCP_TOOL_ADDED_ENTRIES,
  type McpToolAddedPayloads,
} from '../mesh/global-mcp/global-mcp-tool-added-notice.js';
import {
  MCP_RESERVED_NAME_ENTRIES,
  type McpReservedNamePayloads,
} from '../mesh/global-mcp/global-mcp-reserved-name-notice.js';

/** The payloads of every declared kind, joined into `NotificationPayloads`. */
export interface DeclaredPayloads
  extends
    ConnectorHoldPayloads,
    WebDevicePayloads,
    CommunityNotificationPayloads,
    SecretFilePayloads,
    AccountSigninPayloads,
    BrowserHandoffPayloads,
    ShellCheckPayloads,
    ReportUndeliveredPayloads,
    AccessChangePayloads,
    McpToolAddedPayloads,
    McpReservedNamePayloads {}

/** Every declared entry, spread into the registry's `ENTRIES`. */
export const DECLARED_ENTRIES = {
  ...CONNECTOR_HOLD_ENTRIES,
  ...WEB_DEVICE_ENTRIES,
  ...COMMUNITY_NOTIFICATION_ENTRIES,
  ...SECRET_FILE_ENTRIES,
  ...ACCOUNT_SIGNIN_ENTRIES,
  ...BROWSER_HANDOFF_ENTRIES,
  ...SHELL_CHECK_ENTRIES,
  ...REPORT_UNDELIVERED_ENTRIES,
  ...ACCESS_CHANGE_ENTRIES,
  ...MCP_TOOL_ADDED_ENTRIES,
  ...MCP_RESERVED_NAME_ENTRIES,
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
  'browser.handoff',
  'shell.check_down',
  'report.undelivered',
  'connector.access_narrowed',
  'mcp-server.tool_added',
  'mcp-server.reserved_name',
] as const;
