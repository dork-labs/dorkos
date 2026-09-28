/**
 * What a connected-app action would do, in words a person can decide on
 * (DOR-2504).
 *
 * A destructive action used to reach its approval card as two opaque ids, so
 * a person approved a Gmail deletion without being told it was Gmail, which
 * account, or which message. This module turns the stored connection, the
 * stored action and the call's arguments into the card's header and argument
 * list.
 *
 * ## Where each part comes from
 *
 * - The app, the account and the action come from the stored rows the call
 *   names by id, read by the authorization service after every access check
 *   has passed. Nothing the agent wrote reaches them.
 * - The argument values are the agent's, because they are what would be sent.
 *   Each is shown as a value: text is flattened to one line and shortened, a
 *   list is shown by its first few items or counted, a nested object is
 *   counted, and a value whose name reads as a secret is hidden. Anything
 *   token-shaped is swept out of every string before it is shortened.
 * - Argument labels come from the argument names. The action's own schema
 *   fields come first, in the schema's order, so an extra argument an agent
 *   adds can never push a real one off the card.
 *
 * @module services/connectors/execution/approval-service-action
 */
import { isSecretInputKey } from '@dorkos/shared/capabilities';
import {
  APPROVAL_SERVICE_ACTION_MAX_DETAILS,
  APPROVAL_SERVICE_DETAIL_LABEL_MAX_LENGTH,
  APPROVAL_SERVICE_DETAIL_VALUE_MAX_LENGTH,
  APPROVAL_SERVICE_NAME_MAX_LENGTH,
  type ApprovalServiceAction,
  type ApprovalServiceActionDetail,
} from '@dorkos/shared/approval-schemas';
import { actionNameFromSlug, serviceNameFromToolkit } from '@dorkos/shared/connector-schemas';
import { REDACTED_SUMMARY_VALUE, redactSecretsInText } from '../../core/approvals/index.js';
import { BUILT_IN_APPS } from '../resources/built-in-apps.js';

/** The stored facts one connected-app action is described from. */
export interface ServiceActionFacts {
  /** The connection's app id, e.g. `gmail`. */
  readonly toolkit: string;
  /** The account's name as the owner (or the service) set it. */
  readonly connectionLabel: string;
  /** The account's address at the service, when known. */
  readonly identityHint: string | null;
  /** The stored action's id, e.g. `GMAIL_DELETE_MESSAGE`. */
  readonly operationSlug: string;
  /** The stored action's frozen input schema. */
  readonly inputSchema: unknown;
  /** The arguments the call would send, already checked against that schema. */
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** How many items of a plain list are named before the rest are counted. */
const LIST_ITEMS_SHOWN = 3;

/** Words that read better in capitals inside a label. */
const LABEL_ACRONYMS = new Set(['id', 'ids', 'url', 'uri', 'cc', 'bcc', 'html', 'api']);

/** Shorten to `max` characters, marking the cut. */
function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * A string made safe to show: token-shaped runs swept out BEFORE shortening
 * (a shortened token no longer matches the sweep), then flattened to one line.
 */
function plainText(value: string, max: number): string {
  return clamp(redactSecretsInText(value).replace(/\s+/gu, ' ').trim(), max);
}

/**
 * The app's name: the built-in list's when DorkOS ships one for it, otherwise
 * read from its id the way every other surface does.
 */
function serviceName(toolkit: string): string {
  return (
    BUILT_IN_APPS.find((app) => app.serviceSlug === toolkit)?.displayName ??
    serviceNameFromToolkit(toolkit)
  );
}

/**
 * The account as the Connections list names it: a name the person chose, with
 * its address beside it when that differs; an unnamed account (whose label is
 * just the app id) by its address.
 */
function accountLabel(facts: ServiceActionFacts): string {
  const named = facts.connectionLabel.toLowerCase() !== facts.toolkit.toLowerCase();
  if (!named) return facts.identityHint ?? facts.connectionLabel;
  return facts.identityHint && facts.identityHint !== facts.connectionLabel
    ? `${facts.connectionLabel} (${facts.identityHint})`
    : facts.connectionLabel;
}

/**
 * An argument name in words: `message_id` and `messageId` both read "Message ID".
 * Anything but letters and digits is dropped first, so a name an agent chose
 * cannot carry punctuation that reads as structure.
 */
function detailLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
    .map((word) => (LABEL_ACRONYMS.has(word) ? word.toUpperCase() : word));
  if (words.length === 0) return 'Other';
  const [first, ...rest] = words;
  const label = [`${first!.charAt(0).toUpperCase()}${first!.slice(1)}`, ...rest].join(' ');
  return clamp(label, APPROVAL_SERVICE_DETAIL_LABEL_MAX_LENGTH);
}

