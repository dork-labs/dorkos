/**
 * Tier enforcement at the capability choke points (spec `agent-trust` §3.2).
 *
 * Every capability declares a permission tier. Until now that tier was inert
 * metadata: it shaped MCP annotation hints and nothing else. This module turns it
 * into a gate. {@link enforceCapabilityTier} is called by all three agent-facing
 * choke points — the invoke route, the in-session MCP adapter, the external MCP
 * adapter — BEFORE `registry.invoke`, so nothing runs before the tier is honored.
 *
 * ## What each tier means once enforced
 *
 * - `observe` — passes. Reading is free.
 * - `act` — passes, and the invocation is recorded in the Activity feed by the
 *   attribution observer at the registry's choke point. Nothing extra is emitted
 *   here, so an allowed call produces exactly one audit record, not two.
 * - `destructive` — requires an approval a person granted, bound to this exact
 *   capability AND this exact input. Without one the call does not run: the caller
 *   gets a structured {@link ApprovalRequiredPayload} carrying a fresh pending
 *   approval and instructions for retrying.
 *
 * An identity's `tierCeiling` caps all of it. A ceiling of `act` makes every
 * destructive capability permanently unreachable for that agent — not
 * approvable, refused, with a distinct payload saying so.
 *
 * ## The TIER decides whether to gate. Identity only supplies the ceiling.
 *
 * A caller that presents no {@link AgentIdentity} is still gated. This is the
 * load-bearing asymmetry in the whole module, so it is worth stating why:
 *
 * The adversary this feature exists to stop is a prompt-injected or misaligned
 * agent that has shell access. Keying the gate on identity PRESENCE would hand
 * that agent a bypass needing strictly less capability than the honest path —
 * `env -u DORKOS_AGENT_TOKEN dorkos call marketplace.uninstall …`, or a bare
 * `curl`, since the CLI only attaches `X-DorkOS-Agent` when the token is in its
 * env and `sessionGate` is a pass-through in the default local posture. The
 * destructive operation would run, unapproved and unattributed.
 *
 * Spec §3.1's "absent identity = today's behavior" resolution is about
 * ATTRIBUTION, and its stated rationale was not breaking external MCP clients or
 * human CLI use. Those are `observe` and `act` calls, which this module lets
 * straight through. Only `destructive` stops — and spec §Security is explicit
 * that a modified client or skill must not be able to bypass enforcement.
 *
 * So identity, when present, does exactly two things: it narrows what the caller
 * may reach (`tierCeiling`) and it names them on the approval card. Its absence
 * costs the caller nothing except a name — the approval is still required, and
 * the card says an unidentified caller asked.
 *
 * ## Fail closed
 *
 * The gate is initialized once at boot with the approval service
 * ({@link initCapabilityTierGate}). If it was never initialized, an identified
 * agent's destructive call is REFUSED rather than allowed: with no approval
 * service there is nobody to ask, and silently running the operation would turn a
 * wiring mistake into an unreviewed destructive action.
 *
 * @module services/core/capabilities/tier-enforcement
 */
import type { CapabilityTier } from '@dorkos/shared/capabilities';

import type { CapabilityDefinition } from './capability-definition.js';
import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import { hashApprovalInput, type ApprovalService } from '../approvals/index.js';

/** Where a retry carries its approval token, per surface. */
export type ApprovalRetryChannel = 'mcp-argument' | 'http-header';

/** The MCP tool argument a retry passes its approval token in. */
export const APPROVAL_TOKEN_ARGUMENT = 'approvalToken';

/** The HTTP header a retry passes its approval token in. */
export const APPROVAL_TOKEN_HEADER = 'x-dorkos-approval';

/**
 * Why a destructive call is not running yet.
 *
 * - `no_approval` — nothing was presented; a request has just been recorded.
 * - `awaiting_decision` — the presented token is real, but nobody has decided.
 * - `expired` — the decision window closed before the token was spent.
 * - `already_used` — the token was already spent; approvals work once.
 * - `wrong_action` — a live token for a DIFFERENT action was presented. The
 *   original approval is left untouched, and a request for THIS action is made.
 * - `unknown_token` — no approval matches the presented token.
 */
