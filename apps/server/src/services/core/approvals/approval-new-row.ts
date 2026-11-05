/** Construct a bounded approval row; persistence and publication belong to the service. */
import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulidx';
import type { ApprovalRequestInput } from './approval-request-input.js';
import type { CapabilityDescriptorLookup } from './approval-card.js';
import { storablePackageRequest, storablePackageDetail } from './approval-completeness.js';
import {
  storableSummary,
  storableReason,
  storableServiceAction,
  storableMarketplaceCard,
} from './approval-storable.js';
import { renderRequesterLabel } from './approval-summary.js';
import { approvalExpiresAt } from './passive-approval.js';

/** Size of a one-use approval token, in random bytes. */
export const APPROVAL_TOKEN_BYTES = 16;
const TOKEN_BYTES = APPROVAL_TOKEN_BYTES;
const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** Sweep caller values while retaining the server-only full request for grant checks. */
export function newApprovalRow(
  input: ApprovalRequestInput,
  ttlMs: number,
  describeCapability?: CapabilityDescriptorLookup
) {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const now = Date.now();
  const descriptor = describeCapability?.(input.capabilityId);
  const row = {
    id: ulid(),
    tokenHash: hashToken(token),
    capabilityId: input.capabilityId,
    capabilityTitle:
      input.title && descriptor?.titledPerRequest
        ? storableSummary(input.title)
        : (descriptor?.title ?? input.capabilityId),
    tier: descriptor?.tier ?? ('destructive' as const),
    inputHash: input.inputHash,
    authorityBindingDigest: input.connectorAuthority?.digest ?? null,
    connectorOwnerKind: input.connectorAuthority?.ownerKind ?? null,
    connectorOwnerId: input.connectorAuthority?.ownerId ?? null,
    connectorAgentId: input.connectorAuthority?.agentId ?? null,
    connectorSessionId: input.connectorAuthority?.sessionId ?? null,
    connectorConnectionId: input.connectorAuthority?.connectionId ?? null,
    connectorOperationRevisionId: input.connectorAuthority?.operationRevisionId ?? null,
    summary: storableSummary(input.summary),
    packageRequest: storablePackageRequest(input),
    // Absent for every capability that declares no detail field, which is all
    // but one — `null` rather than `undefined` so the column is written.
    detail: storablePackageDetail(input),
    // Caller-supplied, so capped and swept for secrets exactly like the summary.
    requestedBy: input.requestedBy ? renderRequesterLabel(input.requestedBy) : null,
    // Stored raw and never rendered: an Always allow writes onto the agent this
    // names, so sweeping or shortening it would break the match.
    requestedByPath: input.requestedByPath ?? null,
    area: input.area ?? null,
    blockedRequest: input.blockedRequest !== undefined,
    raisesPermissions: input.raisesPermissions === true,
    requestReason: input.blockedRequest ? storableReason(input.blockedRequest.reason) : null,
    // Capped HERE as well as in the resolver, for the reason `storableSummary`
    // gives two lines up: `ApprovalRequestInput` is public API, not private to
    // `resolveApprovalSubject`, and the wire schema caps these at 60 — so a
    // caller passing a longer label would store a row the cockpit's own parse
    // rejects, and a dropped card is worse than a shortened one.
    subjectKind: input.subject?.kind ?? null,
    subjectId: input.subject ? renderRequesterLabel(input.subject.id) : null,
    subjectLabel: input.subject ? renderRequesterLabel(input.subject.label) : null,
    otherArguments: input.otherArguments ? storableSummary(input.otherArguments) : null,
    serviceAction: input.serviceAction ? storableServiceAction(input.serviceAction) : null,
    ...storableMarketplaceCard(input.marketplace),
    // Withheld the moment a caller IS named, so the two can never contradict
    // each other on a card.
    origin: input.requestedBy ? null : (input.origin ?? null),
    state: 'pending' as const,
    denyReason: null,
    declineKind: null,
    retryOf: null,
    createdAt: new Date(now).toISOString(),
    expiresAt: approvalExpiresAt(input.passive === true, now + ttlMs),
    decidedAt: null,
    decidedByUserId: null,
    consumedAt: null,
    // A delivery ADDRESS, not an authority: where to tell the answer to, when
    // the asking surface had a session at all.
    requestingSessionId: input.requestingSession?.sessionId ?? null,
    requestingCwd: input.requestingSession?.cwd ?? null,
    notifiedAt: null,
  };
  return { row, token };
}
