/**
 * A connected-app action on an approval card, as the approvals store keeps it:
 * swept for secrets and checked against the wire schema on the way in, and
 * read back defensively on the way out. Moved out of `approval-service.ts` to
 * keep that file within its line budget.
 *
 * @module services/core/approvals/approval-service-action-store
 */
import {
  ApprovalServiceActionSchema,
  type ApprovalServiceAction,
} from '@dorkos/shared/approval-schemas';
import { redactSecretsInText } from './approval-summary.js';

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

/**
 * Read a stored connected-app action back, or nothing when the row has none or
 * it no longer parses — a card without it still has its summary.
 *
 * @param stored - The column's JSON.
 */
function storedServiceAction(stored: string | null): ApprovalServiceAction | undefined {
  if (stored === null) return undefined;
  try {
    const parsed = ApprovalServiceActionSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The stored connected-app action as a spreadable field, or nothing. */
export function withServiceAction(stored: string | null): {
  serviceAction?: ApprovalServiceAction;
} {
  const serviceAction = storedServiceAction(stored);
  return serviceAction ? { serviceAction } : {};
}
