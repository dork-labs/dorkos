/**
 * A passive approval: a row under Needs you that nothing is waiting on
 * (DOR-3427).
 *
 * On the Full preset a package DorkOS did not install is held back, and the
 * person can allow it whenever they like. Its ticket must not behave like an
 * ordinary approval: it does not escalate to the phone (its notification is
 * `notable`, not `blocking`), and it does not run out, because running out
 * would ask again every window.
 *
 * "Passive" is carried by the row's own expiry, set to {@link PASSIVE_APPROVAL_EXPIRES_AT}.
 * That is a column the table already has, so the fact survives a restart (the
 * boot pass rebuilds every pending approval's notification from its card)
 * without a migration, and every expiry check already reads it as "not yet".
 *
 * @module services/core/approvals/passive-approval
 */

/** The expiry a passive approval is written with: never, in practice. */
export const PASSIVE_APPROVAL_EXPIRES_AT = '9999-12-31T23:59:59.999Z';

/**
 * The expiry a new approval row is written with.
 *
 * @param passive - Whether it is passive (see the module docs).
 * @param deadlineMs - When an ordinary one runs out, in epoch milliseconds.
 * @returns The passive sentinel, or the deadline as an ISO string.
 */
export function approvalExpiresAt(passive: boolean, deadlineMs: number): string {
  return passive ? PASSIVE_APPROVAL_EXPIRES_AT : new Date(deadlineMs).toISOString();
}

/**
 * Whether an approval is passive (see the module docs).
 *
 * @param approval - Anything carrying the approval's expiry.
 * @returns True for a row written with {@link PASSIVE_APPROVAL_EXPIRES_AT}.
 */
export function isPassiveApproval(approval: { expiresAt: string }): boolean {
  return approval.expiresAt === PASSIVE_APPROVAL_EXPIRES_AT;
}
