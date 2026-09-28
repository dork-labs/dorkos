/**
 * What a connected-app action would do, in words a person can decide on
 * (DOR-2504).
 *
 * A destructive action used to reach its approval card as two opaque ids, so
 * a person approved a Gmail deletion without being told it was Gmail, which
 * account, or which message. This module turns the stored connection, the
 * stored action and the call's arguments into the card's header, a short
 * argument list, and — whenever the short list leaves anything out — the
 * complete one.
 *
 * ## Where each part comes from
 *
 * - The app, the account and the action come from the stored rows the call
 *   names by id, read by the authorization service after every access check
 *   has passed. Nothing the agent wrote reaches them.
 * - The argument values are the agent's, because they are what would be sent.
 *   Every string first loses its invisible formatting characters (a
 *   right-to-left override can make text read backwards), then is swept for
 *   anything credential-shaped, and only then shortened — a shortened token no
 *   longer matches the sweep (`connected-app-secrets.ts`, stricter than the
 *   sweep other cards get). A value whose NAME reads as a secret is hidden.
 * - Argument labels come from the argument names. The action's own schema
 *   fields come first, in the schema's order, so an extra argument an agent
 *   adds can never push a real one off the card.
 *
 * ## Two views of the same arguments
 *
 * `details` is the glance: at most six lines, each value flattened to one line
 * and shortened, a list shown by its first items, a nested object counted.
 * `everything` is the whole of it: every list item and nested field on its own
 * indented line, values in full. It is sent only when the glance leaves
 * something out, and when even it has to stop (a very large payload), it says
 * how many values it could not fit rather than implying it is complete.
 *
 * @module services/connectors/execution/approval-service-action
 */
import {
  APPROVAL_SERVICE_ACTION_MAX_DETAILS,
  APPROVAL_SERVICE_DETAIL_LABEL_MAX_LENGTH,
  APPROVAL_SERVICE_DETAIL_VALUE_MAX_LENGTH,
  APPROVAL_SERVICE_FULL_MAX_CHARACTERS,
  APPROVAL_SERVICE_FULL_MAX_DEPTH,
  APPROVAL_SERVICE_FULL_MAX_LINES,
  APPROVAL_SERVICE_FULL_VALUE_MAX_LENGTH,
  APPROVAL_SERVICE_NAME_MAX_LENGTH,
  type ApprovalServiceAction,
  type ApprovalServiceActionDetail,
  type ApprovalServiceActionLine,
} from '@dorkos/shared/approval-schemas';
import { actionNameFromSlug, serviceNameFromToolkit } from '@dorkos/shared/connector-schemas';
import { REDACTED_SUMMARY_VALUE } from '../../core/approvals/index.js';
import { BUILT_IN_APPS } from '../resources/built-in-apps.js';
import {
  argumentNameWords,
  isIdArgumentName,
  isSecretArgumentName,
  redactConnectedAppArgument,
} from './connected-app-secrets.js';

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

/** How many items of a plain list the glance names before counting the rest. */
const LIST_ITEMS_SHOWN = 3;

/** Words that read better in capitals inside a label. */
const LABEL_ACRONYMS = new Set(['id', 'ids', 'url', 'uri', 'cc', 'bcc', 'html', 'api']);

