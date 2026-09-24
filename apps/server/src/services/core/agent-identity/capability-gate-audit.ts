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
 * ## The one exception: a call an Allowed permission let through
 *
 * A destructive call allowed by an action-level Allowed permission (an Always
 * allow, spec `agent-permissions` D6) IS recorded here, as
 * `capability.auto_approved`. It is the one
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
 * Both matter more now that an Always allow can let a call through: an
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
import type { ActivityService } from '../../activity/activity-service.js';
import { activityActorForIdentity } from '../../activity/activity-actor.js';
import type { TierEnforcementAttempt } from '../capabilities/index.js';

/**
 * Build the audit hook the pre-invoke gates call for every attempt they did not
 * allow.
 *
 * Boot wires it to `initCapabilityTierGate`, which now answers both the tier and
 * the permission question (spec `agent-permissions` D6). A `permission_blocked`
 * denial arrives here in the same `TierEnforcementAttempt` shape as a ceiling
 * refusal, and takes the same `capability.denied` branch below with no special
 * case, carrying the resolved `permission` in its metadata.
 *
 * `emit` is fire-and-forget and never throws, and the gate swallows anything
 * this hook throws anyway, so a broken feed can never turn into a broken gate.
 *
 * @param activityService - The Activity feed writer.
 * @returns The gate's `onAttempt` hook.
 */
export function createCapabilityGateAuditObserver(
  activityService: ActivityService
): (attempt: TierEnforcementAttempt) => void {
  return ({ action, identity, decision, permission }) => {
    // One naming of an actor, shared with the attribution observer next door and
    // the extension write routes (`services/activity/activity-actor.ts`).
    const actor = activityActorForIdentity(identity);
    const label = actor.actorLabel;

    // The one allowed decision the gate reports: a destructive call an
    // ACTION-level Allowed permission let through with no card (spec
    // `agent-permissions` D6). A person named this exact action as allowed (an
    // Always allow, or a setting on the permissions page), so there was no card,
    // and the line says which layer allowed it. Recording it is what keeps a
    // stretch in which DorkOS stops asking from also being one in which it stops
    // telling: the operator's answer to "what did my agent do while I was not
    // being asked".
    //
    // The actor is derived whole (DOR-1801), so type, id and label cannot
    // disagree about who acted, whether or not an identity is present.
    if (decision.outcome === 'allowed') {
      const approval = decision.approval;
      void activityService.emit({
        ...actor,
        category: 'agent',
        eventType: 'capability.auto_approved',
        resourceType: 'capability',
        resourceId: action.id,
        resourceLabel: action.title,
        summary: `${label} ran ${action.title} because its permission is set to Allowed`,
        metadata: {
          capabilityId: action.id,
          tier: action.tier,
          via: 'permission',
          source: approval.source,
          ...(permission ? { permission } : {}),
        },
      });
      return;
    }

    const pending = decision.outcome === 'approval_required' ? decision.payload : undefined;
    const waiting = pending !== undefined;

    void activityService.emit({
      // An anonymous attempt is recorded as `system`, not as a nameless agent:
      // the feed must not imply DorkOS knows who asked when it does not.
      ...actor,
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
        // `tierCeiling` above is the RECORDED value, which for a shut-off token
        // is not the one that refused the call — a revoked agent is capped at
        // `observe` however its manifest reads. Recording the state beside it
        // keeps the line answerable: without it a feed entry says "limited to
        // anything" over a refusal citing a limit (DOR-486).
        ...(identity?.inactive ? { identityState: identity.inactive } : {}),
        reason: decision.payload.reason,
        // The permission the call resolved to, when the action has an area, so
        // "why was this refused / why did it ask" names the layer that decided.
        ...(permission ? { permission } : {}),
        ...(pending ? { approvalId: pending.approvalId } : {}),
      },
    });
  };
}