export type ApprovalRequiredReason =
  | 'no_approval'
  | 'awaiting_decision'
  | 'expired'
  | 'already_used'
  | 'wrong_action'
  | 'unknown_token';

/**
 * The result a gated caller receives instead of the capability's output.
 *
 * Deliberately the same shape family as the marketplace's long-standing
 * `requires_confirmation` payload (`services/marketplace-mcp/tool-install.ts`) —
 * a `status` discriminator, a token to retry with, and a `message` written for the
 * model — so an agent that already knows that dance needs no new instructions.
 * Everything a model needs to proceed is in the payload: what is gated, the id a
 * person will decide, and exactly how to retry.
 */
export interface ApprovalRequiredPayload {
  /** Discriminator. Always `approval_required`. */
  status: 'approval_required';
  /** The capability that did NOT run. */
  capabilityId: string;
  /** Its human-facing title, as the operator's card shows it. */
  capabilityTitle: string;
  /** Its permission tier, from the registry — never from the requester. */
  tier: CapabilityTier;
  /** The approval a person will decide. Safe to show or log. */
  approvalId: string;
  /** The one-time token to present on the retry. Inert until someone grants it. */
  approvalToken: string;
  /** When the token stops being honored. ISO 8601 UTC. */
  expiresAt: string;
  /** Why the call is not running yet. */
  reason: ApprovalRequiredReason;
  /** One plain sentence a model (or a person reading a log) can act on. */
  message: string;
  /** Exactly how to retry once a person has approved. */
  retry: {
    /** Whether the token rides an MCP tool argument or an HTTP header. */
    channel: ApprovalRetryChannel;
    /** The exact argument or header name to put the token in. */
    field: string;
    /** Step-by-step retry instructions, written for the model. */
    instructions: string;
  };
}

/**
 * Why a call was refused outright rather than queued for approval.
 *
 * - `tier_ceiling` — the agent's own ceiling forbids this tier. No approval can
 *   unlock it; only changing the agent's ceiling can.
 * - `operator_denied` — a person said no to this exact action.
 * - `enforcement_unavailable` — the gate was never wired to an approval service,
 *   so there is nobody to ask. Refused rather than allowed (see the module TSDoc).
 */
export type TierDeniedReason = 'tier_ceiling' | 'operator_denied' | 'enforcement_unavailable';

/** The result a refused caller receives instead of the capability's output. */
export interface TierDeniedPayload {
  /** Discriminator. Always `denied`. */
  status: 'denied';
  /** The capability that did NOT run. */
  capabilityId: string;
  /** Its human-facing title. */
  capabilityTitle: string;
  /** Its permission tier, from the registry. */
  tier: CapabilityTier;
  /** Why it was refused. */
  reason: TierDeniedReason;
  /**
   * Whether asking a person could ever change this answer. `false` for a ceiling
   * refusal, so an agent does not loop on a request that can never be granted.
   */
  approvable: boolean;
  /** One plain sentence a model can act on. */
  message: string;
  /** The approval a person denied, when that is why this was refused. */
  approvalId?: string;
}

/**
 * A granted approval, threaded onto the invocation context so a capability whose
 * handler runs its own confirmation flow can see that a person already said yes
 * to this exact call and not ask twice.
 */
export interface GrantedApproval {
  /** The approval that was spent to allow this invocation. */
  approvalId: string;
}

/**
 * What the gate decided, discriminated by `outcome`.
 *
 * `allowed` is the only outcome a choke point may proceed on. The other two carry
 * the payload to return to the caller verbatim.
 */
export type TierEnforcementDecision =
  | { outcome: 'allowed'; approval?: GrantedApproval }
  | { outcome: 'approval_required'; payload: ApprovalRequiredPayload }
  | { outcome: 'denied'; payload: TierDeniedPayload };

/** One gated attempt, for the audit trail. */
export interface TierEnforcementAttempt {
  /** The capability the caller tried to run. */
  capability: CapabilityDefinition;
  /**
   * The agent that tried, when it identified itself. Absent for an unidentified
   * caller — which is still audited, because an anonymous attempt at something
   * irreversible is exactly the event an operator most wants a record of.
   */
  identity?: AgentIdentity;
  /** What the gate decided — never `allowed` (allowed calls are audited on invoke). */
  decision: Extract<TierEnforcementDecision, { outcome: 'approval_required' | 'denied' }>;
}

