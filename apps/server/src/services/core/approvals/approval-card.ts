/**
 * A stored approval row, as the card every surface draws.
 *
 * @module services/core/approvals/approval-card
 */
import { agentRaiseNote, isAgentRaiseCard } from './agent-raise/agent-raise-cards.js';
import type { approvals } from '@dorkos/db';
import {
  isExtensionCapabilityId,
  type CapabilitySource,
  type CapabilityTier,
} from '@dorkos/shared/capabilities';
import type { ProjectRef } from '@dorkos/shared/project-schemas';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { PermissionAreaId } from '@dorkos/shared/permissions';
import { cannotAllowCard, incompletePackageLabel } from './approval-completeness.js';
import { isAlwaysOffered } from './always-offered.js';
import { withMarketplaceSummary, withServiceAction } from './approval-storable.js';
import { extensionSourcePhrase } from './approval-summary.js';
import { approvalStepUpHash } from './model/approval-step-up-binding.js';
import { requestCodeForHash } from '../auth/step-up/request-code.js';

/** A stored approval row, as Drizzle infers it. */
export type ApprovalRow = typeof approvals.$inferSelect;

/** The decision route’s scope, read from the same row as its card. */
export interface ApprovalAnswerScope {
  /** The capability id or hand-registered tool name. */
  capabilityId: string;
  /** The agent's path, or `null` for an unidentified request. */
  agentPath: string | null;
  /** The recorded area, or `null` for an action with no area. */
  area: PermissionAreaId | null;
  /** Whether "Always allow" may be answered (see {@link isAlwaysOffered}). */
  alwaysOffered: boolean;
  /** Whether the agent asked past a Blocked permission. */
  blockedRequest: boolean;
  /** Whether granting it could raise what agents may do (DOR-3037). */
  raisesPermissions: boolean;
  /** Where the request stands right now. */
  state: 'pending' | 'granted' | 'denied';
  /** Whether it is spent, written off, or past its window. */
  closed: boolean;
  /** The recorded permission tier of the action. */
  tier: CapabilityTier;
}

/**
 * The recorded area, read defensively: a hand-edited row never breaks a card.
 *
 * @param area - The stored area, or `null`.
 */
export function recordedArea(area: string | null): PermissionAreaId | null {
  return area === null ? null : (area as PermissionAreaId);
}

/** What a card reads live, beside its stored row. */
export interface ApprovalCardContext {
  /** The room whose turn raised it, when there is one. */
  roomId?: string;
  /** Whether the card should suggest Always allow; asked only of a card that offers it. */
  suggestAlways?: (row: ApprovalRow) => { allowedThisWeek: number } | null;
  /** The project an asking session's folder belongs to. */
  projectForFolder?: (cwd: string) => ProjectRef | null | undefined;
  /** The running extension an `ext_` capability comes from. */
  sourceOf?: (capabilityId: string) => CapabilitySource | undefined;
  /** What a yes on this capability does, for the badge (DOR-3359). */
  consequenceOf?: (capabilityId: string) => string | undefined;
}

/**
 * Project a stored row into the app-facing shape. Never includes the hash.
 *
 * @param row - The stored approval.
 * @param context - What the card reads live; see {@link ApprovalCardContext}.
 */
export function toPendingApproval(
  row: ApprovalRow,
  context: ApprovalCardContext = {}
): PendingApproval {
  const { roomId, suggestAlways, projectForFolder, sourceOf, consequenceOf } = context;
  // Read live from the capability, like the source: a badge that says what a
  // yes does, for the cards that name one (DOR-3359).
  const consequence = consequenceOf?.(row.capabilityId);
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
    requestCode: requestCodeForHash(approvalStepUpHash(row)),
    capabilityId: row.capabilityId,
    capabilityTitle:
      row.capabilityId === 'harness.project_hooks'
        ? `${incompletePackageLabel(row.packageRequest)} wants to run code on this computer`
        : row.capabilityTitle,
    tier: row.tier,
    ...(consequence ? { consequence } : {}),
    summary: row.summary,
    ...(row.capabilityId === 'harness.project_hooks'
      ? { packageLabel: incompletePackageLabel(row.packageRequest) }
      : {}),
    ...(cannotAllowCard(row)
      ? { cannotAllow: true as const, packageLabel: incompletePackageLabel(row.packageRequest) }
      : {}),
    ...(row.detail === null ? {} : { detail: row.detail }),
    // An agent's raise card keeps a name an agent can set out of its box (DOR-4355 M4).
    ...(isAgentRaiseCard(row.capabilityId) && agentRaiseNote(row.id)
      ? { detailNote: agentRaiseNote(row.id) }
      : {}),
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

/**
 * How the service learns a capability's human-facing title and permission tier.
 *
 * Deliberately NOT part of {@link ApprovalRequestInput}: if a requester could
 * state its own tier, an `act` operation could dress itself as `destructive` to
 * scare an operator, or a `destructive` one could soften itself to look routine.
 * The card's identity region is derived from the capability registry, which is
 * the single source of truth every other agent-facing surface is generated from,
 * so it cannot be spoofed by whoever is asking.
 *
 * Injected as a function rather than a registry import because the registry is
 * composed from the very domains that request approvals — a static import would
 * close a cycle, and the registry is composed later in boot than this service.
 *
 * Lives beside the card it describes; only the service names it.
 *
 * @param capabilityId - The capability id to describe.
 * @returns Its title and tier, or `undefined` when the registry has no such id.
 */
export type CapabilityDescriptorLookup = (capabilityId: string) =>
  | {
      title: string;
      tier: CapabilityTier;
      source?: CapabilitySource;
      /** What a yes does, for the badge in place of the tier's own label. */
      consequence?: string;
      /**
       * Whether a request's own `title` is honoured. Only server code that
       * builds titles from fixed templates sets it (the repo pins); for any
       * other capability a request's title is ignored, so no request an agent
       * can shape names its own card.
       */
      titledPerRequest?: true;
    }
  | undefined;

/** The grant route's scope, from the same stored row the card renders. */
export function toAnswerScope(row: ApprovalRow, expired: boolean): ApprovalAnswerScope {
  return {
    capabilityId: row.capabilityId,
    agentPath: row.requestedByPath,
    area: recordedArea(row.area),
    alwaysOffered: isAlwaysOffered(row),
    blockedRequest: row.blockedRequest,
    raisesPermissions: row.raisesPermissions,
    state: row.state,
    closed: row.consumedAt !== null || expired,
    tier: row.tier,
  };
}
