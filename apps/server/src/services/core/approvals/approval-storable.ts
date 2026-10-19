/**
 * Making caller-supplied approval text safe to store: swept for anything
 * token-shaped, then shortened to what the card's wire schema parses.
 *
 * Kept apart from `approval-service.ts` so the service holds the approval
 * lifecycle and this module holds the storage rules every text field passes.
 *
 * @module services/core/approvals/approval-storable
 */
import {
  APPROVAL_DETAIL_MAX_LENGTH,
  APPROVAL_REQUEST_REASON_MAX_LENGTH,
  APPROVAL_SUMMARY_MAX_LENGTH,
  ApprovalServiceActionSchema,
  type ApprovalServiceAction,
} from '@dorkos/shared/approval-schemas';
import { redactSecretsInText } from './approval-summary.js';

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
 * @param detail - The verbatim argument the capability declared.
 * @returns The swept, capped value to store.
 */
export function storableDetail(detail: string): string {
  return clampForStorage(redactSecretsInText(detail), APPROVAL_DETAIL_MAX_LENGTH);
}

/**
 * Make a blocked request's reason safe to store: the agent's own words, swept
 * for secrets and capped at the bound the card's schema parses.
 *
 * @param reason - The reason the agent gave.
 * @returns The swept, capped value to store.
 */
export function storableReason(reason: string): string {
  return clampForStorage(redactSecretsInText(reason), APPROVAL_REQUEST_REASON_MAX_LENGTH);
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

/**
 * Make a connected-app action safe to store: every string swept for secrets
 * again, then checked against the wire schema.
 *
 * The builder already sweeps and caps, but `ApprovalRequestInput` is public API
 * and this JSON is broadcast and agent-readable exactly like the summary, so
 * the store does not take a producer's word for it. A value that does not
 * parse is not stored, and the card falls back to the summary sentence.
 *
 * @param action - The described action.
 * @returns The JSON to store, or null.
 */
export function storableServiceAction(action: ApprovalServiceAction): string | null {
  const swept = {
    ...action,
    serviceName: redactSecretsInText(action.serviceName),
    accountLabel: redactSecretsInText(action.accountLabel),
    actionName: redactSecretsInText(action.actionName),
    details: action.details.map((detail) => ({
      label: redactSecretsInText(detail.label),
      value: redactSecretsInText(detail.value),
    })),
    ...(action.everything
      ? {
          everything: action.everything.map((line) => ({
            ...line,
            label: redactSecretsInText(line.label),
            value: redactSecretsInText(line.value),
          })),
        }
      : {}),
  };
  const parsed = ApprovalServiceActionSchema.safeParse(swept);
  return parsed.success ? JSON.stringify(parsed.data) : null;
}