/** Everything the gate needs to decide one invocation. */
export interface TierEnforcementRequest {
  /** The capability about to be invoked. */
  capability: CapabilityDefinition;
  /**
   * The PARSED input that will execute — not the raw request body.
   *
   * The approval binds to a hash of this value, so hashing anything other than
   * what actually runs would make the binding meaningless.
   */
  input: unknown;
  /** The calling agent, when the surface resolved one. */
  identity?: AgentIdentity;
  /** The approval token the caller presented, when it presented one. */
  approvalToken?: string;
  /** Which channel a retry should carry its token on, for the instructions. */
  retryChannel: ApprovalRetryChannel;
}

/** What {@link initCapabilityTierGate} wires the gate to at boot. */
export interface CapabilityTierGateOptions {
  /** The approval primitive destructive calls are gated on. */
  approvals: ApprovalService;
  /**
   * Called for every attempt the gate did NOT allow, so refused and pending
   * attempts are audited, not just successful invocations. Must never throw; the
   * gate swallows anything it does.
   */
  onAttempt?: (attempt: TierEnforcementAttempt) => void;
}

/** Boot-wired gate state. See the module TSDoc on failing closed. */
let gate: CapabilityTierGateOptions | undefined;

/**
 * Wire tier enforcement to the approval primitive. Called once at boot, before
 * any router or MCP server is mounted.
 *
 * The approval service itself stays injected (there is deliberately no singleton
 * in `services/core/approvals`); this seam exists because the two MCP adapters are
 * built deep inside per-request and per-session factories that carry no path for
 * one more service handle.
 *
 * @param options - The approval service and the audit hook.
 */
export function initCapabilityTierGate(options: CapabilityTierGateOptions): void {
  gate = options;
}

/**
 * Drop the wired gate. Test-only seam, mirroring `resetAgentIdentityService`.
 */
export function resetCapabilityTierGate(): void {
  gate = undefined;
}

/** Tier ordering, so a ceiling can be compared against a capability's tier. */
const TIER_RANK: Record<CapabilityTier, number> = { observe: 0, act: 1, destructive: 2 };

/** How a capability's own tier reads in a message written for a model or a person. */
const TIER_PHRASE: Record<CapabilityTier, string> = {
  observe: 'only reads',
  act: 'changes things',
  destructive: 'cannot be undone',
};

/** How a tier reads as a LIMIT on an agent, which is a different sentence. */
const CEILING_PHRASE: Record<CapabilityTier, string> = {
  observe: 'reading only',
  act: 'changes that can be undone',
  destructive: 'anything',
};

/**
 * Render one input value for the operator's card: short, plain, and never a raw
 * JSON blob for a nested structure nobody can read at a glance.
 */
function renderValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (value === null || value === undefined) return 'not set';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  return 'details';
}

/**
 * The plain sentence a person reads on the approval card.
 *
 * Says who asked, what they want to run (the registry's title, never the
 * requester's own words), and the top-level arguments that decide what it does.
 * Truncation is the approval service's job, so this stays readable rather than
 * arithmetic.
 *
 * An unidentified caller is named as such rather than dressed up as an agent: a
 * person deciding an irreversible action should be able to see that DorkOS does
 * not know who asked.
 *
 * @param capability - The capability being requested.
 * @param input - The parsed input the approval is bound to.
 * @param identity - The agent asking, when it identified itself.
 * @returns The card summary.
 */
export function describeGatedAttempt(
  capability: CapabilityDefinition,
  input: unknown,
  identity?: AgentIdentity
): string {
  const who = identity ? identity.displayName || identity.agentPath : 'An unidentified caller';
  const args =
    input && typeof input === 'object' && !Array.isArray(input)
      ? Object.entries(input as Record<string, unknown>)
          .map(([key, value]) => `${key}: ${renderValue(value)}`)
          .join(', ')
      : '';
  const detail = args ? ` with ${args}` : '';
  return `${who} wants to run "${capability.title}"${detail}`;
}

