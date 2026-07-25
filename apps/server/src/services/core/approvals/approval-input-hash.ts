/**
 * The canonical binding hash an approval is scoped to (spec `agent-trust` §3.3).
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
 * the worst possible failure for a consent primitive — and one no test could see,
 * because the conformance suite's parse-idempotence check is stable over a `Date`.
 *
 * So this module refuses rather than trusts: {@link assertBindableInput} walks the
 * value and throws {@link ApprovalInputNotBindableError} on anything that is not
 * plain JSON. The first destructive schema to grow a `z.date()` or `z.set()` field
 * fails loudly at the gate instead of quietly unbinding that field. Callers turn
 * the throw into a refusal, so the destructive action does not run either way.
 *
 * @module services/core/approvals/approval-input-hash
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '@dorkos/shared/capabilities';

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
 * @throws {@link ApprovalInputNotBindableError} on any non-plain value.
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
