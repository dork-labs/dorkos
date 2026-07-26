/**
 * Tier enforcement at the capability choke points (spec `agent-trust` §3.2).
 *
 * Every capability declares a permission tier. Until now that tier was inert
 * metadata: it shaped MCP annotation hints and nothing else. This module turns it
 * into a gate.
 *
 * ## Where the gate runs, and why it moved (DOR-467)
 *
 * {@link enforceCapabilityTier} is called from INSIDE `registry.invoke`, so every
 * surface that reaches a capability through the registry is gated by
 * construction. It used to be called by each transport adapter instead, which
 * made a surface gated exactly as long as somebody remembered to gate it. One did
 * not: the legacy marketplace routes performed an uninstall with no tier check,
 * and `dorkos uninstall` — the verb the seeded skill pack taught every agent —
 * rode them. The path agents were taught was the path around the gate.
 *
 * A caller that owns its own effect (that route, still) reaches the same gate
 * through {@link authorizeCapability}, whose importers are pinned by a source
 * scan so a second one cannot appear unnoticed. The only way past the gate is a
 * {@link TrustedCaller}, which no wire payload can mint (`trusted-caller.ts`).
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
 * approvable, refused, with a distinct payload saying so. An unidentified caller
 * is capped too, at {@link DEFAULT_ANONYMOUS_TIER_CEILING} — see "the ceiling is
 * not an escape hatch" below.
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
 * ## The ceiling is not an escape hatch either
 *
 * The first implementation compared a capability's tier against a ceiling ONLY
 * when an identity was present, which quietly rebuilt the same bypass one level
 * up: an agent capped at `act` was refused outright (`tier_ceiling`, not
 * approvable), and the SAME agent after `unset DORKOS_AGENT_TOKEN` got the
 * approvable path instead. Presenting a credential strictly cost privilege.
 *
 * Every caller now has a ceiling. An unidentified one is capped at
 * {@link DEFAULT_ANONYMOUS_TIER_CEILING}, overridable at boot via
 * {@link CapabilityTierGateOptions.anonymousTierCeiling}. The default is
 * `destructive`, so today's behavior is unchanged — but the two paths are now
 * comparable, and lowering the anonymous ceiling can only ever tighten things.
 * Nothing sets a per-agent ceiling below `destructive` yet (`mint()` defaults to
 * unrestricted), which is exactly why the mechanism is fixed now, while nothing
 * depends on it.
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

import { isTrustedCaller } from './trusted-caller.js';
// Type-only, so the value-level dependency stays one-directional: `registry.ts`
// imports the gate, never the reverse.
import type { CapabilityInvocationContext, CapabilityRegistry } from './registry.js';
import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import {
  hashApprovalInput,
  redactSecretsInText,
  renderRequesterLabel,
  summaryFields,
  type ApprovalConsumeResult,
  type ApprovalService,
  type ApprovalTicket,
} from '../approvals/index.js';
import { logger } from '../../../lib/logger.js';

/** Where a retry carries its approval token, per surface. */
export type ApprovalRetryChannel = 'mcp-argument' | 'http-header';

/**
 * The thing whose tier is being enforced, reduced to the FOUR fields this gate
 * actually reads.
 *
 * A `CapabilityDefinition` satisfies this structurally, so the registry path is
 * unchanged. The reason it is stated separately is DOR-468: the 47
 * hand-registered MCP tools are not registry capabilities and never will be until
 * their domains migrate, but they need the same gate. Rather than build a second
 * enforcement path beside this one, each of those tools presents itself here as a
 * `GatedAction` — see `services/core/mcp-tool-tiers.ts` for the table that supplies
 * one, and `services/core/mcp-tool-gate.ts` for the choke point that calls this.
 *
 * This is the SMALLEST shape that works, and it is deliberately not a synthetic
 * `CapabilityDefinition`: a hand-registered tool has no Zod `input` object, no
 * `output`, no `surfaces`, and no registry `invoke`, so faking those would be four
 * lies to satisfy a type. What the gate needs is an identity to bind an approval
 * to, a title a person can read, a tier to decide on, and the fields the card may
 * show. That is all this asks for.
 */
