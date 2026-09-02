/**
 * Composing the sentence a person actually decides on (spec `agent-trust` §3.3).
 *
 * The approval card's title and tier come from the capability registry, so a
 * requester cannot dress up WHAT it is asking for. The summary is different: it
 * has to name the arguments, and those come from the caller. Review found that a
 * joined `key: value, key: value` sentence could therefore be made to lie —
 * `{ name: 'pkg, purge: no', purge: true }` rendered a fake `purge: no` pair
 * BEFORE the real one, and padding the injected value pushed the true value out
 * of the card's clamp entirely. The person read one action and approved another.
 *
 * Two rules make that structurally impossible here:
 *
 * 1. **A rendered value can never look like structure.** Strings are quoted and
 *    escaped ({@link quoteSummaryValue}), so injected separators land visibly
 *    INSIDE the quotes. Every other value renders from a closed set (`yes`/`no`,
 *    a number, `N items`, `not set`), which carries no separators at all.
 * 2. **No single value can crowd out another.** Each is capped at
 *    {@link SUMMARY_VALUE_MAX_LENGTH} before the whole sentence is capped, so a
 *    long argument cannot push a later, more consequential one past the
 *    summary's own length limit.
 *
 * On top of that, secrets never reach a card. `approvals.summary` is broadcast on
 * the global event stream and returned by `GET /api/approvals/pending`, which is
 * deliberately readable by agents — so a token-shaped value in the input would
 * publish a live secret to every connected cockpit. {@link isSecretInputKey}
 * drops fields whose NAME says secret, and {@link redactSecretsInText} is a
 * final sweep for anything token-shaped that got through under an innocent name.
 *
 * @module services/core/approvals/approval-summary
 */

import { isSecretInputKey } from '@dorkos/shared/capabilities';

/**
 * Longest a single rendered value may be.
 *
 * Small on purpose: the point of a value on the card is recognition ("yes, that
 * package"), not transcription. Capping per value rather than only per sentence
 * is what stops one padded argument from truncating away the argument that
 * decides how destructive the action is.
 */
const SUMMARY_VALUE_MAX_LENGTH = 80;

/** Longest a requester label may be before it is shortened. */
const SUMMARY_LABEL_MAX_LENGTH = 60;

/** What replaces a value that is, or looks like, a secret. */
export const REDACTED_SUMMARY_VALUE = '(hidden)';

/**
 * A run of 32 or more hex characters: the shape of every token DorkOS mints
 * (approval tokens and agent identity tokens are both `randomBytes(16).toString('hex')`)
 * and of any SHA-256 digest.
 *
 * ULIDs (26 chars, Crockford base32) are too short to match, so an approval id
 * still reads plainly on the card.
 *
 * **Deliberately NOT `\b`-anchored.** Word boundaries look like the careful choice
 * and are the opposite: `\b` requires a non-word character before the run, so a
 * token glued to any other word character — `sentry-monitorf3a9…`, or a caller
 * simply padding with letters — never matched the pattern at all. That is a
 * one-character evasion of the whole sweep. Matching anywhere costs only that a
 * 32-character hex substring inside a longer word is also hidden, which is the
 * right trade for something broadcast to every cockpit.
 */
const SECRET_VALUE_PATTERN = /[0-9a-f]{32,}/gi;

/**
 * Replace anything token-shaped in a string.
 *
 * Runs at two points, and both are load-bearing for different reasons:
 *
 * 1. On each caller-supplied value BEFORE it is shortened ({@link quoteSummaryValue},
 *    {@link renderRequesterLabel}). This is the one that matters for a value a
 *    caller controls, because a shortened token no longer matches the pattern.
 * 2. Where a summary is STORED (`approval-service.ts`), which catches sentences a
 *    producer composed itself — the marketplace confirmation provider writes its
 *    own, so no producer can skip the sweep entirely.
 *
 * @param text - The raw value or composed summary.
 * @returns The same string with token-shaped runs replaced.
 */
export function redactSecretsInText(text: string): string {
  return text.replace(SECRET_VALUE_PATTERN, REDACTED_SUMMARY_VALUE);
}

