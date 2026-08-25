/**
 * How a pending capability approval describes itself to the notification
 * pipeline (DOR-1570).
 *
 * ## What was broken
 *
 * A destructive capability — `tasks_delete`, `mesh_unregister`, a marketplace
 * uninstall — parks on a durable approval row and a one-time token
 * (`services/core/approvals/`). Until this file existed, that condition reached
 * the escalation ladder not at all: the ladder was typed to the three standing
 * kinds an emitter had been written for, so an agent could ask to delete
 * something irreversible and the request would sit its whole two-hour TTL with
 * NO signal outside the app — no phone push, no relay message, nothing. A
 * parked schedule got both; the strictly more dangerous case got neither.
 *
 * A capability approval is the same shape of thing as a parked schedule — a
 * blocking condition, standing, owned by its own store — so it is wired the
 * same way: {@link raiseCapabilityApproval} at the write that creates one,
 * {@link resolveCapabilityApproval} at the single funnel every ending passes
 * through.
 *
 * ## It writes no history row, on purpose
 *
 * The other standing kinds end by calling `resolveStanding`, which stores one
 * row saying how they ended. This one deliberately does not, for two reasons
 * that both point the same way:
 *
 * - The `approvals` table ALREADY records how every approval ended (`state`,
 *   `decidedAt`, `consumedAt`), and `approval_resolved` already retires its
 *   card in every open window. A second row would be a second source of truth
 *   for something that has one.
 * - Half the endings have no known actor. `grant` and `deny` come from a route
 *   that knows the operator pressed the button, but `expired` and `consumed`
 *   are discovered by the AGENT's retry — so a `blocking`-tier row would land
 *   unread and pop a banner about a decision the person had already made. That
 *   is exactly the "never notify somebody about their own action" rule the
 *   pipeline exists to keep.
 *
 * So the resolution edge does the two things that must happen and nothing else:
 * it disarms the ladder, and it tells the periphery to retire the banner.
 *
 * @module services/notifications/emitters/capability-approval
 */
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import { resolveAgentIdForPath } from '../../mesh/agent-path-lookup.js';
import { cancelEscalationByKey } from '../escalation-service.js';
import { notificationEntry, type NotificationPayload } from '../notification-registry.js';
import { broadcastStandingResolved, raiseStanding } from '../standing-events.js';

/**
 * What a pending approval is called when nobody identified themselves.
 *
 * The same sentence `describeGatedAttempt` puts on the card for the same case
 * (`capabilities/tier-enforcement.ts`), because a person deciding an
 * irreversible action should read the same thing on a lock screen as in the
 * app: DorkOS does not know who asked.
 */
export const UNNAMED_REQUESTER = 'An unidentified caller';

/**
 * Describe a pending approval to the pipeline.
 *
 * Everything here comes off the card the approval store already built — which
 * means the title and tier are the capability registry's, never the requester's
 * (see `ApprovalService.request`), and the label has already been swept for
 * secrets. Deliberately carries no argument values: this payload becomes a
 * phone push and a desktop banner.
 *
 * @param approval - The card, exactly as `GET /api/approvals/pending` returns it.
 * @param requestedByPath - The asking agent's project path, when the gate
 *   recorded one. Never rendered — it is only what resolves the Mesh agent id
 *   the escalation's chat leg routes on.
 */
export function capabilityApprovalPayload(
  approval: PendingApproval,
  requestedByPath?: string
): NotificationPayload<'approval.pending'> {
  const agentId = resolveAgentIdForPath(requestedByPath);
  return {
    approvalId: approval.approvalId,
    capabilityId: approval.capabilityId,
    capabilityTitle: approval.capabilityTitle,
    ...(agentId ? { agentId } : {}),
    requestedBy: approval.requestedBy ?? UNNAMED_REQUESTER,
  };
}

/**
 * The condition's identity, from an approval id alone.
 *
 * Built through the registry's own `dedupeKey` rather than by writing the
 * string here, for the reason `escalation-service.ts` gives at length: one
 * builder is what makes "arm" and "cancel" name the same condition. The other
 * fields are placeholders the key provably does not read — pinned by
 * `__tests__/capability-approval.test.ts`, so a `dedupeKey` that started
 * reading one would fail there rather than silently leak a timer nothing can
 * cancel.
 *
 * @param approvalId - ULID of the approval.
 */
export function capabilityApprovalKey(approvalId: string): string {
  return notificationEntry('approval.pending').dedupeKey({
    approvalId,
    capabilityId: '',
    capabilityTitle: '',
    requestedBy: '',
  });
}

/**
 * A person is now waiting to decide an irreversible action: tell the periphery
 * and start the clock.
 *
 * @param approval - The card the approval store just recorded.
 * @param requestedByPath - The asking agent's project path, when known.
 */
export function raiseCapabilityApproval(approval: PendingApproval, requestedByPath?: string): void {
  // `expiresAt` rides along so a surface that drew a banner can retire it on the
  // deadline itself. Expiry is the one ending nothing on the server announces —
  // it is enforced only when a token is presented, so an approval that runs out
  // of time with no agent retry and no operator click produces no
  // `standing_resolved` at all (DOR-1570 review). Without this, a desktop banner
  // for such an approval would linger forever, deep-linking to a bell with
  // nothing behind it.
  raiseStanding('approval.pending', capabilityApprovalPayload(approval, requestedByPath), {
    expiresAt: approval.expiresAt,
  });
}

/**
 * An approval ended — granted, denied, spent, or expired — so stop the clock
 * and retire the banner.
 *
 * Takes the id rather than the payload because that is genuinely all the
 * resolution edges have: `consume` reads a row it is about to spend, and the
 * key is built from the id alone. Safe to call for an approval that was never
 * raised.
 *
 * @param approvalId - ULID of the approval that ended.
 */
export function resolveCapabilityApproval(approvalId: string): void {
  const subjectKey = capabilityApprovalKey(approvalId);
  // Synchronously and first, exactly as `resolveStanding` disarms first: a
  // phone ping must not slip out about something a person just dealt with.
  cancelEscalationByKey(subjectKey);
  broadcastStandingResolved('approval.pending', subjectKey);
}
