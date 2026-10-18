/**
 * How one approval row is written and read back: the sweeps and caps every stored value passes
 * through, the token digest, and the card a surface draws from a row. Split out of
 * `approval-service.ts`, which keeps the token contract and the state machine; nothing here
 * decides anything about a request, it only stores and shows one.
 *
 * @module services/core/approvals/approval-row
 */
import { createHash } from 'node:crypto';
import { approvals } from '@dorkos/db';
import { isExtensionCapabilityId, type CapabilitySource } from '@dorkos/shared/capabilities';
import type { ProjectRef } from '@dorkos/shared/project-schemas';
import {
  APPROVAL_DETAIL_MAX_LENGTH,
  APPROVAL_REQUEST_REASON_MAX_LENGTH,
  APPROVAL_SUMMARY_MAX_LENGTH,
  ApprovalServiceActionSchema,
  type ApprovalServiceAction,
  type PendingApproval,
} from '@dorkos/shared/approval-schemas';
import { isFloorArea, type PermissionAreaId } from '@dorkos/shared/permissions';
import { extensionSourcePhrase, redactSecretsInText } from './approval-summary.js';
import { TEAMMATE_ASK_CAPABILITY, teammateCardFields } from './teammate-asks.js';

/** Hash a token exactly as it is stored: SHA-256, lowercase hex. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

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
function clampForStorage(value: string, max: number): string {
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

/** A stored approval row, as Drizzle infers it. */
export type ApprovalRow = typeof approvals.$inferSelect;

/**
 * Whether a card may offer "Always allow" (spec `agent-permissions` D7): DorkOS
 * knows which agent asked, the action has an area, that area is not a floor
 * area, and the approval is not bound to a connector's live authority. The
 * grant route refuses `answer: 'always'` by the same rules, from the same row,
 * so what a card offers and what the route accepts cannot drift.
 *
 * The last rule does not rest on connector actions having no area today. A
 * connector approval is bound to one connection, one operation revision and
 * one session (`connectorAuthority`); a standing yes would outlive every one of
 * them, which is what the old standing grants refused for connector preflight
 * too. So a card carrying that binding never offers it, whatever area a future
 * connector action is given.
 *
 * A card that shows a change to read, old → new (`describeApprovalChange`,
 * DOR-2328) or a text in full (`approvalDetailField`), never offers it either:
 * the promise of those cards is that a person sees every such change before it
 * happens, and a standing yes would let the next change through unseen.
 *
 * Nor does a card for an extension's destructive tool (DOR-2685): every call
 * asks, because the tool's tier is its author's to change and a standing yes
 * keyed by its id would outlive the version it was given for.
 *
 * @param row - The stored approval.
 */
export function isAlwaysOffered(row: {
  requestedByPath: string | null;
  area: string | null;
  authorityBindingDigest: string | null;
  detail?: string | null;
  /** Required: the extension rule reads it, and a caller must not be able to forget it. */
  capabilityId: string;
  /** Required for the same reason. */
  tier: string;
}): boolean {
  return (
    row.requestedByPath !== null &&
    row.area !== null &&
    !isFloorArea(row.area) &&
    row.authorityBindingDigest === null &&
    (row.detail ?? null) === null &&
    !(row.tier === 'destructive' && isExtensionCapabilityId(row.capabilityId)) &&
    // A config patch asks outside its own area only for a setting a person
    // must decide each time (`areasForInput`). Permissions stopped being a
    // floor area under Trusted (DOR-2739), so this keeps that card from
    // offering Always allow, as a floor area's never does.
    !(row.capabilityId === 'operator.config_patch' && row.area !== 'settings') &&
    // A teammate's request is one call, once (DOR-2956): a standing yes would let a space member
    // run the owner's tools unasked. It names no agent path either; this does not rest on that.
    row.capabilityId !== TEAMMATE_ASK_CAPABILITY
  );
}

/** The stored connected-app action as a spreadable field, or nothing. */
function withServiceAction(stored: string | null): { serviceAction?: ApprovalServiceAction } {
  const serviceAction = storedServiceAction(stored);
  return serviceAction ? { serviceAction } : {};
}

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
    // The raw path stays off the wire (see `requestedByPath`'s own comment); what
    // goes out is the one bit a surface needs, which is whether there is one.
    hasAgentPath: row.requestedByPath !== null,
    area: recordedArea(row.area),
    alwaysOffered,
    ...(suggestion
      ? { suggestAlways: true as const, allowedThisWeek: suggestion.allowedThisWeek }
      : {}),
    ...(row.blockedRequest ? { blockedRequest: true as const } : {}),
    ...((row.blockedRequest || row.teammateMemberId !== null) && row.requestReason
      ? { requestReason: row.requestReason }
      : {}),
    ...teammateCardFields(row),
    ...(roomId ? { roomId } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(source ? { source: { kind: source.kind, id: source.id, name: source.name } } : {}),
    requestedAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
