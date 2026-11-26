/**
 * The text and the binding of an approval card that both sides of the server
 * compute the same way (spec `computer-side-starts-alone` §5.7).
 *
 * The space side raises and stores the card. The computer side reads the same
 * rules to judge, before it asks, whether a card could show a request whole,
 * and the session relay hashes a tool call's input to check a proof from the
 * web against it. Plain functions of their input, so they live here and
 * neither side imports the other for them.
 *
 * ## The binding hash (spec `agent-trust` §3.3)
 *
 * An approval says yes to one specific action, not to a capability in general.
 * Hashing the invocation input is what makes that precise: consent to uninstall
 * one package cannot be replayed to uninstall a different one, because the retry
 * presents a different hash and the token stops matching.
 *
 * ## Only plain JSON can be bound, and that is checked
 *
 * {@link stableStringify} canonicalizes by rebuilding every object from
 * `Object.keys()`. That is correct for plain data and silently wrong for anything
 * else: a `Date` loses its `toJSON`, and a `Set` or `Map` has no own enumerable
 * keys at all, so `{ s: new Set(['a']) }` and `{ s: new Set(['b']) }` hash
 * IDENTICALLY. A field like that would look bound while being ignored, which is
 * the worst possible failure for a consent primitive — and one a schema-shape
 * check cannot see, because parsing a `Date` twice is perfectly stable. (The
 * conformance suite's parse-idempotence check, which is where that observation
 * was first made, is gone with the double parse it guarded — DOR-467.)
 *
 * So this module refuses rather than trusts: {@link assertBindableInput} walks the
 * value and throws {@link ApprovalInputNotBindableError} on anything that is not
 * plain JSON. The first destructive schema to grow a `z.date()` or `z.set()` field
 * fails loudly at the gate instead of quietly unbinding that field. Callers turn
 * the throw into a refusal, so the destructive action does not run either way.
 * Prototype-named own keys (`__proto__`, `constructor`, `prototype`) are refused
 * at any depth too, as the step-up statement's canonical form refuses them.
 *
 * ## Card text
 *
 * {@link quoteSummaryValue} renders a caller-supplied value so it cannot fake
 * card structure, and {@link storableSummary} and {@link storableDetail} make a
 * sentence safe to store: swept for anything token-shaped, then shortened to
 * what the card's wire schema parses. The rest of the card-sentence rules are
 * the approvals' own (`services/core/approvals/approval-summary.ts`).
 *
 * Node only (`node:crypto`).
 *
 * @module shared/approval-text
 */
import { createHash } from 'node:crypto';
import { APPROVAL_DETAIL_MAX_LENGTH, APPROVAL_SUMMARY_MAX_LENGTH } from './approval-schemas.js';
import { stableStringify } from './capabilities.js';

/**
 * An invocation input that cannot be bound to an approval because canonicalizing
 * it would lose information.
 *
 * Carries the offending path so the fix is obvious ("`schedule.runAt` is a Date").
 */
export class ApprovalInputNotBindableError extends Error {
  /** Distinguishes this from a generic failure without an `instanceof` import. */
  override readonly name = 'ApprovalInputNotBindableError';

  /**
   * Build the error for one offending value.
   *
   * @param path - Dotted path to the offending value, `input` for the root.
   * @param describedValue - Plain description of what was found there.
   */
  constructor(
    readonly path: string,
    describedValue: string
  ) {
    super(
      `Approval input cannot be bound: ${path} is ${describedValue}. An approval binds to a ` +
        `hash of plain JSON, so only strings, finite numbers, booleans, null, arrays, and plain ` +
        `objects may reach it.`
    );
  }
}

/** How a rejected value is described in the error, for whoever has to fix it. */
function describe(value: unknown): string {
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : 'a non-finite number';
  if (typeof value === 'function') return 'a function';
  if (typeof value === 'bigint') return 'a bigint';
  if (typeof value === 'symbol') return 'a symbol';
  const ctor = (value as object).constructor?.name;
  return ctor ? `a ${ctor} instance` : 'a non-plain object';
}

/** Own keys an approval refuses at any depth, whatever their value. */
const PROTOTYPE_NAMED_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Whether an object is a plain `{}` — own keys only, no custom prototype. */
function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Throw unless every value reachable from `input` survives canonicalization.
 *
 * Exported so a caller can validate ahead of hashing, and so the guard itself is
 * directly testable.
 *
 * @param input - The value about to be bound.
 * @param path - Path prefix used in the error message. Defaults to `input`.
 * @throws {@link ApprovalInputNotBindableError} on any non-plain value or
 *   prototype-named own key.
 */
