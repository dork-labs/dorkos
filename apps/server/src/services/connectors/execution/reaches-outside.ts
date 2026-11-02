/**
 * Whether a connected-app write reaches people outside the team (DOR-3683).
 *
 * At Full autonomy a turn that read an outsider's words still asks a person before a connector
 * action that reaches people outside the team or cannot be undone. Every destructive action
 * cannot be undone, so it asks by its class alone (`destructive-hold-window.ts`). A write is
 * decided here, by the operation and its arguments: a sent or replied email reaches other
 * people, and so does a calendar event with invitees; a draft, a label or a trashed message
 * stays in the account.
 *
 * Written as an allowlist: only the writes named below as staying in the account answer no, and
 * an event answers no only when it shows it notifies nobody. Every other write, today's sends and
 * any write a toolkit adds later, answers yes, so a new one asks until someone decides it here.
 *
 * @module services/connectors/execution/reaches-outside
 */
import type { CapabilityPreflightResult } from '../../core/capabilities/index.js';
import type { AuthorizedConnectorExecution } from './authorization-service.js';

/** Writes that change only the person's own account: drafts, labels, trash, their calendars. */
const STAYS_IN_ACCOUNT: ReadonlySet<string> = new Set([
  'GMAIL_ADD_LABEL_TO_EMAIL',
  'GMAIL_CREATE_EMAIL_DRAFT',
  'GMAIL_CREATE_LABEL',
  'GMAIL_MODIFY_THREAD_LABELS',
  'GMAIL_MOVE_THREAD_TO_TRASH',
  'GMAIL_MOVE_TO_TRASH',
  'GMAIL_PATCH_LABEL',
  'GMAIL_UNTRASH_MESSAGE',
  'GMAIL_UNTRASH_THREAD',
  'GMAIL_UPDATE_DRAFT',
  'GMAIL_UPDATE_LABEL',
  'GMAIL_UPDATE_LANGUAGE_SETTINGS',
  'GOOGLECALENDAR_CALENDARS_UPDATE',
  'GOOGLECALENDAR_CALENDAR_LIST_INSERT',
  'GOOGLECALENDAR_CALENDAR_LIST_PATCH',
  'GOOGLECALENDAR_CALENDAR_LIST_UPDATE',
  'GOOGLECALENDAR_CREATE_CALENDAR',
  'GOOGLECALENDAR_DUPLICATE_CALENDAR',
  'GOOGLECALENDAR_PATCH_CALENDAR',
]);

/** Event writes that reach people only when the event has invitees. */
const NEW_EVENT: ReadonlySet<string> = new Set([
  'GOOGLECALENDAR_CREATE_EVENT',
  'GOOGLECALENDAR_EVENTS_IMPORT',
]);

/**
 * Event writes on an event that may already have invitees, which the arguments cannot show.
 * Google emails them unless the call says to send no updates, so only that call answers no.
 */
const CHANGED_EVENT: ReadonlySet<string> = new Set([
  'GOOGLECALENDAR_PATCH_EVENT',
  'GOOGLECALENDAR_QUICK_ADD',
  'GOOGLECALENDAR_UPDATE_EVENT',
]);

/** An argument naming who an event invites. */
const INVITEE_KEY = /attendee|invitee|guest/i;

/** An argument saying whom Google tells about the change. */
const SEND_UPDATES_KEY = /^send_?updates$/i;

/** Whether a value names anyone: a non-empty string, array or object. */
function namesSomeone(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

/** Whether any argument invites someone. */
function hasInvitees(args: Record<string, unknown>): boolean {
  return Object.entries(args).some(([key, value]) => INVITEE_KEY.test(key) && namesSomeone(value));
}

/** Whether the call says to tell nobody about the change. */
function sendsNoUpdates(args: Record<string, unknown>): boolean {
  return Object.entries(args).some(
    ([key, value]) => SEND_UPDATES_KEY.test(key) && value === 'none'
  );
}

/**
 * Whether one connected-app write reaches people outside the team.
 *
 * @param operationSlug - The provider's operation, e.g. `GMAIL_SEND_EMAIL`.
 * @param args - The validated arguments it runs with.
 * @returns False only for a write that stays in the account; true otherwise.
 */
export function writeReachesOutside(operationSlug: string, args: Record<string, unknown>): boolean {
  const slug = operationSlug.toUpperCase();
  if (STAYS_IN_ACCOUNT.has(slug)) return false;
  if (NEW_EVENT.has(slug)) return hasInvitees(args);
  if (CHANGED_EVENT.has(slug)) return hasInvitees(args) || !sendsNoUpdates(args);
  return true;
}

/**
 * The preflight result the registry's gates read, from one authorized connector call: its
 * authority, its card, and whether it reaches people outside or cannot be undone. A read reaches
 * nobody, a destructive action cannot be undone, and a write is decided by what it does.
 *
 * @param authorized - The call the authorization service just prepared.
 */
export function preflightResultOf(
  authorized: Pick<
    AuthorizedConnectorExecution,
    'authorityBinding' | 'serviceAction' | 'operation' | 'arguments'
  >
): CapabilityPreflightResult {
  const { capabilityClassification, operationSlug } = authorized.operation;
  return {
    authorityBinding: authorized.authorityBinding,
    approvalServiceAction: authorized.serviceAction,
    outward:
      capabilityClassification === 'read'
        ? false
        : capabilityClassification === 'destructive' ||
          writeReachesOutside(operationSlug, authorized.arguments),
  };
}
