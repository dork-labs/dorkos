/**
 * Who a connected-app send goes to, one line each, for its approval card
 * (DOR-4592, Security).
 *
 * The glance folds a list into "a, b, c and N more" and shortens it, so an
 * extra address could hide on a card meant to catch exactly that. Arguments
 * named as recipients leave the glance and are listed here instead: every
 * address, in the order the call names them, never sorted, deduped or
 * shortened below a length no real address reaches.
 *
 * ## Inert by construction
 *
 * An address is swept for secrets like any argument, but its invisible
 * characters are SHOWN, not stripped: every control character (C0, C1),
 * format character (bidi overrides, zero-width) and line or paragraph
 * separator becomes a visible `<U+…>` marker. A right-to-left override can't
 * make one address read as another, and a line break can't fake a second
 * recipient. The client renders the result as plain text, never a link.
 *
 * @module services/connectors/execution/approval-card/recipients
 */
import {
  APPROVAL_SERVICE_MAX_RECIPIENTS,
  inertRecipientText,
  type ApprovalServiceRecipient,
} from '@dorkos/shared/approval-schemas';
import {
  argumentNameWords,
  isSecretArgumentName,
  redactConnectedAppArgument,
} from '../connected-app-secrets.js';

/**
 * The argument names that hold who a send goes to: the one list every card
 * reads (Security, DOR-4592). A name is a recipient when its words, joined by
 * `_`, are one of these, or when any one word is in {@link RECIPIENT_WORDS}.
 * DOR-4780 grows it from the connectors' real schemas.
 */
export const RECIPIENT_ARGUMENT_NAMES: ReadonlySet<string> = new Set([
  'to',
  'to_email',
  'email',
  'emails',
  'phone',
  'phone_number',
]);

/** Words that make any argument name a recipient (`recipient_email`, `extra_recipients`). */
export const RECIPIENT_WORDS: ReadonlySet<string> = new Set([
  'cc',
  'bcc',
  'recipient',
  'recipients',
  'attendees',
  'participants',
]);

/**
 * Whether an argument's name says it holds who a send goes to.
 *
 * @param key - The argument's name as the call sent it.
 */
export function isRecipientArgumentName(key: string): boolean {
  // A secret stays hidden, whatever else its name says.
  if (isSecretArgumentName(key)) return false;
  const words = argumentNameWords(key);
  return RECIPIENT_ARGUMENT_NAMES.has(words.join('_')) || words.some((w) => RECIPIENT_WORDS.has(w));
}

/**
 * One recipient as the card shows it: swept, every hidden character a visible
 * marker, then shortened with "…" only past a length no real address reaches.
 *
 * @param value - The address as the call would send it.
 */
export function inertRecipient(value: string): string {
  return inertRecipientText(redactConnectedAppArgument(value, false));
}

/** A plain address, or null for anything else. */
function scalarAddress(item: unknown): string | null {
  return typeof item === 'string' || typeof item === 'number' ? String(item) : null;
}

/**
 * One list item's address: the item itself, or for an object such as a
 * calendar attendee (`{ email, optional }`) its first recipient-named field.
 */
function itemAddress(item: unknown): string | null {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return scalarAddress(item);
  for (const [key, field] of Object.entries(item)) {
    if (isRecipientArgumentName(key) && scalarAddress(field) !== null) return scalarAddress(field);
  }
  return null;
}

/**
 * The addresses one recipient argument holds, or null when its value isn't a
 * plain address, a list of them, or a list of objects that each name one (those
 * stay in the glance and in "Show everything", as before).
 */
function addressesOf(value: unknown): string[] | null {
  const one = itemAddress;
  if (!Array.isArray(value)) {
    const single = one(value);
    return single === null || single.trim() === '' ? null : [single];
  }
  const items = value.map(one);
  if (items.some((item) => item === null)) return null;
  return (items as string[]).filter((item) => item.trim() !== '');
}

/** The card's recipient lines, and how many could not be listed. */
export interface RecipientLines {
  /** One line per address, in argument order, then the order sent. */
  lines: ApprovalServiceRecipient[];
  /** How many addresses past the card's limit were left off. */
  cut: number;
  /** The arguments listed here, which the glance then leaves out. */
  keys: ReadonlySet<string>;
}

/**
 * Every recipient a call names, for its card.
 *
 * @param order - The argument names in card order.
 * @param args - The call's arguments.
 * @param label - The argument name in words, as the glance labels it.
 */
export function recipientLines(
  order: readonly string[],
  args: Readonly<Record<string, unknown>>,
  label: (key: string) => string
): RecipientLines {
  const lines: ApprovalServiceRecipient[] = [];
  const keys = new Set<string>();
  let cut = 0;
  for (const key of order) {
    if (!isRecipientArgumentName(key)) continue;
    const addresses = addressesOf(args[key]);
    if (addresses === null || addresses.length === 0) continue;
    keys.add(key);
    for (const address of addresses) {
      if (lines.length >= APPROVAL_SERVICE_MAX_RECIPIENTS) cut += 1;
      else lines.push({ label: label(key), address: inertRecipient(address) });
    }
  }
  return { lines, cut, keys };
}