export function assertBindableInput(input: unknown, path = 'input'): void {
  if (input === null || input === undefined) return;

  switch (typeof input) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      // `JSON.stringify` turns NaN and ±Infinity into `null`, so they would hash
      // the same as an absent value — absence-as-absence cuts both ways.
      if (!Number.isFinite(input)) throw new ApprovalInputNotBindableError(path, describe(input));
      return;
    case 'object':
      break;
    default:
      throw new ApprovalInputNotBindableError(path, describe(input));
  }

  if (Array.isArray(input)) {
    input.forEach((item, index) => assertBindableInput(item, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(input)) {
    throw new ApprovalInputNotBindableError(path, describe(input));
  }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (PROTOTYPE_NAMED_KEYS.has(key)) {
      throw new ApprovalInputNotBindableError(`${path}.${key}`, 'a prototype-named key');
    }
    assertBindableInput(value, `${path}.${key}`);
  }
}

/**
 * Hash an invocation input into the value an approval binds to.
 *
 * The input is serialized with {@link stableStringify} first, so two
 * structurally-equal inputs hash identically no matter what order their keys
 * were written in — an agent that rebuilds its arguments before retrying still
 * matches the approval it was granted.
 *
 * `undefined` is normalized to `null` before hashing: a capability that takes no
 * arguments still needs a stable hash, and `JSON.stringify(undefined)` returns
 * `undefined` rather than a string, which would throw here.
 *
 * @param input - The invocation input. Must be plain JSON; see the module TSDoc.
 * @returns A SHA-256 hex digest of the canonical form.
 * @throws {@link ApprovalInputNotBindableError} when any part of `input` would
 *   lose information on the way into the digest.
 */
export function hashApprovalInput(input: unknown): string {
  assertBindableInput(input);
  return createHash('sha256')
    .update(stableStringify(input ?? null), 'utf8')
    .digest('hex');
}

/**
 * Longest a single rendered value may be.
 *
 * Small on purpose: the point of a value on the card is recognition ("yes, that
 * package"), not transcription. Capping per value rather than only per sentence
 * is what stops one padded argument from truncating away the argument that
 * decides how destructive the action is.
 */
const SUMMARY_VALUE_MAX_LENGTH = 80;

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
 *    the approvals' `renderRequesterLabel`). This is the one that matters for a value a
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
  return JSON.stringify(clampForStorage(redactSecretsInText(value), SUMMARY_VALUE_MAX_LENGTH));
}

/**
 * Make a summary safe to store: strip anything token-shaped, then shorten it to
 * what a card can hold.
 *
 * Both happen on the way IN rather than at render time. The length cap is because
 * the cockpit parses stored rows against a schema that caps it, so a long sentence
 * has to become a short one here or the card would be dropped instead of shown.
 * The redaction is because this string is broadcast on the global event stream and
 * returned by `GET /api/approvals/pending`, which agents can read — so it is the
 * one place every producer of a summary passes through, including the marketplace
 * confirmation provider, which writes its own sentences.
 */
export function storableSummary(summary: string): string {
  return clampForStorage(redactSecretsInText(summary), APPROVAL_SUMMARY_MAX_LENGTH);
}

/**
 * Make a detail safe to store: the same sweep the summary gets, against the
 * detail's own, much larger bound.
 *
 * Same two reasons, in the same order. The sweep is because this string is
 * broadcast on the global event stream and returned by
 * `GET /api/approvals/pending`, which agents can read. The cap is because the
 * cockpit parses stored rows against a schema that caps it, so an over-long
 * value has to shorten here or the whole card is dropped rather than shown —
 * and a dropped card is worse than a shortened one for exactly the reason this
 * field exists.
 *
 * The bound is the card builders' own unless a caller passes the stored
 * ceiling: only a capability's `approvalDetailField` may use it (DOR-4266).
 * Package cards and the "is this whole?" checks keep the smaller one.
 *
 * @param detail - The verbatim argument the capability declared.
 * @param max - The bound to cap at.
 * @returns The swept, capped value to store.
 */
export function storableDetail(detail: string, max = APPROVAL_DETAIL_MAX_LENGTH): string {
  return clampForStorage(redactSecretsInText(detail), max);
}

/**
 * Shorten a value to what its column's schema will parse, marking the cut.
 *
 * @param value - The already-swept string.
 * @param max - The schema's bound for that field.
 * @returns The value, at most `max` characters.
 */
export function clampForStorage(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}