export interface GatedAction {
  /**
   * Stable identifier the approval binds to. A capability's `domain.verb` id, or
   * a hand-registered MCP tool's name (which has no dot, so the two id spaces
   * cannot collide).
   */
  id: string;
  /** Human-facing title, as the operator's approval card shows it. */
  title: string;
  /** Permission tier. This, and nothing about the caller, decides whether to gate. */
  tier: CapabilityTier;
  /** The input fields the approval card may show. Required on `destructive`. */
  approvalDisplayFields?: readonly string[];
}

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
 * - `tier_ceiling` — the caller's ceiling forbids this tier. No approval can
 *   unlock it; only changing that ceiling can.
 * - `operator_denied` — a person said no to this exact action.
 * - `enforcement_unavailable` — the gate was never wired to an approval service,
 *   so there is nobody to ask. Refused rather than allowed (see the module TSDoc).
 * - `input_not_bindable` — the input cannot be canonicalized without losing
 *   information, so no approval could honestly cover it. Refused, because an
 *   approval bound to a hash that ignores part of the action is worse than none.
 */
export type TierDeniedReason =
  | 'tier_ceiling'
  | 'operator_denied'
  | 'enforcement_unavailable'
  | 'input_not_bindable';

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
  /** The capability or hand-registered MCP tool the caller tried to run. */
  action: GatedAction;
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
  /** The capability or hand-registered MCP tool about to be invoked. */
  action: GatedAction;
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
  /**
   * The ceiling applied to a caller that presented no identity. Defaults to
   * {@link DEFAULT_ANONYMOUS_TIER_CEILING} (`destructive`, i.e. no extra
   * restriction), so wiring this is how an operator makes anonymous callers
   * strictly LESS privileged than named ones. It can only ever tighten: an
   * anonymous destructive call still needs an approval at `destructive`.
   */
  anonymousTierCeiling?: CapabilityTier;
}

/**
 * The ceiling an unidentified caller is capped at when boot does not say
 * otherwise.
 *
 * `destructive` means "no extra restriction", which keeps today's behavior
 * byte-identical — the point of naming it is that anonymous and identified
 * callers now travel the SAME comparison, so dropping a credential can never
 * widen what a caller may reach.
 */
