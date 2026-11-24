type ApprovalRequestKind = 'edit' | 'other';

/** The mode decision for a request the runtime has already checked. */
export type ApprovalDecision = 'ask' | 'auto-approve';

const decisions = new Map<string | undefined, Record<ApprovalRequestKind, ApprovalDecision>>([
  ['bypassPermissions', { edit: 'auto-approve', other: 'auto-approve' }],
  ['acceptEdits', { edit: 'auto-approve', other: 'ask' }],
]);

/**
 * Decide whether an eligible ordinary runtime request needs a person.
 *
 * @param mode - The effective mode supplied by the runtime.
 * @param kind - The runtime's classification of the request after its own checks.
 */
export function resolveApprovalDecision(
  mode: string | undefined,
  kind: ApprovalRequestKind
): ApprovalDecision {
  return decisions.get(mode)?.[kind] ?? 'ask';
}
