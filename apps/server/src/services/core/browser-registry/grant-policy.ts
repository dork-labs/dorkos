/**
 * Pure grant metadata policy. A passing result is not an authorization ticket.
 * No production resolver or consumer is wired to this evaluator.
 */
import {
  BrowserAttachmentSchema,
  BrowserCounterSchema,
  BrowserGrantSchema,
  BrowserPermissionSchema,
  BrowserReferenceSchema,
  type BrowserAttachment,
  type BrowserPermission,
} from '@dorkos/shared/browser-schemas';

/**
 * Correspondence supplied by a future trusted server resolver, never request
 * body fields. This structural data type does not certify provenance: the
 * resolver must separately establish actor/owner access and current records.
 * Grant projections carry no actor, owner or complete seven-field binding.
 */
export interface BrowserGrantCorrespondence {
  readonly grantId: string;
  readonly expectedRevision: number;
  readonly tabId: string;
  readonly attachment: BrowserAttachment;
}

/** Every refusal has the same public disposition, without revealing records. */
export type BrowserGrantEligibility = 'metadataEligible' | 'inaccessible';

/**
 * Check a metadata snapshot against trusted server correspondence and time.
 *
 * UTC timestamps are informational wire data. The caller must supply current
 * epoch milliseconds from its trusted server clock; this function reads no
 * clock and creates no lease. Equality at expiry refuses. A successful result
 * must never bypass fresh revocation, actor/owner, controller or full binding
 * checks at dispatch. Parsing request data cannot create correspondence.
 *
 * @param grant - An untrusted or persisted grant projection to validate.
 * @param correspondence - Server-resolved scope, absent when unresolved.
 * @param permission - The specific permission required by the operation.
 * @param nowEpochMs - Current trusted server time, never client time.
 * @returns Metadata eligibility only, or the indistinguishable refusal.
 */
export function evaluateBrowserGrantMetadata(
  grant: unknown,
  correspondence: BrowserGrantCorrespondence | null | undefined,
  permission: BrowserPermission,
  nowEpochMs: number
): BrowserGrantEligibility {
  try {
    if (!correspondence || !Number.isFinite(nowEpochMs) || nowEpochMs < 0) return 'inaccessible';
    const parsed = BrowserGrantSchema.safeParse(grant);
    const required = BrowserPermissionSchema.safeParse(permission);
    const grantId = BrowserReferenceSchema.safeParse(correspondence.grantId);
    const revision = BrowserCounterSchema.safeParse(correspondence.expectedRevision);
    const tabId = BrowserReferenceSchema.safeParse(correspondence.tabId);
    const attachment = BrowserAttachmentSchema.safeParse(correspondence.attachment);
    if (
      !parsed.success ||
      !required.success ||
      !grantId.success ||
      !revision.success ||
      !tabId.success ||
      !attachment.success
    )
      return 'inaccessible';

    const metadata = parsed.data;
    const expiresAt = Date.parse(metadata.expiresAt);
    const scope = attachment.data;
    const sameAttachment =
      metadata.attachment.kind === scope.kind &&
      (metadata.attachment.kind === 'session' && scope.kind === 'session'
        ? metadata.attachment.sessionId === scope.sessionId
        : metadata.attachment.kind === 'room' &&
          scope.kind === 'room' &&
          metadata.attachment.roomId === scope.roomId);
    if (
      metadata.grantId !== grantId.data ||
      metadata.grantRevision !== revision.data ||
      metadata.tabId !== tabId.data ||
      !sameAttachment ||
      metadata.revokedAt !== null ||
      !metadata.permissions.includes(required.data) ||
      !Number.isFinite(expiresAt) ||
      nowEpochMs >= expiresAt
    )
      return 'inaccessible';
    return 'metadataEligible';
  } catch {
    return 'inaccessible';
  }
}