/** Invisible formatting characters: bidi overrides, zero-width spaces and joiners. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/** Shorten to `max` characters (whole code points, never half an emoji), marking the cut. */
function clamp(value: string, max: number): string {
  const points = Array.from(value);
  if (points.length <= max) return value;
  return `${points
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * A string with its invisible formatting removed and anything secret-shaped
 * swept. `idField` says the argument it belongs to is named as an id.
 */
function sweep(value: string, idField = false): string {
  return redactConnectedAppArgument(value.replace(FORMAT_CHARACTERS, ''), idField);
}

/** A string made safe for one line: swept, flattened, then shortened. */
function plainText(value: string, max: number, idField = false): string {
  return clamp(sweep(value, idField).replace(/\s+/gu, ' ').trim(), max);
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
 * Anything but letters and digits is dropped, so a name an agent chose cannot
 * carry punctuation that reads as structure.
 */
function detailLabel(key: string): string {
  const words = argumentNameWords(key).map((word) =>
    LABEL_ACRONYMS.has(word) ? word.toUpperCase() : word
  );
  if (words.length === 0) return 'Other';
  const [first, ...rest] = words;
  const label = [`${first!.charAt(0).toUpperCase()}${first!.slice(1)}`, ...rest].join(' ');
  return clamp(label, APPROVAL_SERVICE_DETAIL_LABEL_MAX_LENGTH);
}

/** "1 item", "3 fields". */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** A value that is not a list or an object, in words, or `undefined` when it is one. */
function scalarWords(value: unknown, text: (value: string) => string): string | undefined {
  if (value === null) return 'Not set';
  if (typeof value === 'string') return value.trim() === '' ? 'Empty' : text(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'Not a number';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return undefined;
}

/**
 * One argument's value for the glance, never JSON.
 *
 * @param value - The argument's value, plain JSON data.
 * @param idField - Whether the argument is named as an id.
 */
function glanceValue(value: unknown, idField: boolean): string {
  const glanceText = (text: string) =>
    plainText(text, APPROVAL_SERVICE_DETAIL_VALUE_MAX_LENGTH, idField);
  const scalar = scalarWords(value, glanceText);
  if (scalar !== undefined) return scalar;
  if (Array.isArray(value)) {
    if (value.length === 0) return 'None';
    const items = value.map((item) =>
      item !== null && typeof item === 'object' ? undefined : scalarWords(item, glanceText)
    );
    if (items.some((item) => item === undefined)) return counted(value.length, 'item');
    const shown = items.slice(0, LIST_ITEMS_SHOWN).join(', ');
    const rest = value.length - LIST_ITEMS_SHOWN;
    return clamp(
      rest > 0 ? `${shown} and ${rest} more` : shown,
      APPROVAL_SERVICE_DETAIL_VALUE_MAX_LENGTH
    );
  }
  if (value !== null && typeof value === 'object') {
    return counted(Object.keys(value).length, 'field');
  }
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

/** The argument names in card order: the action's own fields, then any others. */
function argumentOrder(facts: ServiceActionFacts): string[] {
  const sent = Object.keys(facts.arguments).filter((key) => facts.arguments[key] !== undefined);
  const declared = schemaFieldOrder(facts.inputSchema).filter((key) => sent.includes(key));
  return [...declared, ...sent.filter((key) => !declared.includes(key))];
}

/** How many values a subtree holds, for counting one that cannot be shown. */
function leafCount(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, v) => sum + leafCount(v), 0);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).reduce<number>((sum, v) => sum + leafCount(v), 0);
  }
  return 1;
}

/**
 * Builds the complete argument list within its bounds, counting whatever does
 * not fit so the card can say so.
 */
class EverythingList {
  readonly lines: ApprovalServiceActionLine[] = [];
  cut = 0;
  private characters = 0;

  /**
   * Add one line, or count it as cut when the list is full. Labels count
   * toward the budget as well as values. A value that had to be shortened is
   * counted too, and only once whichever way it falls short.
   */
  private emit(label: string, value: string, depth: number, shortened = false): void {
    const size = label.length + value.length;
    if (
      this.lines.length >= APPROVAL_SERVICE_FULL_MAX_LINES ||
      this.characters + size > APPROVAL_SERVICE_FULL_MAX_CHARACTERS
    ) {
      this.cut += 1;
      return;
    }
    this.characters += size;
    this.lines.push({ label, value, depth });
    if (shortened) this.cut += 1;
  }

  /**
   * Add one argument (or list item, or field) and everything under it.
   *
   * @param key - Its name, or `undefined` for a list item.
   * @param label - The label to show.
   * @param value - Its value.
   * @param depth - How deep it sits.
   * @param parentIsId - Whether the list this item sits in is named as an id
   *   (`fileIds`), so its items are read as ids too.
   */
  add(
    key: string | undefined,
    label: string,
    value: unknown,
    depth: number,
    parentIsId = false
  ): void {
    const idField = key === undefined ? parentIsId : isIdArgumentName(key);
    if (key !== undefined && isSecretArgumentName(key)) {
      this.emit(label, REDACTED_SUMMARY_VALUE, depth);
      return;
    }
    // Line breaks are kept here: this is where a message body is read whole.
    // A value too long even for this list is shortened AND counted, so the
    // card never presents a cut value as the whole of it.
    let shortened = false;
    const scalar = scalarWords(value, (text) => {
      const swept = sweep(text, idField);
      shortened = Array.from(swept).length > APPROVAL_SERVICE_FULL_VALUE_MAX_LENGTH;
      return clamp(swept, APPROVAL_SERVICE_FULL_VALUE_MAX_LENGTH);
    });
    if (scalar !== undefined) {
      this.emit(label, scalar, depth, shortened);
      return;
    }
    const isList = Array.isArray(value);
    const children: Array<[string | undefined, string, unknown]> = isList
      ? (value as unknown[]).map((item, index) => [undefined, String(index + 1), item])
      : Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
          childKey,
          detailLabel(childKey),
          child,
        ]);
    this.emit(
      label,
      children.length === 0 ? 'None' : counted(children.length, isList ? 'item' : 'field'),
      depth
    );
    if (depth >= APPROVAL_SERVICE_FULL_MAX_DEPTH) {
      this.cut += leafCount(value);
      return;
    }
    for (const [childKey, childLabel, child] of children) {
      this.add(childKey, childLabel, child, depth + 1, idField);
    }
  }
}

/**
 * Describe one connected-app action for its approval card.
 *
 * @param facts - The stored connection and action, and the call's arguments.
 * @returns The app, account and action, the glance, and — when the glance
 *   leaves anything out — every argument in full.
 */
export function describeServiceAction(facts: ServiceActionFacts): ApprovalServiceAction {
  const order = argumentOrder(facts);
  const glance: ApprovalServiceActionDetail[] = order.map((key) => ({
    label: detailLabel(key),
    value: isSecretArgumentName(key)
      ? REDACTED_SUMMARY_VALUE
      : glanceValue(facts.arguments[key], isIdArgumentName(key)),
  }));
  const everything = new EverythingList();
  for (const key of order) everything.add(key, detailLabel(key), facts.arguments[key], 0);

  const shown = glance.slice(0, APPROVAL_SERVICE_ACTION_MAX_DETAILS);
  const more = glance.length - shown.length;
  // The glance is the whole story only when every argument is one flat line,
  // shown exactly as the complete list would show it.
  const glanceIsWhole =
    more === 0 &&
    everything.cut === 0 &&
    everything.lines.length === shown.length &&
    everything.lines.every((line, i) => line.depth === 0 && line.value === shown[i]!.value);
  const name = (value: string) => plainText(value, APPROVAL_SERVICE_NAME_MAX_LENGTH);
  return {
    serviceId: clamp(facts.toolkit, APPROVAL_SERVICE_NAME_MAX_LENGTH),
    serviceName: name(serviceName(facts.toolkit)),
    accountLabel: name(accountLabel(facts)),
    actionName: name(actionNameFromSlug(facts.operationSlug, facts.toolkit)),
    details: shown,
    ...(more > 0 ? { moreDetails: more } : {}),
    ...(glanceIsWhole ? {} : { everything: everything.lines }),
    ...(everything.cut > 0 ? { everythingCut: everything.cut } : {}),
  };
}
