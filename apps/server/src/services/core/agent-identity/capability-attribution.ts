/**
 * Turn capability invocations by an identified agent into Activity events
 * (spec `agent-trust` §3.1).
 *
 * The Activity feed already models a non-human actor — `actorType: 'agent'`
 * with an `actorId` — but nothing populated it for the agent-operator surface,
 * so an agent driving DorkOS through `dorkos call` or the `/mcp` tools left no
 * trace of WHO acted. This observer closes that gap at the registry's single
 * invocation choke point, so every surface gains attribution at once.
 *
 * ## Identified invocations, plus every destructive one
 *
 * For `observe` and `act` capabilities the observer fires only when a request
 * resolved an agent identity. An unattributed call — the human operator in the
 * cockpit, an external MCP client with no token — writes nothing, so the
 * absent-token path stays exactly as it was before identity existed (spec §3.1).
 * Attribution is the feature; logging every anonymous read would be a different,
 * noisier one.
 *
 * A `destructive` invocation is always recorded, identified or not, under
 * `actorType: 'system'` when DorkOS does not know who asked. The tier gate does
 * not audit calls it ALLOWS (it defers to this observer), so an anonymous
 * destructive call used to leave a "waiting for approval" line and then nothing at
 * all about the irreversible thing that ran. An unidentified caller completing
 * something irreversible is the single most important line in this feed.
 *
 * ## An unidentified change goes to the audit log, not the feed
 *
 * The registry now reports every non-read call, identified or not (spec
 * `audit-trail` PR2). An unidentified `act` call — the person in the app, an
 * external MCP client with no token — is recorded in the audit log directly,
 * under the request's actor, and NOT in the Activity feed, which stays exactly
 * as it was. The feed is the summary people scroll; the audit log is the
 * complete record, and with trusted-by-default an anonymous change is the
 * common case.
 *
 * ## A request is not a failure
 *
 * The request tool (`request_permission`, a capability that forwards an
 * approval) hands on the gate's refusal for the action it asked about: that is
 * how a card, or a request held back by its limits, reaches the agent. Neither
 * is a failure, so each is recorded as what happened: `capability.asked` when a
 * card went to a person, and `capability.request_refused` when DorkOS turned the
 * request down itself, naming why. Only a real error is `capability.failed`.
 *
 * ## A tool that kept its audit name
 *
 * A capability that declares an `auditAction` is a tool that moved here from
 * the hand-registered tool gate (`mcp-tool-gate.ts`), whose rows people may
 * already filter on. It is recorded the way that gate recorded it, and only
 * that way: one audit row per `act` or `destructive` call under that name, as
 * the calling agent, and no Activity row; a read records nothing
 * ({@link recordUnderAuditAction}).
 *
 * @module services/core/agent-identity/capability-attribution
 */
import type { ActivityService } from '../../activity/activity-service.js';
import { PROGRAM_ACTOR_LABEL } from '@dorkos/shared/activity-schemas';
import { activityActorForIdentity } from '../../activity/activity-actor.js';
import { auditTrail, recordAudit, runAsAgent } from '../../audit/audit-trail.js';
import {
  CapabilityGateRefusal,
  type CapabilityDefinition,
  type CapabilityHandlerContext,
  type CapabilityInvocationObserver,
} from '../capabilities/index.js';

/** Why DorkOS turned a request down itself, as the feed says it. */
const REQUEST_REFUSED_BECAUSE: Record<string, string> = {
  request_pending: 'it already has a request waiting in that area',
  recently_denied: 'the answer to the same request was no less than a day ago',
  request_limit: 'it has already asked five times this hour',
};

/** What an invocation came to, for the feed. */
interface AttributedOutcome {
  eventType: string;
  summary: string;
  metadata: Record<string, unknown>;
}

/**
 * Read a gate refusal the request tool passed on, or `undefined` for anything
 * else (see "A request is not a failure" in the module TSDoc).
 *
 * @param capability - The capability that threw.
 * @param error - What it threw.
 * @param label - Who asked, as the feed names them.
 */