/** Shorten a raw string to `max` characters, marking that it was shortened. */
function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Render a caller-supplied string as a quoted, escaped, length-capped value.
 *
 * `JSON.stringify` does the escaping, which also flattens newlines and control
 * characters — so a multi-line value cannot fake a second line of the card.
 * The surrounding quotes are part of the result: a person reading
 * `name: "pkg, purge: no"` can see that the whole thing is one value.
 *
 * ## Redact BEFORE clamping, never after
 *
 * Review reproduced the inverted order: clamping first slices a 32-hex run below
 * 32 characters, so {@link SECRET_VALUE_PATTERN} stops matching and a padded token
 * publishes its surviving prefix. The storage sweep cannot recover it either,
 * because by then the run is already short. Redaction can only ever SHORTEN a
 * string, so running it first is free — the cap still holds.
 *
 * @param value - The raw string from the caller.
 * @returns The quoted, escaped, capped rendering.
 */
export function quoteSummaryValue(value: string): string {
  return JSON.stringify(clamp(redactSecretsInText(value), SUMMARY_VALUE_MAX_LENGTH));
}

/**
 * Render one input value for the card: short, plain, and structurally inert.
 *
 * @param value - The parsed input value.
 * @returns Its rendering, which can never be mistaken for two fields.
 */
function renderSummaryValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'not a number';
  if (typeof value === 'string') return quoteSummaryValue(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  return 'details';
}

/**
 * Render the label for who asked, capped so a self-chosen display name cannot
 * crowd the sentence out.
 *
 * An agent's `displayName` comes from its own `agent.json`, which an agent can
 * change through an `act`-tier capability — so it is caller-controlled and gets
 * exactly the same treatment as an argument, including redacting BEFORE clamping
 * (see {@link quoteSummaryValue} for why the order is load-bearing).
 *
 * @param label - The raw label.
 * @returns The redacted, capped label.
 */
export function renderRequesterLabel(label: string): string {
  return clamp(redactSecretsInText(label), SUMMARY_LABEL_MAX_LENGTH);
}

/** Characters a field name may contribute to the sentence. Everything else is dropped. */
const FIELD_NAME_ALLOWED = /[^A-Za-z0-9_.\-[\]]/g;

/**
 * Render a field NAME as inert text.
 *
 * Keys are normally schema-controlled — `z.object` strips what it does not declare
 * — but a destructive schema using `.passthrough()` or `z.record()` would hand a
 * caller control of the key too, and a key like `"a, purge: no"` forges structure
 * exactly the way a value used to. Stripping separators closes the class rather
 * than relying on no schema ever doing that.
 *
 * @param field - The field name or dotted path.
 * @returns The name with anything that could read as structure removed.
 */
function renderFieldName(field: string): string {
  const safe = field.replace(FIELD_NAME_ALLOWED, '').slice(0, 40);
  return safe.length > 0 ? safe : 'field';
}

/**
 * Read a dotted path out of a parsed input value.
 *
 * `approvalDisplayFields` may name a nested field (`options.purge`) so a
 * capability whose input is not flat still gets a card that says what will
 * happen, rather than the useless `details` a nested object renders as.
 *
 * Exported because `approvalDetailField` addresses the input the same way, and
 * the gate resolves that one (`tier-enforcement.ts`). One reader for both, so a
 * path that means one thing on the card's sentence cannot mean another on its
 * detail block.
 *
 * @param input - The parsed input.
 * @param path - A dotted field path.
 * @returns The value at that path, or `undefined`.
 */
export function readApprovalInputPath(input: unknown, path: string): unknown {
  let current: unknown = input;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * The `field: value` pairs a card shows for one invocation.
 *
 * With `displayFields` declared, exactly those fields appear, in that order —
 * the allowlist is the capability author's statement of what a person needs to
 * see. Without one, every top-level field appears EXCEPT those whose name says
 * secret, so a capability that forgets to declare an allowlist over-shares
 * plainly rather than leaking quietly.
 *
 * @param input - The parsed input the approval binds to.
 * @param displayFields - The capability's declared display fields, if any.
 * @returns The rendered pairs, ready to join.
 */
export function summaryFields(
  input: unknown,
  displayFields?: readonly string[]
): { field: string; value: string }[] {
  if (displayFields) {
    return displayFields.map((field) => ({
      field: renderFieldName(field),
      value: renderSummaryValue(readApprovalInputPath(input, field)),
    }));
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  return Object.entries(input as Record<string, unknown>)
    .filter(([key]) => !isSecretInputKey(key))
    .map(([field, value]) => ({
      field: renderFieldName(field),
      value: renderSummaryValue(value),
    }));
}