/** "1 item", "3 fields". */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** One item of a plain list, or `undefined` when the item is not plain. */
function plainItem(value: unknown): string | undefined {
  if (typeof value === 'string') return plainText(value, APPROVAL_SERVICE_DETAIL_VALUE_MAX_LENGTH);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return undefined;
}

/**
 * One argument's value in words, never JSON.
 *
 * @param value - The argument's value, plain JSON data.
 */
function detailValue(value: unknown): string {
  if (value === null) return 'Not set';
  if (typeof value === 'string') {
    return value.trim() === ''
      ? 'Empty'
      : plainText(value, APPROVAL_SERVICE_DETAIL_VALUE_MAX_LENGTH);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'Not a number';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'None';
    const items = value.map(plainItem);
    if (items.some((item) => item === undefined)) return counted(value.length, 'item');
    const shown = items.slice(0, LIST_ITEMS_SHOWN).join(', ');
    const rest = value.length - LIST_ITEMS_SHOWN;
    return clamp(
      rest > 0 ? `${shown} and ${rest} more` : shown,
      APPROVAL_SERVICE_DETAIL_VALUE_MAX_LENGTH
    );
  }
  if (typeof value === 'object') return counted(Object.keys(value).length, 'field');
  return 'Not shown';
}

/** The action's own field names, in its schema's order. */
function schemaFieldOrder(inputSchema: unknown): string[] {
  if (inputSchema === null || typeof inputSchema !== 'object') return [];
  const properties = (inputSchema as { properties?: unknown }).properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return [];
  }
  return Object.keys(properties);
}

/**
 * The argument lines, the action's own fields first.
 *
 * @param facts - The stored action and the call's arguments.
 */
function describeArguments(facts: ServiceActionFacts): ApprovalServiceActionDetail[] {
  const sent = Object.keys(facts.arguments).filter((key) => facts.arguments[key] !== undefined);
  const declared = schemaFieldOrder(facts.inputSchema).filter((key) => sent.includes(key));
  const extra = sent.filter((key) => !declared.includes(key));
  return [...declared, ...extra].map((key) => ({
    label: detailLabel(key),
    value: isSecretInputKey(key) ? REDACTED_SUMMARY_VALUE : detailValue(facts.arguments[key]),
  }));
}

/**
 * Describe one connected-app action for its approval card.
 *
 * @param facts - The stored connection and action, and the call's arguments.
 * @returns The app, account, action and argument lines the card shows.
 */
export function describeServiceAction(facts: ServiceActionFacts): ApprovalServiceAction {
  const details = describeArguments(facts);
  const more = details.length - APPROVAL_SERVICE_ACTION_MAX_DETAILS;
  const name = (value: string) => plainText(value, APPROVAL_SERVICE_NAME_MAX_LENGTH);
  return {
    serviceId: clamp(facts.toolkit, APPROVAL_SERVICE_NAME_MAX_LENGTH),
    serviceName: name(serviceName(facts.toolkit)),
    accountLabel: name(accountLabel(facts)),
    actionName: name(actionNameFromSlug(facts.operationSlug, facts.toolkit)),
    details: details.slice(0, APPROVAL_SERVICE_ACTION_MAX_DETAILS),
    ...(more > 0 ? { moreDetails: more } : {}),
  };
}