export const DEFAULT_ANONYMOUS_TIER_CEILING: CapabilityTier = 'destructive';

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
 * The plain sentence a person reads on the approval card.
 *
 * Says who asked, what they want to run (the registry's title, never the
 * requester's own words), and the arguments that decide what it does.
 *
 * ## The requester cannot forge this sentence
 *
 * Everything caller-controlled — argument values AND the agent's own display name
 * — is rendered through `services/core/approvals/approval-summary.ts`, which
 * quotes strings, caps each value, and strips anything token-shaped. Review
 * reproduced the attack this closes: `{ name: 'pkg, purge: no', purge: true }` used
 * to render a fake `purge: no` before the real `purge: yes`, and padding the
 * injected value pushed the true one out of the card's clamp. Read that module
 * before changing the rendering.
 *
 * Which fields appear is the action's own declaration (`approvalDisplayFields`),
 * so a field like `confirmationToken` never reaches a card, an event, or the
 * agent-readable pending list.
 *
 * An unidentified caller is named as such rather than dressed up as an agent: a
 * person deciding an irreversible action should be able to see that DorkOS does
 * not know who asked.
 *
 * @param action - The capability or tool being requested.
 * @param input - The parsed input the approval is bound to.
 * @param identity - The agent asking, when it identified itself.
 * @returns The card summary.
 */
export function describeGatedAttempt(
  action: GatedAction,
  input: unknown,
  identity?: AgentIdentity
): string {
  const who = identity
    ? `${JSON.stringify(renderRequesterLabel(identity.displayName || identity.agentPath))} `
    : 'An unidentified caller ';
  const fields = summaryFields(input, action.approvalDisplayFields);
  const detail = fields.length
    ? ` with ${fields.map(({ field, value }) => `${field}: ${value}`).join(', ')}`
    : '';
  // The title is declared in DorkOS's own source, never by the caller, so it needs
  // no escaping — but the whole sentence gets the secret sweep anyway, because
  // this string is broadcast.
  return redactSecretsInText(`${who}wants to run "${action.title}"${detail}`);
}

/** The label an approval records for who asked, or its absence for an anonymous one. */
function requesterLabel(identity?: AgentIdentity): string | undefined {
  if (!identity) return undefined;
  return renderRequesterLabel(identity.displayName || identity.agentPath);
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

/** Build the refusal payload for an action the caller may never reach. */
function denied(
  action: GatedAction,
  reason: TierDeniedReason,
  message: string,
  extra: { approvable: boolean; approvalId?: string }
): TierDeniedPayload {
  return {
    status: 'denied',
    capabilityId: action.id,
    capabilityTitle: action.title,
    tier: action.tier,
    reason,
    approvable: extra.approvable,
    message,
    ...(extra.approvalId ? { approvalId: extra.approvalId } : {}),
  };
}

/**
 * Enforce an action's permission tier for one invocation.
 *
 * Three callers, and only three, all pinned by `__tests__/gate-bypass-scan.test.ts`:
 * `registry.invoke` (every registry capability), {@link authorizeCapability} (a
 * caller that owns its own effect), and `services/core/mcp-tool-gate.ts` (the 47
 * hand-registered MCP tools, which are not registry capabilities). Each passes the
 * input that will actually execute. Proceed only on `allowed`; otherwise return
 * the decision's payload to the caller verbatim.
 *
 * @param request - The action, the parsed input, the calling identity, and
 *   any approval token presented.
 * @returns What the gate decided.
 */
export function enforceCapabilityTier(request: TierEnforcementRequest): TierEnforcementDecision {
  const { action, identity, approvalToken, input, retryChannel } = request;

  // The TIER decides whether to gate — never whether the caller identified
  // itself. Anything else is a bypass an agent with shell access can reach by
  // dropping its own token (see the module TSDoc).
  const tier = action.tier;

  /** Attribution for the audit trail, omitted rather than nulled when anonymous. */
  const attributed = identity ? { identity } : {};

  // Reading is free, and a ceiling never blocks reading.
  if (tier === 'observe') return { outcome: 'allowed' };

  // EVERY caller has a ceiling. An unidentified one gets the anonymous default,
  // so dropping a credential cannot move a caller onto a more permissive path
  // (see "the ceiling is not an escape hatch either" in the module TSDoc).
  const ceiling =
    identity?.tierCeiling ?? gate?.anonymousTierCeiling ?? DEFAULT_ANONYMOUS_TIER_CEILING;
  if (TIER_RANK[tier] > TIER_RANK[ceiling]) {
    const limitedParty = identity
      ? 'this agent is limited to'
      : 'callers that do not identify themselves are limited to';
    const changeWhat = identity
      ? "the agent's own limit has to change first"
      : "DorkOS's limit for unidentified callers has to change first";
    const payload = denied(
      action,
      'tier_ceiling',
      `"${action.title}" ${TIER_PHRASE[tier]}, and ${limitedParty} ` +
        `${CEILING_PHRASE[ceiling]}. Nobody can approve this; ${changeWhat}.`,
      { approvable: false }
    );
    audit({ action, ...attributed, decision: { outcome: 'denied', payload } });
    return { outcome: 'denied', payload };
  }

  // `act` is allowed and audited — by the attribution observer on invoke, so
  // exactly one Activity record describes the call.
  if (tier === 'act') return { outcome: 'allowed' };

  if (!gate) {
    const payload = denied(
      action,
      'enforcement_unavailable',
      `"${action.title}" cannot be undone and DorkOS cannot ask anyone to approve it right now, so it was refused.`,
      { approvable: false }
    );
    audit({ action, ...attributed, decision: { outcome: 'denied', payload } });
    return { outcome: 'denied', payload };
  }

  /**
   * Refuse a destructive call the gate cannot honestly process, and audit the
   * refusal. Used for both an unbindable input and a failing approval store.
   */
  const refuse = (reason: TierDeniedReason, message: string): TierEnforcementDecision => {
    const payload = denied(action, reason, message, { approvable: false });
    audit({ action, ...attributed, decision: { outcome: 'denied', payload } });
    return { outcome: 'denied', payload };
  };

  // An input that cannot be canonicalized without losing information cannot be
  // bound, and an approval whose hash ignores part of the action is worse than no
  // approval at all — so refuse instead of asking about something inexact.
  let binding: { capabilityId: string; inputHash: string };
  try {
    binding = { capabilityId: action.id, inputHash: hashApprovalInput(input) };
  } catch (err) {
    logger.error('[capabilities] destructive input could not be bound to an approval', {
      capabilityId: action.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return refuse(
      'input_not_bindable',
      `"${action.title}" cannot be undone, and DorkOS cannot describe this exact call well enough ` +
        `to ask anyone about it, so it was refused.`
    );
  }

  const requestedBy = requesterLabel(identity);

  /**
   * Audit a destructive attempt the approval store itself could not process.
   *
   * The throw propagates (the caller's surface turns it into a 500 and the
   * action does not run), but the attempt must not vanish: "the database was
   * down while an agent reached for something irreversible" is exactly the line an
   * operator needs, and it used to be lost because the throw jumped past `audit`.
   */
  const auditStoreFailure = (): void => {
    const payload = denied(
      action,
      'enforcement_unavailable',
      `"${action.title}" cannot be undone and DorkOS could not record an approval request for it, so it was refused.`,
      { approvable: false }
    );
    audit({ action, ...attributed, decision: { outcome: 'denied', payload } });
  };

  /** Record a fresh request for THIS action and tell the caller how to retry. */
  const ask = (reason: ApprovalRequiredReason): TierEnforcementDecision => {
    let ticket: ApprovalTicket;
    try {
      ticket = gate!.approvals.request({
        ...binding,
        summary: describeGatedAttempt(action, input, identity),
        ...(requestedBy ? { requestedBy } : {}),
      });
    } catch (err) {
      auditStoreFailure();
      throw err;
    }
    const payload: ApprovalRequiredPayload = {
      status: 'approval_required',
      capabilityId: action.id,
      capabilityTitle: action.title,
      tier,
      approvalId: ticket.approvalId,
      approvalToken: ticket.token,
      expiresAt: ticket.expiresAt,
      reason,
      message: approvalMessage(reason, action.title),
      retry: retryGuidance(retryChannel),
    };
    audit({ action, ...attributed, decision: { outcome: 'approval_required', payload } });
    return { outcome: 'approval_required', payload };
  };

  if (!approvalToken) return ask('no_approval');

  let result: ApprovalConsumeResult;
  try {
    result = gate.approvals.consume(approvalToken, binding);
  } catch (err) {
    auditStoreFailure();
    throw err;
  }
  switch (result.outcome) {
    case 'granted':
      return { outcome: 'allowed', approval: { approvalId: result.approvalId } };

    case 'pending': {
      // Still undecided: echo the SAME approval back rather than stacking a
      // second card on the operator for one action.
      const payload: ApprovalRequiredPayload = {
        status: 'approval_required',
        capabilityId: action.id,
        capabilityTitle: action.title,
        tier,
        approvalId: result.approvalId,
        approvalToken,
        expiresAt: result.expiresAt,
        reason: 'awaiting_decision',
        message: approvalMessage('awaiting_decision', action.title),
        retry: retryGuidance(retryChannel),
      };
      audit({ action, ...attributed, decision: { outcome: 'approval_required', payload } });
      return { outcome: 'approval_required', payload };
    }

    case 'denied': {
      const payload = denied(
        action,
        'operator_denied',
        result.reason
          ? `A person refused this: ${result.reason}`
          : `A person refused this. Do not try again unless they ask for it.`,
        { approvable: true, approvalId: result.approvalId }
      );
      audit({ action, ...attributed, decision: { outcome: 'denied', payload } });
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
 * The gate said no. Thrown by `registry.invoke` so a refusal cannot be mistaken
 * for a result, and caught by each surface to shape its own envelope.
 *
 * An exception rather than a union return value on purpose: `invoke` resolves to
 * a capability's plain output, and a surface that forgot to branch on a union
 * would hand a caller an `approval_required` payload dressed as the thing it
 * asked for. A throw is impossible to ignore by accident.
 */
export class CapabilityGateRefusal extends Error {
  /** Marks this class across module instances, so it can be duck-typed. */
  override readonly name = 'CapabilityGateRefusal';

  /**
   * Construct the refusal.
   *
   * @param decision - What the gate decided; carries the payload to return to
   *   the caller verbatim.
   */
  constructor(
    readonly decision: Extract<TierEnforcementDecision, { outcome: 'approval_required' | 'denied' }>
  ) {
    super(decision.payload.message);
  }
}

/**
 * Run the tier gate for a capability a caller is about to perform ITSELF.
 *
 * This is the one supported way to reach the gate without going through
 * `registry.invoke`, and it exists for exactly one shape of caller: a route that
 * already owns the effect and its own response contract, where re-routing it
 * through the capability handler would change what the cockpit receives. The
 * legacy marketplace mutation routes are that caller.
 *
 * Every OTHER surface must use `registry.invoke`, which calls the same gate
 * internally. Importing this function is therefore a deliberate, reviewable act:
 * `__tests__/gate-bypass-scan.test.ts` fails when a module that is not on its
 * short allowlist starts calling it, so a new ungated agent-facing surface cannot
 * appear quietly — which is precisely how DOR-467 happened.
 *
 * The input is parsed against the capability's own schema before gating, so the
 * approval binds to the same canonical value `dorkos call` would produce for the
 * same action, and a token minted on one surface is honored on the other.
 *
 * @param registry - The composed capability registry.
 * @param id - The capability id the caller is about to perform.
 * @param input - Raw input; parsed against the capability's `input` schema.
 * @param context - Who is calling, any approval token, and any trusted marker.
 * @returns What the gate decided. Proceed only on `allowed`.
 * @throws If no capability is registered under `id`, or if `input` fails schema
 *   validation (a `ZodError`).
 */
export function authorizeCapability(
  registry: CapabilityRegistry,
  id: string,
  input: unknown,
  context: CapabilityInvocationContext
): TierEnforcementDecision {
  const capability = registry.get(id);
  if (!capability) {
    throw new Error(`Capability registry: no capability registered for id "${id}".`);
  }
  // The same contradiction `registry.invoke` refuses, refused in this seam too.
  // Unreachable today — this function's only caller cannot produce the pair — but
  // an invariant that holds in one of two entry points is not an invariant, and
  // the next caller of this seam should inherit it rather than rediscover it.
  if (context.trusted !== undefined && context.identity !== undefined) {
    throw new Error(
      `Capability gate: "${id}" was authorized with both a trusted-caller marker and an agent ` +
        `identity (${context.identity.agentPath}). A trusted call is one no machine principal ` +
        `made; these cannot both hold.`
    );
  }
  // A trusted caller has already proved it may decide the approval this gate
  // would ask for, so asking is redundant — see `trusted-caller.ts`. Checked by
  // `instanceof`, never truthiness: a JSON round-trip of a real marker is a
  // truthy plain object, and treating that as trust is the whole bypass.
  if (context.trusted !== undefined) {
    if (!isTrustedCaller(context.trusted)) {
      throw new Error(
        `Capability gate: "${id}" was authorized with a \`trusted\` value that is not a ` +
          `trusted-caller marker. Only \`trustedCaller\` can mint one.`
      );
    }
    return { outcome: 'allowed' };
  }
  return enforceCapabilityTier({
    action: capability,
    input: capability.input.parse(input),
    ...(context.identity ? { identity: context.identity } : {}),
    ...(context.approvalToken ? { approvalToken: context.approvalToken } : {}),
    retryChannel: context.retryChannel ?? 'http-header',
  });
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
