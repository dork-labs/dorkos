/**
 * A stored approval row as the card a surface draws: the one projection from
 * the `approvals` table to `PendingApproval`. Never includes token material.
 *
 * Kept apart from `approval-service.ts` so the service holds the approval
 * lifecycle and this module holds what a card shows.
 *
 * @module services/core/approvals/approval-card
 */
import type { approvals } from '@dorkos/db';
import { isExtensionCapabilityId, type CapabilitySource } from '@dorkos/shared/capabilities';
import type { ProjectRef } from '@dorkos/shared/project-schemas';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { PermissionAreaId } from '@dorkos/shared/permissions';
import { isAlwaysOffered } from './always-offered.js';
import { withMarketplaceSummary, withServiceAction } from './approval-storable.js';
import { extensionSourcePhrase } from './approval-summary.js';

/** A stored approval row, as Drizzle infers it. */
export type ApprovalRow = typeof approvals.$inferSelect;

/** The recorded area, read defensively: a hand-edited row never breaks a card. */
export function recordedArea(area: string | null): PermissionAreaId | null {
  return area === null ? null : (area as PermissionAreaId);
}

/**
 * Project a stored row into the cockpit-facing shape. Never includes the hash.
 *
 * @param row - The stored approval.
 * @param roomId - The room whose turn raised it, when there is one.
 * @param suggestAlways - Whether the card should suggest Always allow; asked
 *   only of a card that offers it.
 * @param projectForFolder - The project an asking session's folder belongs to.
 * @param sourceOf - The running extension an `ext_` capability comes from.
 */
export function toPendingApproval(
  row: ApprovalRow,
  roomId?: string,
  suggestAlways?: (row: ApprovalRow) => { allowedThisWeek: number } | null,
  projectForFolder?: (cwd: string) => ProjectRef | null | undefined,
  sourceOf?: (capabilityId: string) => CapabilitySource | undefined
): PendingApproval {
  const alwaysOffered = isAlwaysOffered(row);
  const suggestion = alwaysOffered ? (suggestAlways?.(row) ?? null) : null;
  const project = projectForFolder
    ? row.requestingCwd
      ? projectForFolder(row.requestingCwd)
      : null
    : undefined;
  // Only an extension's tool names a source, and only while it runs: the card
  // then says which extension it is from. Read live, like the room above, and
  // shown only while it is the extension the stored summary named, so the
  // subtitle never contradicts the sentence under it (a rename or a reinstall
  // under the same id drops it).
  const live = isExtensionCapabilityId(row.capabilityId) ? sourceOf?.(row.capabilityId) : undefined;
  const source = live && row.summary.includes(extensionSourcePhrase(live.name)) ? live : undefined;
  return {
    approvalId: row.id,
    capabilityId: row.capabilityId,
    capabilityTitle: row.capabilityTitle,
    tier: row.tier,
    summary: row.summary,
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.requestedBy ? { requestedBy: row.requestedBy } : {}),
    // Both halves or neither: a label with no id behind it is the shape this
    // field exists to avoid, since the id is what makes the name checkable.
    ...(row.subjectKind && row.subjectLabel && row.subjectId
      ? { subject: { kind: row.subjectKind, label: row.subjectLabel, id: row.subjectId } }
      : {}),
    ...(row.origin && !row.requestedBy ? { origin: row.origin } : {}),
    // Gated on the SUBJECT, not on itself: the card only swaps the summary out
    // for this when it has a subject block to swap it for, so a remainder
    // without one would be a clause nothing renders.
    ...(row.otherArguments && row.subjectLabel ? { otherArguments: row.otherArguments } : {}),
    ...withServiceAction(row.serviceAction),
    ...withMarketplaceSummary(row.marketplaceSummary),
    // The raw path stays off the wire (see `requestedByPath`'s own comment); what
    // goes out is the one bit a surface needs, which is whether there is one.
    hasAgentPath: row.requestedByPath !== null,
    area: recordedArea(row.area),
    alwaysOffered,
    ...(suggestion
      ? { suggestAlways: true as const, allowedThisWeek: suggestion.allowedThisWeek }
      : {}),
    ...(row.blockedRequest ? { blockedRequest: true as const } : {}),
    ...(row.blockedRequest && row.requestReason ? { requestReason: row.requestReason } : {}),
    ...(roomId ? { roomId } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(source ? { source: { kind: source.kind, id: source.id, name: source.name } } : {}),
    requestedAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