/** The label an approval records for who asked, or its absence for an anonymous one. */
function requesterLabel(identity?: AgentIdentity): string | undefined {
  if (!identity) return undefined;
  return identity.displayName || identity.agentPath;
}

/** Retry instructions for the surface the call arrived on. */
function retryGuidance(channel: ApprovalRetryChannel): ApprovalRequiredPayload['retry'] {
  if (channel === 'mcp-argument') {
    return {
      channel,
      field: APPROVAL_TOKEN_ARGUMENT,
      instructions:
        `Ask the person to approve this in DorkOS (an approval card is waiting for them), then call this tool ` +
        `again with exactly the same arguments plus "${APPROVAL_TOKEN_ARGUMENT}" set to the approvalToken above. ` +
        `Changing any argument invalidates the approval, because an approval covers one exact action.`,
    };
  }
  return {
    channel,
    field: APPROVAL_TOKEN_HEADER,
    instructions:
      `Ask the person to approve this in DorkOS (an approval card is waiting for them), then send exactly the ` +
      `same request again with the "${APPROVAL_TOKEN_HEADER}" header set to the approvalToken above ` +
      `(with the CLI: dorkos call <id> --approval <token>). Changing the input invalidates the approval, ` +
      `because an approval covers one exact action.`,
  };
}

/** The plain sentence explaining why a destructive call is waiting. */
function approvalMessage(reason: ApprovalRequiredReason, title: string): string {
  switch (reason) {
    case 'no_approval':
      return `"${title}" cannot be undone, so a person has to approve it first. DorkOS has asked them.`;
    case 'awaiting_decision':
      return `"${title}" is still waiting on a person. Present the same token again once they have answered.`;
    case 'expired':
      return `That approval ran out of time before it was used. DorkOS has asked again.`;
    case 'already_used':
      return `That approval was already used. Approvals work once, so DorkOS has asked again.`;
    case 'wrong_action':
      return `That approval was granted for a different action, so it cannot be used here. DorkOS has asked for this one.`;
    case 'unknown_token':
      return `DorkOS does not recognize that approval token. It has asked for a new approval.`;
  }
}

/** Report a gated attempt to the audit hook without ever failing the call. */
function audit(attempt: TierEnforcementAttempt): void {
  try {
    gate?.onAttempt?.(attempt);
  } catch {
    // An audit failure must not change what the caller is told.
  }
}

/** Build the refusal payload for a capability the caller may never reach. */
function denied(
  capability: CapabilityDefinition,
  reason: TierDeniedReason,
  message: string,
  extra: { approvable: boolean; approvalId?: string }
): TierDeniedPayload {
  return {
    status: 'denied',
    capabilityId: capability.id,
    capabilityTitle: capability.title,
    tier: capability.tier,
    reason,
    approvable: extra.approvable,
    message,
    ...(extra.approvalId ? { approvalId: extra.approvalId } : {}),
  };
}

/**
 * Enforce a capability's permission tier for one invocation.
 *
 * Call this at a choke point BEFORE `registry.invoke`, with the input that will
 * actually execute. Proceed only on `allowed`; otherwise return the decision's
 * payload to the caller verbatim.
 *
 * @param request - The capability, the parsed input, the calling identity, and
 *   any approval token presented.
 * @returns What the gate decided.
 */
