/**
 * What a person reads when DorkOS's servers turn down an authority change.
 *
 * @module services/connectors/resources/managed-authority-rejection
 */
import type { ManagedConnectorAuthorityCommandStatus } from '@dorkos/shared/connector-managed-schemas';

/** Why the hosted side refused one authority command. */
export type ManagedAuthorityRejectionCode = Extract<
  ManagedConnectorAuthorityCommandStatus,
  { state: 'rejected' }
>['rejectionCode'];

/**
 * The plain line for a refused authority change.
 *
 * @param code - The hosted rejection code, when the status carried one.
 */
export function rejectionReason(code?: ManagedAuthorityRejectionCode): string {
  switch (code) {
    case 'permission_upgrade_required':
      return 'Your DorkOS account link needs updating. Link this computer again in Settings › DorkOS account.';
    case 'revision_unavailable':
      return 'One or more selected actions are no longer available.';
    case 'scope_conflict':
      return 'A newer change to this account replaced this one.';
    case 'approval_denied':
      return 'This change was declined when it was sent for approval.';
    case 'approval_expired':
      return 'Nobody approved this change in time, so it wasn’t applied.';
    case 'approval_limit_reached':
      return 'Too many changes are waiting for approval. Approve or decline some first.';
    case 'connection_unavailable':
    default:
      return 'Your DorkOS account no longer has this connection.';
  }
}
