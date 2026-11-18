/** The exact request a remote yes confirms, including every stored disclosure. */
import type { ApprovalRow } from '../approval-card.js';
import { hashApprovalInput } from '../approval-input-hash.js';

/** Bind the call, its authority, its person-readable text and its requesting agent. */
export function approvalStepUpHash(row: ApprovalRow): string {
  // Lifecycle fields are excluded: deciding the request does not change its identity.
  const {
    state: _state,
    decidedAt: _decidedAt,
    decidedByUserId: _decidedBy,
    consumedAt: _consumedAt,
    tokenHash: _tokenHash,
    denyReason: _denyReason,
    declineKind: _declineKind,
    notifiedAt: _notifiedAt,
    ...request
  } = row;
  return hashApprovalInput({ t: 'dorkos.approval.step-up.v1', request });
}