function requestOutcome(
  capability: CapabilityDefinition,
  error: unknown,
  label: string
): AttributedOutcome | undefined {
  if (!capability.forwardsApproval || !(error instanceof CapabilityGateRefusal)) return undefined;
  const { decision } = error;
  const payload = decision.payload;
  const target = payload.capabilityTitle;
  const facts = { requestedCapabilityId: payload.capabilityId, reason: payload.reason };
  if (decision.outcome === 'approval_required') {
    return {
      eventType: 'capability.asked',
      summary: `${label} asked to be allowed to run ${target}`,
      metadata: { ...facts, approvalId: decision.payload.approvalId },
    };
  }
  const because = REQUEST_REFUSED_BECAUSE[payload.reason];
  return {
    eventType: 'capability.request_refused',
    summary: because
      ? `${label} asked to be allowed to run ${target}, and was not asked again because ${because}`
      : `${label} asked to be allowed to run ${target}, and DorkOS refused: ${payload.message}`,
    metadata: facts,
  };
}

/** The machine tag on a person's read past an area Blocked for agents (DOR-4978). */
export const PERSON_READ_ACTION = 'capability.rest_proof_read';

/** What the audit row says about why that read ran, for a person reading the log. */
export const PERSON_READ_REASON = 'Your own read in the app, past an area blocked for agents';

/** How long one person's repeated read of one thing, from one sign-in or device, is one row. */
export const PERSON_READ_WINDOW_MS = 10 * 60 * 1000;

/** How many open windows the recorder remembers; past this, the oldest is forgotten. */
export const PERSON_READ_MAX_WINDOWS = 1000;

/**
 * Record a person's reads past an area Blocked for agents, at most one row per
 * person, sign-in or address, and capability in each
 * {@link PERSON_READ_WINDOW_MS} (the app polls). The first read in a window is
 * always written, and a read that failed is always written: only successful
 * reads are grouped. At most {@link PERSON_READ_MAX_WINDOWS} windows are kept;
 * forgetting one only writes one more row.
 *
 * @returns The recorder; it keeps the open windows in memory.
 */
export function personReadRecorder(): (
  capability: CapabilityDefinition,
  context: CapabilityHandlerContext,
  ok: boolean,
  readGroup: string | undefined
) => void {
  // Oldest first: a window is deleted and set again when it reopens.
  const opened = new Map<string, number>();
  return (capability, context, ok, readGroup) => {
    const now = Date.now();
    if (ok) {
      // With login off there is no signed-in person, so the person part is
      // empty and the sign-in or address alone tells readers apart.
      const key = [context.userId ?? '', readGroup ?? '', capability.id].join('|');
      const since = opened.get(key);
      if (since !== undefined && now - since < PERSON_READ_WINDOW_MS) return;
      opened.delete(key);
      opened.set(key, now);
      for (const [other, at] of opened) {
        if (opened.size <= PERSON_READ_MAX_WINDOWS && now - at < PERSON_READ_WINDOW_MS) break;
        opened.delete(other);
      }
    }
    recordAudit({
      action: PERSON_READ_ACTION,
      operation: 'access',
      target: { type: 'capability', id: capability.id, name: capability.title },
      outcome: ok ? 'ok' : 'failed',
      reason: PERSON_READ_REASON,
      summary: ok
        ? `Read ${capability.title}, which agents are blocked from`
        : `Tried to read ${capability.title}, which agents are blocked from, and it failed`,
    });
  };
}

/**
 * Record one call of a capability with an `auditAction`, as the hand-registered
 * tool gate records its tools (`invokeAudited` in `mcp-tool-gate.ts`): the
 * action name, `remove` for a destructive call and `execute` otherwise, what it
 * acted on, the approval a person spent, and the error when it threw. It runs as
 * the calling agent, or as an unidentified one in session, exactly as the
 * handler did.
 *
 * @param capability - The capability that ran.
 * @param auditAction - The name it records under.
 * @param context - The context the handler was invoked with.
 * @param ok - Whether the handler completed without throwing.
 * @param error - What the handler threw, when it did.
 */
