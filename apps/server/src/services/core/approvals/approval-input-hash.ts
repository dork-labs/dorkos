/**
 * The canonical binding hash an approval is scoped to (spec `agent-trust` §3.3).
 *
 * An approval says yes to one specific action, not to a capability in general.
 * Hashing the invocation input is what makes that precise: consent to uninstall
 * one package cannot be replayed to uninstall a different one, because the retry
 * presents a different hash and the token stops matching.
 *
 * @module services/core/approvals/approval-input-hash
 */
import { createHash } from 'node:crypto';
import { stableStringify } from '@dorkos/shared/capabilities';

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
 * @param input - The invocation input, or any JSON-serializable description of
 *   the action being approved.
 * @returns A SHA-256 hex digest of the canonical form.
 */
export function hashApprovalInput(input: unknown): string {
  return createHash('sha256')
    .update(stableStringify(input ?? null), 'utf8')
    .digest('hex');
}