export function enforceCapabilityTier(request: TierEnforcementRequest): TierEnforcementDecision {
  const { capability, identity, approvalToken, input, retryChannel } = request;

  // The TIER decides whether to gate — never whether the caller identified
  // itself. Anything else is a bypass an agent with shell access can reach by
  // dropping its own token (see the module TSDoc).
  const tier = capability.tier;

  /** Attribution for the audit trail, omitted rather than nulled when anonymous. */
  const attributed = identity ? { identity } : {};

  // Reading is free, and a ceiling never blocks reading.
  if (tier === 'observe') return { outcome: 'allowed' };

  // A ceiling only exists for a caller that identified itself. An anonymous
  // caller has no ceiling to cap — it simply has no name, and the destructive
  // gate below applies to it all the same.
  if (identity && TIER_RANK[tier] > TIER_RANK[identity.tierCeiling]) {
    const payload = denied(
      capability,
      'tier_ceiling',
      `"${capability.title}" ${TIER_PHRASE[tier]}, and this agent is limited to ` +
        `${CEILING_PHRASE[identity.tierCeiling]}. Nobody can approve this; the agent's own limit has to change first.`,
      { approvable: false }
    );
    audit({ capability, ...attributed, decision: { outcome: 'denied', payload } });
    return { outcome: 'denied', payload };
  }

  // `act` is allowed and audited — by the attribution observer on invoke, so
  // exactly one Activity record describes the call.
  if (tier === 'act') return { outcome: 'allowed' };

  if (!gate) {
    const payload = denied(
      capability,
      'enforcement_unavailable',
      `"${capability.title}" cannot be undone and DorkOS cannot ask anyone to approve it right now, so it was refused.`,
      { approvable: false }
    );
    audit({ capability, ...attributed, decision: { outcome: 'denied', payload } });
    return { outcome: 'denied', payload };
  }

  const binding = { capabilityId: capability.id, inputHash: hashApprovalInput(input) };
  const requestedBy = requesterLabel(identity);

  /** Record a fresh request for THIS action and tell the caller how to retry. */
  const ask = (reason: ApprovalRequiredReason): TierEnforcementDecision => {
    const ticket = gate!.approvals.request({
      ...binding,
      summary: describeGatedAttempt(capability, input, identity),
      ...(requestedBy ? { requestedBy } : {}),
    });
    const payload: ApprovalRequiredPayload = {
      status: 'approval_required',
      capabilityId: capability.id,
      capabilityTitle: capability.title,
      tier,
      approvalId: ticket.approvalId,
      approvalToken: ticket.token,
      expiresAt: ticket.expiresAt,
      reason,
      message: approvalMessage(reason, capability.title),
      retry: retryGuidance(retryChannel),
    };
    audit({ capability, ...attributed, decision: { outcome: 'approval_required', payload } });
    return { outcome: 'approval_required', payload };
  };

  if (!approvalToken) return ask('no_approval');

  const result = gate.approvals.consume(approvalToken, binding);
  switch (result.outcome) {
    case 'granted':
      return { outcome: 'allowed', approval: { approvalId: result.approvalId } };

    case 'pending': {
      // Still undecided: echo the SAME approval back rather than stacking a
      // second card on the operator for one action.
      const payload: ApprovalRequiredPayload = {
        status: 'approval_required',
        capabilityId: capability.id,
        capabilityTitle: capability.title,
        tier,
        approvalId: result.approvalId,
        approvalToken,
        expiresAt: result.expiresAt,
        reason: 'awaiting_decision',
        message: approvalMessage('awaiting_decision', capability.title),
        retry: retryGuidance(retryChannel),
      };
      audit({ capability, ...attributed, decision: { outcome: 'approval_required', payload } });
      return { outcome: 'approval_required', payload };
    }

    case 'denied': {
      const payload = denied(
        capability,
        'operator_denied',
        result.reason
          ? `A person refused this: ${result.reason}`
          : `A person refused this. Do not try again unless they ask for it.`,
        { approvable: true, approvalId: result.approvalId }
      );
      audit({ capability, ...attributed, decision: { outcome: 'denied', payload } });
      return { outcome: 'denied', payload };
    }

    case 'expired':
      return ask('expired');
    case 'consumed':
      return ask('already_used');
    case 'mismatched':
      return ask('wrong_action');
    case 'unknown':
      return ask('unknown_token');
  }
}

/**
 * Split a presented approval token out of a surface's raw arguments.
 *
 * The token travels alongside a capability's input, never inside it: the approval
 * binds to a hash of the input, so a token carried as an input field would change
 * the very hash it is being checked against. Destructive capabilities advertise
 * {@link APPROVAL_TOKEN_ARGUMENT} as an extra MCP argument, and this is where it
 * comes back off.
 *
 * @param args - Raw arguments from an MCP client.
 * @returns The token (when present) and the arguments with it removed.
 */
export function splitApprovalToken(args: unknown): { approvalToken?: string; input: unknown } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { input: args };
  const { [APPROVAL_TOKEN_ARGUMENT]: token, ...rest } = args as Record<string, unknown>;
  if (typeof token !== 'string' || token.length === 0) return { input: rest };
  return { approvalToken: token, input: rest };
}