function recordUnderAuditAction(
  capability: CapabilityDefinition,
  auditAction: string,
  context: CapabilityHandlerContext,
  ok: boolean,
  error: unknown
): void {
  if (capability.tier === 'observe') return;
  const { subject, approval } = context;
  runAsAgent(
    context.identity,
    context.sessionId,
    () =>
      recordAudit({
        action: auditAction,
        operation: capability.tier === 'destructive' ? 'remove' : 'execute',
        target: subject ? { type: subject.kind, id: subject.id, name: subject.label } : null,
        outcome: ok ? 'ok' : 'failed',
        ...(ok || error === undefined
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
        ...(approval?.via === 'approval' ? { links: { approvalId: approval.approvalId } } : {}),
        summary: `${ok ? 'Ran' : 'Tried to run'} ${capability.title}${
          subject ? ` on ${subject.label}` : ''
        }`,
      }),
    { inSession: context.mcpServer === 'in-session' }
  );
}

/**
 * Build the {@link CapabilityInvocationObserver} that records agent-attributed
 * capability invocations in the Activity feed.
 *
 * `emit` is fire-and-forget and never throws, so the returned observer is safe
 * to call on both the success and failure paths of an invocation.
 *
 * @param activityService - The Activity feed writer.
 * @returns An observer to hand to `composeRegistry`.
 */
export function createCapabilityAttributionObserver(
  activityService: ActivityService
): CapabilityInvocationObserver {
  const recordPersonRead = personReadRecorder();
  return ({ capability, context, ok, error, readGroup }) => {
    // A tool that kept its hand-gate audit name is recorded only as that gate did.
    const { auditAction } = capability;
    if (auditAction !== undefined && !context.personRead) {
      return recordUnderAuditAction(capability, auditAction, context, ok, error);
    }
    const identity = context.identity;
    // An anonymous ordinary change is the audit log's alone; an anonymous
    // irreversible action is also the feed's (see the module TSDoc). The
    // registry reports no anonymous read but the one below.
    if (!identity && capability.tier !== 'destructive') {
      // The person's own read past an area Blocked for agents is the one read
      // reported (DOR-4978): recorded as the request's person, from its proof.
      if (context.personRead) return recordPersonRead(capability, context, ok, readGroup);
      if (capability.tier === 'observe') return;
      // In session, the scope around this observer is the person whose message
      // started the turn, and an in-session call with no identity is still an
      // agent's: name it unidentified, the same as the call ran under.
      // Behind the person bar, a program with a key is named as one, never as
      // the person whose request scope it ran in (DOR-4978).
      const accounts = auditTrail()?.accounts;
      const actor =
        context.mcpServer === 'in-session'
          ? accounts?.unidentified('Unidentified caller')
          : context.personBar?.caller === 'program'
            ? accounts?.system(PROGRAM_ACTOR_LABEL)
            : undefined;
      recordAudit({
        ...(actor ? { actor } : {}),
        action: ok ? 'capability.invoked' : 'capability.failed',
        operation: 'execute',
        target: { type: 'capability', id: capability.id, name: capability.title },
        outcome: ok ? 'ok' : 'failed',
        ...(ok || error === undefined
          ? {}
          : { error: error instanceof Error ? error.message : String(error) }),
        ...(context.approval?.via === 'approval'
          ? { links: { approvalId: context.approval.approvalId } }
          : {}),
        summary: ok ? `Ran ${capability.title}` : `Tried to run ${capability.title} and it failed`,
      });
      return;
    }

    // One naming of an actor, shared with the gate audit and the extension write
    // routes: an agent by its name and path, and an unidentified caller as
    // `system` rather than a nameless agent, because the feed must not imply
    // DorkOS knows who acted when it does not.
    const actor = activityActorForIdentity(identity);
    const label = actor.actorLabel;
    const request = ok ? undefined : requestOutcome(capability, error, label);

    void activityService.emit({
      ...actor,
      category: 'agent',
      eventType: request?.eventType ?? (ok ? 'capability.invoked' : 'capability.failed'),
      resourceType: 'capability',
      resourceId: capability.id,
      resourceLabel: capability.title,
      summary:
        request?.summary ??
        (ok
          ? `${label} ran ${capability.title}`
          : `${label} tried to run ${capability.title} and it failed`),
      metadata: {
        capabilityId: capability.id,
        tier: capability.tier,
        ...request?.metadata,
        // Which of the two proofs of consent allowed the call, never just "there
        // was one". A person deciding this exact action and a setting they made
        // earlier are different facts, and a feed that flattened them could not
        // answer the question an Always allow creates: what ran while nobody was
        // being asked.
        ...(context.approval?.via === 'approval'
          ? { approvalId: context.approval.approvalId }
          : {}),
        // The second proof: the action's permission is set to Allowed, so it ran
        // without a card. The source names the layer a person set it at (spec
        // `agent-permissions` D6).
        ...(context.approval?.via === 'permission'
          ? { permissionSource: context.approval.source }
          : {}),
      },
    });
  };
}
