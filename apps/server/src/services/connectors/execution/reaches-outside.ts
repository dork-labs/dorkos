/**
 * Whether a connected-app write reaches people outside the team (DOR-3683).
 *
 * At Full autonomy a turn that read an outsider's words still asks a person before a connector
 * action that reaches people outside the team or cannot be undone. Every destructive action
 * cannot be undone, so it asks by its class alone (`destructive-hold-window.ts`). A write is
 * decided here, by the operation and its arguments: a sent or replied email reaches other
 * people, and so does a new calendar event with invitees or any changed one; a draft, a label or a trashed message
 * stays in the account.
 *
 * Written as an allowlist: only the writes named below as staying in the account answer no, and
 * a new event answers no only when it names nobody. A changed event always answers yes. Every
 * other write, today's sends and any write a toolkit adds later, answers yes, so a new one asks
 * until someone decides it here.
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

/**
 * New events, which reach people only when they invite someone. Nothing the agent writes can
 * make one answer no while it names a person: an invitee field or an email address anywhere in
 * the arguments counts.
 */
const NEW_EVENT: ReadonlySet<string> = new Set([
  'GOOGLECALENDAR_CREATE_EVENT',
  'GOOGLECALENDAR_EVENTS_IMPORT',
]);

/** An argument naming who an event invites. */
const INVITEE_KEY = /attendee|invitee|guest/i;

/** Something shaped like an email address. */
const EMAIL = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]+/;

/** Whether a value names anyone: a non-empty string, array or object. */
function namesSomeone(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

/** Whether any string in a value, however deep, holds an email address. */
function mentionsAnEmail(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return EMAIL.test(value);
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  return Object.values(value).some((inner) => mentionsAnEmail(inner, depth + 1));
}

/** Whether a new event invites anyone. */
function invitesSomeone(args: Record<string, unknown>): boolean {
  return (
    Object.entries(args).some(([key, value]) => INVITEE_KEY.test(key) && namesSomeone(value)) ||
    mentionsAnEmail(args)
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
  if (NEW_EVENT.has(slug)) return invitesSomeone(args);
  // Every other event write counts: a changed event may already have guests the arguments cannot
  // show, and they see the change on their own calendars whether or not Google emails them, so
  // no argument the agent writes (`send_updates: 'none'`, say) can answer no.
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
