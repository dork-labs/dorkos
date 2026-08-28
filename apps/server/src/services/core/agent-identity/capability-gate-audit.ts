/**
 * Turn refused and pending capability attempts into Activity events
 * (spec `agent-trust` §3.2).
 *
 * The attribution observer next door records what an agent DID
 * (`capability-attribution.ts`). This one records what a caller TRIED and was not
 * allowed to do, which is the more interesting half of an audit trail: an agent
 * repeatedly reaching for something destructive, or bumping into its own tier
 * ceiling, is exactly the pattern an operator wants to see in the feed.
 *
 * Anonymous attempts are recorded too, under `actorType: 'system'` rather than as
 * a nameless agent. An unidentified caller reaching for something irreversible is
 * the single most interesting line this observer can write, and the tier gate does
 * not let identity presence decide whether to gate — so it must not decide whether
 * to audit either.
 *
 * Allowed calls are deliberately NOT recorded here, so one invocation produces one
 * Activity record and never two. For a REGISTRY capability the attribution
 * observer next door writes that record.
 *
 * ## The one exception: a call a standing permission let through
 *
 * A destructive call allowed by a standing permission IS recorded here, as
 * `capability.auto_approved` (spec `agent-approval-settings` §3.6). It is the one
 * allowed decision the gate reports, and it is not a duplicate of anything: the
 * attribution observer knows that the call ran, but only the gate knows that
 * nobody was asked. On a registry-borne surface both lines appear, and they say
 * different things — "you were not asked about this" and "it ran" (or failed). On
 * the hand-registered MCP path, where no attribution observer runs, this is the
 * only line there is, which is why it lives here rather than next door.
 *
 * On the OTHER TWO paths into the gate nobody does, and that is a real gap rather
 * than a symmetry. The attribution observer is wired into
 * `composeDorkOsCapabilityRegistry`, so it only fires inside `registry.invoke`:
 *
 * - The 47 hand-registered MCP tools (DOR-468) never reach the registry. An
 *   approved `tasks_delete` produces an `approval_required` line here, a durable
 *   approval record when the person grants it, and then no line saying it ran.
 *   Closing it needs an attribution observer on `services/core/mcp-tool-gate.ts`.
 * - `authorizeCapability` callers do not either. The legacy marketplace mutation
 *   routes reach the gate and then perform the effect THEMSELVES
 *   (`routes/marketplace.ts`), so an approved uninstall through the cockpit route
 *   leaves the same silence. Closing it needs the same observer on that seam.
 *
 * Both matter more now that a standing permission can allow a call: an
 * auto-approved uninstall on either path yields one line saying nobody was asked
 * and nothing saying it ran.
 *
 * Because the gate covers those tools, `resourceId` here can be a bare tool name
 * like `tasks_delete` as well as a `domain.verb` capability id. `resourceType`
 * stays `capability` for both: the feed is answering "what did something try to
 * do", and the query API has no `resourceType` filter at all, so splitting the two
 * would buy nothing while scattering one operator question across two buckets that
 * cannot be unioned.
 *
 * @module services/core/agent-identity/capability-gate-audit
 */
import path from 'node:path';
import type { ActivityService } from '../../activity/activity-service.js';
import type { TierEnforcementAttempt } from '../capabilities/index.js';

/**
 * Build the audit hook the pre-invoke gates call for every attempt they did not
 * allow.
 *
 * **Boot wires the same observer to BOTH gates** — `initCapabilityTierGate` for
 * the tier answer, and `initToolGroupGate` for the per-agent tool-group grant
 * (DOR-1611). One hook rather than two because the operator's question is one
 * question: what did something try to do and not get. A `tool_group_disabled`
 * denial arrives here in the same `TierEnforcementAttempt` shape as a ceiling
 * refusal, and takes the same `capability.denied` branch below with no special
 * case.
 *
 * `emit` is fire-and-forget and never throws, and both gates swallow anything
 * this hook throws anyway, so a broken feed can never turn into a broken gate.
 *
 * @param activityService - The Activity feed writer.
 * @returns The `onAttempt` hook both gates call.
 */
export function createCapabilityGateAuditObserver(
  activityService: ActivityService
): (attempt: TierEnforcementAttempt) => void {
  return ({ action, identity, decision }) => {
    const label = identity
      ? identity.displayName || path.basename(identity.agentPath)
      : 'Unidentified caller';

    // The one allowed decision the gate reports: a destructive call a standing
    // permission let through with no card. Recording it is what keeps a window in
    // which DorkOS stops asking from also being a window in which it stops
    // telling — the operator's answer to "what did my agent do while I was not
    // being asked". `identity` is always present here, because a permission keys on
    // agent path and an anonymous caller can never match one.
    if (decision.outcome === 'allowed') {
      void activityService.emit({
        actorType: 'agent',
        ...(identity ? { actorId: identity.agentPath } : {}),
        actorLabel: label,
        category: 'agent',
        eventType: 'capability.auto_approved',
        resourceType: 'capability',
        resourceId: action.id,
        resourceLabel: action.title,
        summary: `${label} ran ${action.title} under a standing permission you granted`,
        metadata: {
          capabilityId: action.id,
          tier: action.tier,
          grantId: decision.approval.grantId,
        },
      });
      return;
    }

    const pending = decision.outcome === 'approval_required' ? decision.payload : undefined;
    const waiting = pending !== undefined;

    void activityService.emit({
      // An anonymous attempt is recorded as `system`, not as a nameless agent:
      // the feed must not imply DorkOS knows who asked when it does not.
      actorType: identity ? 'agent' : 'system',
      ...(identity ? { actorId: identity.agentPath } : {}),
      actorLabel: label,
      category: 'agent',
      eventType: waiting ? 'capability.approval_required' : 'capability.denied',
      resourceType: 'capability',
      resourceId: action.id,
      resourceLabel: action.title,
      summary: waiting
        ? `${label} needs approval to run ${action.title}`
        : `${label} was not allowed to run ${action.title}`,
      metadata: {
        capabilityId: action.id,
        tier: action.tier,
        ...(identity ? { tierCeiling: identity.tierCeiling } : {}),
        reason: decision.payload.reason,
        ...(pending ? { approvalId: pending.approvalId } : {}),
      },
    });
  };
}
