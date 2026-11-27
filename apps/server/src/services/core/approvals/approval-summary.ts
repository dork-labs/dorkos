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
 *    80 characters (`@dorkos/shared/approval-text`) before the whole sentence is capped, so a
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

import {
  clampForStorage,
  quoteSummaryValue,
  REDACTED_SUMMARY_VALUE,
  redactSecretsInText,
} from '@dorkos/shared/approval-text';
import { isSecretInputKey } from '@dorkos/shared/capabilities';

// The value rules a card shares with the computer side's checks (spec
// `computer-side-starts-alone` §5.7) live in `@dorkos/shared/approval-text`.
export { quoteSummaryValue, REDACTED_SUMMARY_VALUE, redactSecretsInText };

/** Longest a requester label may be before it is shortened. */
const SUMMARY_LABEL_MAX_LENGTH = 60;

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
  return clampForStorage(redactSecretsInText(label), SUMMARY_LABEL_MAX_LENGTH);
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

/**
 * Join rendered pairs into the `field: value, field: value` clause a card and a
 * sentence both end in.
 *
 * One renderer for both, so the clause a person reads on the card can never
 * drift from the clause the notification carries. The final secret sweep runs
 * here rather than at each caller for the same reason: a producer that forgot it
 * would publish a token to every connected client.
 *
 * @param pairs - The rendered field/value pairs, in display order.
 * @returns The joined clause, or `undefined` when there are no pairs.
 */
export function joinSummaryFields(
  pairs: readonly { field: string; value: string }[]
): string | undefined {
  if (pairs.length === 0) return undefined;
  return redactSecretsInText(pairs.map(({ field, value }) => `${field}: ${value}`).join(', '));
}

/**
 * The display pairs with the SUBJECT's pair replaced by the resolved name.
 *
 * Substituted by FIELD PATH, never by matching the value: two arguments can
 * carry the same string, and swapping every match would rewrite an argument the
 * resolver never looked at. `summaryFields` renders a declared allowlist in its
 * declared order, so position `i` here is `displayFields[i]`.
 *
 * With no allowlist declared there is no path to match on and nothing is
 * substituted — which costs nothing real, because `destructive` is the only tier
 * that builds a card and every destructive action must declare one.
 *
 * @param input - The parsed input the approval binds to.
 * @param displayFields - The action's declared display fields, in order.
 * @param subject - The resolved subject, when there is one.
 * @param subjectField - The dotted path the subject was read from.
 * @returns The pairs, ready to join.
 */
export function summaryFieldsNamingSubject(
  input: unknown,
  displayFields: readonly string[] | undefined,
  subject: { kind: string; label: string } | undefined,
  subjectField: string | undefined
): { field: string; value: string }[] {
  return summaryFields(input, displayFields).map((pair, i) =>
    subject && displayFields?.[i] === subjectField
      ? { field: subject.kind, value: JSON.stringify(subject.label) }
      : pair
  );
}

/**
 * How a gated attempt's summary names the extension a tool comes from:
 * ` from "Mail"`, JSON-quoted because the name is its author's text
 * (DOR-2685). One definition, so the approval card can tell whether the
 * extension running now is the one the stored summary named.
 *
 * @param name - The extension's display name.
 */
export function extensionSourcePhrase(name: string): string {
  return ` from ${JSON.stringify(name)}`;
}
