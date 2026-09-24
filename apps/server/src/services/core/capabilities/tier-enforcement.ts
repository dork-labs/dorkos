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
 * `destructive`, so today's behavior is unchanged — but the two paths are
 * comparable, and lowering the anonymous ceiling can only ever tighten things.
 *
 * ## Per-agent ceilings are REAL now, and that changed what `undefined` costs
 *
 * This module was written while nothing set a ceiling below `destructive`, and
 * said so. That is no longer true (DOR-486): `.dork/agent.json` carries a
 * `tierCeiling`, the agent Tools tab and `dorkos agent update --ceiling` write
 * it, and `resolveAgentTokenEnv` stamps it onto every token a spawn mints. Two
 * consequences the old wording let sit as theory:
 *
 * - **A missing identity is no longer harmless.** It reads as
 *   {@link DEFAULT_ANONYMOUS_TIER_CEILING}, the widest rung, so anything that
 *   turned a capped agent into an unidentified one WIDENED it. Revocation did
 *   exactly that. Hence {@link effectiveCeiling} and `AgentIdentity.inactive`:
 *   "known and shut off" and "never identified" are now different answers.
 * - **The escape hatch is the anonymous path itself**, not the ceiling
 *   comparison. Read the residual on {@link DEFAULT_ANONYMOUS_TIER_CEILING}
 *   before describing a ceiling as containment anywhere a user will read it.
 *
 * ## Permissions decide whether a call asks (spec `agent-permissions` D6)
 *
 * An action that declares a permission area is also decided by the permission
 * the caller resolves to, read fresh on every call (`permission-enforcement.ts`):
 * Allowed runs, Ask raises the approval card (for `act` as well as
 * `destructive`), and Blocked refuses. "Always allow" on a card is an
 * action-level Allowed written onto the agent's own settings by the grant route,
 * so the gate needs no second lookup to honor it: the next call simply resolves
 * Allowed.
 *
 * ## Asking past Blocked (spec `agent-permissions` D8)
 *
 * A direct call to a Blocked action is refused and mints nothing: its message
 * names the `request_permission` tool. That tool re-invokes the action with
 * {@link TierEnforcementRequest.blockedRequest} set, and only then does a Blocked
 * permission mint an approval, bound like every other approval to this exact
 * action and this exact input, and rate-limited from the approvals store
 * (`ApprovalService.blockedRequestLimit`) before anything is minted. A granted
 * token is honored for a Blocked action only on that same path, so an agent
 * cannot spend one by calling the hidden action directly.
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
import {
  CAPABILITY_CEILING_PHRASE,
  CAPABILITY_TIER_RANK,
  WIDEST_CAPABILITY_TIER,
  type CapabilityTier,
} from '@dorkos/shared/capabilities';
import type { ApprovalOrigin, ApprovalSubject } from '@dorkos/shared/approval-schemas';
import {
  getPermissionArea,
  type PermissionAreaId,
  type PermissionSource,
} from '@dorkos/shared/permissions';

import { isTrustedCaller } from './trusted-caller.js';
import {
  blockedPermissionMessage,
  resolveCallPermission,
  type CallPermission,
} from './permission-enforcement.js';
// Type-only, so the value-level dependency stays one-directional: `registry.ts`
// imports the gate, never the reverse.
import type { CapabilityInvocationContext, CapabilityRegistry } from './registry.js';
import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import {
  hashApprovalInput,
  readApprovalInputPath,
  redactSecretsInText,
  renderRequesterLabel,
  joinSummaryFields,
  summaryFieldsNamingSubject,
  type ApprovalConsumeResult,
  type ApprovalConnectorAuthority,
  type ApprovalRequestingSession,
  type ApprovalService,
  type ApprovalTicket,
  type BlockedRequestLimit,
  describeRemainingArguments,
  type ApprovalSubjectDeclaration,
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
  /**
   * The permission area the action belongs to, or `null` when its tier alone
   * decides (spec `agent-permissions` D2). Required, so an action cannot reach
   * the gate without somebody having decided it.
   */
  area: PermissionAreaId | null;
  /** The input fields the approval card may show. Required on `destructive`. */
  approvalDisplayFields?: readonly string[];
  /**
   * The one input field whose FULL value the card carries, when the action
   * declares one (DOR-1698). Read here rather than by a surface, so every
   * channel that reaches this gate produces the same card.
   */
  approvalDetailField?: string;
  /**
   * Which argument names the thing being acted on, and which registry knows it
   * by name (DOR-1929).
   *
   * Distinct from {@link approvalDisplayFields}, which answers "show this" — this
   * answers "this one IS the target", and only the second can be looked up. An
   * action declaring it gets a card that names its subject; an action without
   * one renders exactly as it always did.
   *
   * The gate does not resolve it: resolution is async and this function is not.
   * The caller resolves it (`approvals/approval-subject.ts`) and passes the
   * result as {@link TierEnforcementRequest.subject}.
   */
  approvalSubject?: ApprovalSubjectDeclaration;
}

/** The MCP tool argument a retry passes its approval token in. */
export const APPROVAL_TOKEN_ARGUMENT = 'approvalToken';

/** The HTTP header a retry passes its approval token in. */
export const APPROVAL_TOKEN_HEADER = 'x-dorkos-approval';

/**
 * Why a destructive call is not running yet, where the answer is "a BRAND-NEW
 * approval was just minted for it".
 *
 * Every member here is a reason `ask()` is called with, and `ask()` records a
 * fresh request and hands back a fresh token. That is what makes this union the
 * discriminator for the in-session hold (DOR-987): a caller can only wait on a
 * decision it just asked for.
 *
 * - `no_approval` — nothing was presented; a request has just been recorded.
 * - `expired` — the decision window closed before the token was spent.
 * - `already_used` — the token was already spent; approvals work once.
 * - `wrong_action` — a live token for a DIFFERENT action was presented. The
 *   original approval is left untouched, and a request for THIS action is made.
 * - `unknown_token` — no approval matches the presented token.
 */
export type FreshAskReason =
  'no_approval' | 'expired' | 'already_used' | 'wrong_action' | 'unknown_token';

/**
 * Why a destructive call is not running yet.
 *
 * {@link FreshAskReason} plus the one reason that is NOT a fresh ask:
 * `awaiting_decision` — the presented token is real, but nobody has decided, so
 * the SAME approval is echoed back rather than a second card stacked on the
 * operator.
 */
export type ApprovalRequiredReason = FreshAskReason | 'awaiting_decision';

/**
 * The fresh-ask reasons as a lookup, exhaustive by construction: `Record` over
 * the union means adding a member to {@link FreshAskReason} without adding it
 * here is a type error, and adding one that is not in the union is too.
 */
const FRESH_ASK_REASONS: Record<FreshAskReason, true> = {
  no_approval: true,
  expired: true,
  already_used: true,
  wrong_action: true,
  unknown_token: true,
};

/**
 * Whether this refusal carries a FRESH approval — one the gate just minted, that
 * nobody has been shown yet.
 *
 * The in-session hold's discriminator (DOR-987). It used to test
 * `reason === 'no_approval'`, which held only the very first ask and silently
 * dropped the four token-failure paths (`expired`, `already_used`,
 * `wrong_action`, `unknown_token`) — each of which mints a brand-new approval
 * exactly like the first, and each of which therefore produced a dashboard card
 * with no inline card and no hold.
 *
 * @param payload - The gate's `approval_required` payload.
 * @returns True when the payload's approval was just minted for this call.
 */
export function isFreshApprovalAsk(payload: ApprovalRequiredPayload): boolean {
  return Object.hasOwn(FRESH_ASK_REASONS, payload.reason);
}

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
 * - `permission_blocked` — the action's permission area (or the action itself)
 *   resolved to Blocked for this caller (spec `agent-permissions` D3). Not a tier
 *   answer; it shares this union so every surface that already renders a refusal
 *   renders this one too, with no second shape to teach anybody.
 * - `request_pending` — the agent asked past Blocked with `request_permission`
 *   while an earlier request in the same area is still waiting on a person
 *   (spec `agent-permissions` D8). No second card.
 * - `recently_denied` — a person denied this agent this action in the last day.
 * - `request_limit` — the agent made five blocked requests in the last hour.
 */
export type TierDeniedReason =
  | 'tier_ceiling'
  | 'operator_denied'
  | 'enforcement_unavailable'
  | 'input_not_bindable'
  | 'permission_blocked'
  | 'request_pending'
  | 'recently_denied'
  | 'request_limit';

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
 * Proof that a person already said yes to this exact call, threaded onto the
 * invocation context so a capability whose handler runs its own confirmation flow
 * does not ask twice.
 *
 * A discriminated union rather than one shape, because the two answers are not the
 * same event and the audit trail must not pretend they are: one is a person
 * deciding this call, the other is a permission setting a person made earlier and
 * can change at any time. A handler that only needs "somebody said yes" can keep
 * testing for presence and ignore the tag.
 */
export type GrantedApproval =
  /** A person decided THIS call, and the approval was spent to allow it. */
  | { via: 'approval'; approvalId: string; authorityBindingDigest?: string }
  /**
   * The action's permission resolved to Allowed, so it ran without a card. The
   * source says which layer allowed it (spec `agent-permissions` D6).
   */
  | { via: 'permission'; source: PermissionSource };

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

/**
 * A destructive call an action-level Allowed permission allowed without asking
 * anyone.
 *
 * The one `allowed` decision that reaches the audit hook. Every other allowed call
 * is recorded by the registry's attribution observer instead, so reporting them
 * here too would describe one invocation twice — but "DorkOS did not ask you about
 * this" is a fact no other observer knows, and it is the whole answer to "what did
 * my agent do while I was not being asked".
 */
export interface AutoApprovedAttempt {
  /** Discriminator. Always `allowed`. */
  outcome: 'allowed';
  /** What allowed it. */
  approval: Extract<GrantedApproval, { via: 'permission' }>;
}

/** One gated attempt, for the audit trail. */
export interface TierEnforcementAttempt {
  /** The capability or hand-registered MCP tool the caller tried to run. */
  action: GatedAction;
  /**
   * The agent that tried, when it identified itself. Absent for an unidentified
   * caller — which is still audited, because an anonymous attempt at something
   * irreversible is exactly the event an operator most wants a record of.
   *
   * Usually present on an {@link AutoApprovedAttempt}: only an agent's own
   * settings can hold an action-level Allowed on a destructive action, unless a
   * person set one as the default.
   */
  identity?: AgentIdentity;
  /**
   * What the gate decided. Ordinary allowed calls are absent (the attribution
   * observer records those); {@link AutoApprovedAttempt} is the one exception.
   */
  decision:
    | Extract<TierEnforcementDecision, { outcome: 'approval_required' | 'denied' }>
    | AutoApprovedAttempt;
  /**
   * The permission the gate resolved for this call, when the action has an area.
   * Recorded on the audit line so "why was this refused" names the layer.
   */
  permission?: { state: CallPermission['state']; source: PermissionSource };
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
  /**
   * The permission that applies to this call, from {@link resolveCallPermission},
   * or `null` when the action has no area and its tier alone decides.
   *
   * REQUIRED, so each of the three callers resolves it (fresh, per call) before
   * reaching the gate: a caller that forgets does not compile.
   */
  permission: CallPermission | null;
  /** The approval token the caller presented, when it presented one. */
  approvalToken?: string;
  /** Which channel a retry should carry its token on, for the instructions. */
  retryChannel: ApprovalRetryChannel;
  /**
   * Whether the caller is attached to a live DorkOS session, and can therefore
   * reach the UI tools to put the approval in front of the operator (DOR-1570).
   *
   * Only affects the WORDING of the retry instructions — never whether the gate
   * asks, or what it binds to. Set by `mcp-tool-gate.ts`'s in-session entry
   * point and by nothing else: the external `/mcp` server has no session, so
   * `control_ui` is not registered there and naming it would be an instruction
   * that can only fail. Defaults to false, which is the surface-agnostic
   * wording.
   */
  interactive?: boolean;
  /** Authenticated connector scope bound to any approval request or retry. */
  connectorAuthority?: ApprovalConnectorAuthority;
  /**
   * Set only by `permissions.request_access` (`request_permission`): the agent is
   * deliberately asking past a Blocked permission, and this is the reason it
   * gave (spec `agent-permissions` D8). With it, a Blocked permission mints a
   * rate-limited approval bound to this exact call instead of refusing, and a
   * granted token for that approval is honored. Never read off the wire: only
   * the request tool's handler sets it, on its own re-invocation.
   */
  blockedRequest?: { reason: string };
  /**
   * The thing this call would act on, already named (DOR-1929).
   *
   * Resolved by the caller because resolution is async and this gate is not —
   * see `approvals/approval-subject.ts`. Absent means "could not be named", and
   * every consequence of that is the card reading exactly as it did before.
   */
  subject?: ApprovalSubject;
  /**
   * Which surface this request arrived over, recorded only so an UNATTRIBUTED
   * card can say the true thing DorkOS knows about it.
   *
   * Never consulted by any decision here. It changes no ceiling, no binding and
   * no outcome — a request's origin is not evidence of anything, and treating it
   * as evidence is exactly how "it came from a session" would become a
   * privilege a caller could claim by choosing a surface.
   */
  origin?: ApprovalOrigin;
  /**
   * The session this call came from, recorded on any approval this gate mints so
   * a verdict answered after the in-session hold gave up can still reach it
   * (spec `approval-verdict-delivery`).
   *
   * A DELIVERY ADDRESS and never an authorization fact — nothing here or
   * downstream reads it to decide anything, for exactly the reason
   * {@link origin} gives. Absent on every sessionless surface (the external
   * `/mcp` server, HTTP, the introspection stub), which is precisely the set
   * with nowhere to deliver to.
   */
  requestingSession?: ApprovalRequestingSession;
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
 * callers travel the SAME comparison, so dropping a credential can never widen
 * what a caller may reach *once it is identified*.
 *
 * ## The residual this default leaves, stated because a ceiling invites the
 * wrong reading (DOR-486)
 *
 * A per-agent ceiling caps the caller that PRESENTS ITS TOKEN. An agent with a
 * shell can run `env -u DORKOS_AGENT_TOKEN dorkos call …`, or a bare `curl`, and
 * arrive here anonymous — capped at this value, which restricts nothing. It is
 * still gated (a destructive call needs a person's approval either way, and the
 * card says an unidentified caller asked), and it is still audited; what it is
 * not is *capped*.
 *
 * That is the same `local-trust` residual a per-agent permission and `account`
 * carry — an agent with a shell can reach the operator's own HTTP routes too —
 * and it has the same remedy: turn login on, which makes every `/api/*` path
 * demand a credential the agent has no way to mint. (An agent that can edit
 * files can also edit its own `.dork/agent.json`, which login does not stop;
 * the permission gate records that as a change made outside DorkOS.) See
 * `contributing/agent-operator-surface.md`. **A ceiling is protection against a
 * confused or prompt-injected agent following the sanctioned path, not a
 * sandbox**, and no user-facing copy may promise otherwise.
 *
 * Boot does not currently set {@link CapabilityTierGateOptions.anonymousTierCeiling}
 * and there is no config field for it: lowering it would cap the person's own
 * `dorkos call` and the external MCP clients that never send the header, which is
 * a posture decision with its own design, not a default to slip in behind a
 * ticket about per-agent limits. The seam is wired and typed so that decision has
 * somewhere to land.
 */
export const DEFAULT_ANONYMOUS_TIER_CEILING: CapabilityTier = WIDEST_CAPABILITY_TIER;

/** Boot-wired gate state. See the module TSDoc on failing closed. */
let gate: CapabilityTierGateOptions | undefined;

/**
 * Wire tier enforcement to the approval primitive. Called once at boot, before
 * the server accepts connections.
 *
 * Not before the routers are mounted: `index.ts` mounts `/mcp` and every
 * `/api/*` router well before it calls this. What matters is that `app.listen`
 * comes after, so no request can reach an unwired gate. Stating it as "before
 * anything is mounted" would be false and would invite someone to rely on an
 * ordering the boot sequence does not provide.
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

/**
 * Tier ordering, so a ceiling can be compared against a capability's tier.
 *
 * Shared with the guard that decides whether a change to a per-agent ceiling
 * widens it (`operator/agent-updater.ts`), because two tables that disagree
 * would mean an agent could set a fence this module then reads differently.
 */
const TIER_RANK = CAPABILITY_TIER_RANK;

/** How a capability's own tier reads in a message written for a model or a person. */
const TIER_PHRASE: Record<CapabilityTier, string> = {
  observe: 'only reads',
  act: 'changes things',
  destructive: 'cannot be undone',
};

/** How a tier reads as a LIMIT on an agent, which is a different sentence. */
const CEILING_PHRASE = CAPABILITY_CEILING_PHRASE;

/**
 * What a REVOKED agent may still reach: nothing above reading.
 *
 * Revocation means "this agent no longer acts as itself", and until DOR-486 it
 * did not survive contact with this gate: `describeAgent`/`resolve` answered
 * `undefined` for a revoked agent, `undefined` reads as "unidentified" here, and
 * an unidentified caller is capped at {@link DEFAULT_ANONYMOUS_TIER_CEILING} —
 * the WIDEST rung. So revoking a capped agent's tokens mid-session WIDENED what
 * it could reach. Both resolvers now say `inactive: 'revoked'` instead, and this
 * is the ceiling that answer buys.
 *
 * `observe` rather than "refuse everything" because the tier gate lets reads
 * through before any ceiling is consulted, for every caller including anonymous
 * ones — a revoked agent that could not read would be the one principal on the
 * system less privileged than a stranger, which is not what an off switch means.
 */
const REVOKED_TIER_CEILING: CapabilityTier = 'observe';

/**
 * The ceiling this caller is actually held to.
 *
 * Three cases, and the ORDER between them is the whole point: a caller that
 * identified itself must never be able to reach more by presenting less. See
 * {@link AgentIdentity.inactive} for why an expired identity keeps its recorded
 * ceiling while a revoked one is clamped.
 *
 * @param identity - The calling agent, when a surface resolved one.
 * @returns The tier this caller may not exceed.
 */
function effectiveCeiling(identity: AgentIdentity | undefined): CapabilityTier {
  if (!identity) return gate?.anonymousTierCeiling ?? DEFAULT_ANONYMOUS_TIER_CEILING;
  if (identity.inactive === 'revoked') return REVOKED_TIER_CEILING;
  return identity.tierCeiling;
}

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
 * ## The subject field is rendered by NAME, and only here
 *
 * When the caller resolved a {@link ApprovalSubject}, the argument that names the
 * target renders as the registry's name for it instead of the raw id — so
 * `agentId: "01KXQ3P7ADJY9DSXMZW1XGWCV4"` becomes `agent: "Lab Scout"`. That
 * substitution happens in this one function, so every surface that renders THIS
 * SENTENCE gets the name without changing. That is a smaller set than it looks:
 * the approvals card and the stored approval row read it, while the Activity
 * feed composes its own line from `action.title` (`capability-gate-audit.ts`)
 * and the notification carries the title only, deliberately without argument
 * values (`notification-registry.ts`). So no surface loses the id by this
 * substitution — not because they all read the sentence, but because the ones
 * that do not never showed the id in the first place.
 *
 * The id does not disappear — it moves. The card carries it as
 * `PendingApproval.subject.id` beside the name, which is where a person checks
 * one against the other. Keeping BOTH in this sentence would spend the summary's
 * length budget re-printing the thing the subject block already shows, and the
 * budget is what stops a padded argument from crowding out a real one.
 *
 * With no subject resolved, nothing here changes: the raw id renders as it
 * always did. That is the whole fail-closed story — a card can lose the name,
 * never the argument.
 *
 * @param action - The capability or tool being requested.
 * @param input - The parsed input the approval is bound to.
 * @param identity - The agent asking, when it identified itself.
 * @param subject - The named target, when the caller could resolve one.
 * @returns The card summary.
 */
export function describeGatedAttempt(
  action: GatedAction,
  input: unknown,
  identity?: AgentIdentity,
  subject?: ApprovalSubject
): string {
  const who = identity
    ? `${JSON.stringify(renderRequesterLabel(identity.displayName || identity.agentPath))} `
    : 'An unidentified caller ';
  const clause = joinSummaryFields(
    summaryFieldsNamingSubject(
      input,
      action.approvalDisplayFields,
      subject,
      action.approvalSubject?.field
    )
  );
  const detail = clause ? ` with ${clause}` : '';
  // The title is declared in DorkOS's own source, never by the caller, so it needs
  // no escaping — but the whole sentence gets the secret sweep anyway, because
  // this string is broadcast.
  return redactSecretsInText(`${who}wants to run "${action.title}"${detail}`);
}

/**
 * The verbatim value the card shows beside the summary, when the action declares
 * a detail field and the input actually carries a string there.
 *
 * Only a string qualifies. An object or a number rendered into a card would be
 * `[object Object]` or a bare digit sitting under a heading promising the full
 * text, which is worse than showing nothing — and the conformance suite already
 * requires the declared field to be a real one, so a non-string here means the
 * caller simply did not send it (every detail field is optional today).
 *
 * Not swept or capped here: `ApprovalService.request` owns both, so every
 * producer of a detail passes through one place, exactly as summaries do.
 *
 * @param action - The action being gated.
 * @param input - The parsed input the approval binds to.
 * @returns The value to store, or `undefined`.
 */
function detailFor(action: GatedAction, input: unknown): string | undefined {
  if (!action.approvalDetailField) return undefined;
  const value = readApprovalInputPath(input, action.approvalDetailField);
  return typeof value === 'string' ? value : undefined;
}

/** The label an approval records for who asked, or its absence for an anonymous one. */
function requesterLabel(identity?: AgentIdentity): string | undefined {
  if (!identity) return undefined;
  return renderRequesterLabel(identity.displayName || identity.agentPath);
}

/**
 * The sentence every gated caller gets, whatever surface it arrived on
 * (DOR-1570).
 *
 * "An approval card is waiting for them" used to be the whole instruction, and
 * a model reading it would dutifully stop — leaving a person who had been told
 * nothing to find the card themselves. DorkOS raises the bell, the desktop
 * banner and (after the escalation delay) the phone ping on its own; the one
 * thing only the agent can do is say out loud that it is waiting.
 */
const SAY_SO_FIRST =
  'Tell the person what you are asking to do and that it is waiting on their approval — say it in ' +
  'your reply, do not just stop.';

/**
 * The extra sentence for an agent inside a live DorkOS session, where it can
 * put the card in front of somebody instead of only describing it.
 *
 * Only ever added for an in-session caller. `control_ui` needs an attached
 * interactive session and is not registered on the sessionless external `/mcp`
 * server, so naming it there would be an instruction that can only fail. It is
 * also not auto-allowed, which is why this offers rather than promises.
 */
const OPEN_THE_PANEL =
  "If the approval is about a scheduled task, control_ui({ action: 'open_panel', panel: 'tasks' }) " +
  'opens the Schedules panel for them.';

/**
 * Retry instructions for the surface the call arrived on.
 *
 * @param channel - Where a retry carries its token.
 * @param interactive - Whether the caller is an in-session MCP server, and can
 *   therefore reach the UI tools.
 */
function retryGuidance(
  channel: ApprovalRetryChannel,
  interactive: boolean
): ApprovalRequiredPayload['retry'] {
  const surface = interactive ? `${SAY_SO_FIRST} ${OPEN_THE_PANEL}` : SAY_SO_FIRST;
  if (channel === 'mcp-argument') {
    return {
      channel,
      field: APPROVAL_TOKEN_ARGUMENT,
      instructions:
        `${surface} An approval card is waiting for them in DorkOS. Once they have approved it, call this ` +
        `tool again with exactly the same arguments plus "${APPROVAL_TOKEN_ARGUMENT}" set to the approvalToken above. ` +
        `Changing any argument invalidates the approval, because an approval covers one exact action.`,
    };
  }
  return {
    channel,
    field: APPROVAL_TOKEN_HEADER,
    instructions:
      `${surface} An approval card is waiting for them in DorkOS. Once they have approved it, send exactly the ` +
      `same request again with the "${APPROVAL_TOKEN_HEADER}" header set to the approvalToken above ` +
      `(with the CLI: dorkos call <id> --approval <token>). Changing the input invalidates the approval, ` +
      `because an approval covers one exact action.`,
  };
}

/**
 * Why a call needs a person, by tier: a destructive call because it cannot be
 * undone, an `act` call because its permission is set to Ask.
 *
 * @param tier - The action's tier.
 */
function needsApprovalClause(tier: CapabilityTier): string {
  return tier === 'destructive' ? 'cannot be undone' : 'is set to ask a person first';
}

/** The plain sentence explaining why a gated call is waiting. */
function approvalMessage(
  reason: ApprovalRequiredReason,
  title: string,
  tier: CapabilityTier,
  blocked = false
): string {
  switch (reason) {
    case 'no_approval':
      if (blocked) {
        return `"${title}" is blocked for this agent, so DorkOS has asked the person whether to allow it this time.`;
      }
      return tier === 'destructive'
        ? `"${title}" cannot be undone, so a person has to approve it first. DorkOS has asked them.`
        : `"${title}" is set to ask a person first. DorkOS has asked them.`;
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

/** The name an area goes by in a sentence, e.g. "Rooms". */
function areaLabel(area: PermissionAreaId): string {
  return getPermissionArea(area)?.label ?? area;
}

/**
 * What an agent that asked past Blocked is told when the rate limit stops it
 * (spec `agent-permissions` D8). Each refusal is final for now, so none of them
 * invites another try.
 */
function blockedLimitMessage(limit: BlockedRequestLimit, area: PermissionAreaId): string {
  switch (limit.limit) {
    case 'pending':
      return (
        `You already asked the person about ${areaLabel(area)} and they have not answered yet. ` +
        'Wait for that answer; do not ask again.'
      );
    case 'recently_denied':
      return (
        'The person said no to this in the last day. Do not ask again; tell them what you ' +
        'could not do and why.'
      );
    case 'hourly_limit':
      return (
        'You have asked past blocked permissions too many times in the last hour. Stop asking; ' +
        'tell the person what you need instead.'
      );
  }
}

/** The refusal reason each rate limit maps to. */
const BLOCKED_LIMIT_REASON: Record<BlockedRequestLimit['limit'], TierDeniedReason> = {
  pending: 'request_pending',
  recently_denied: 'recently_denied',
  hourly_limit: 'request_limit',
};

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
  const {
    action,
    identity,
    approvalToken,
    input,
    retryChannel,
    interactive = false,
    connectorAuthority,
    blockedRequest,
    subject,
    origin,
    requestingSession,
    permission,
  } = request;

  // The TIER decides whether to gate — never whether the caller identified
  // itself. Anything else is a bypass an agent with shell access can reach by
  // dropping its own token (see the module TSDoc).
  const tier = action.tier;

  /**
   * Attribution for the audit trail, omitted rather than nulled when anonymous,
   * plus the permission the call resolved to when the action has an area.
   */
  const attributed = {
    ...(identity ? { identity } : {}),
    ...(permission ? { permission: { state: permission.state, source: permission.source } } : {}),
  };

  // A person can be asked about a Blocked action only when the agent asked on
  // purpose, through `request_permission` (spec `agent-permissions` D8), and only
  // by an agent DorkOS can name: the rate limits and any later Always allow key
  // on its path. A revoked or expired identity, or settings nobody could read,
  // are never approvable, so they get no card whichever way they arrive.
  const askable =
    permission?.state === 'blocked' && !permission.unreadable && permission.source !== 'inactive';
  const blockedAsk =
    askable && blockedRequest !== undefined && identity !== undefined && !identity.inactive;

  // Blocked refuses every tier, reads included: a person turned the area (or the
  // action) off for this caller. A direct call mints nothing, whatever it
  // presents, even a token: its message names the request tool instead.
  // Checked before the read early-return below for exactly that reason.
  if (permission?.state === 'blocked' && !blockedAsk) {
    const payload = denied(action, 'permission_blocked', blockedPermissionMessage(permission), {
      approvable: askable,
    });
    audit({ action, ...attributed, decision: { outcome: 'denied', payload } });
    return { outcome: 'denied', payload };
  }

  // Reading is free, and a ceiling never blocks reading. Ask lets reads through
  // too: only a call that changes something raises a card. A blocked read the
  // agent asked for goes on to the card like anything else it asked for.
  if (tier === 'observe' && !blockedAsk) return { outcome: 'allowed' };

  // EVERY caller has a ceiling. An unidentified one gets the anonymous default,
  // so dropping a credential cannot move a caller onto a more permissive path
  // (see "the ceiling is not an escape hatch either" in the module TSDoc). The
  // ceiling is checked BEFORE the permission: an Allowed permission never lifts
  // a ceiling.
  const ceiling = effectiveCeiling(identity);
  if (TIER_RANK[tier] > TIER_RANK[ceiling]) {
    const limitedParty = identity
      ? identity.inactive === 'revoked'
        ? "this agent's access was turned off, so it is limited to"
        : 'this agent is limited to'
      : 'callers that do not identify themselves are limited to';
    const changeWhat = identity
      ? identity.inactive === 'revoked'
        ? 'somebody has to give this agent its access back first'
        : "the agent's own limit has to change first"
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

  // Allowed runs. An `act` call is audited by the attribution observer on
  // invoke, like any other allowed call. A `destructive` call can only resolve
  // Allowed from an ACTION-level setting (the resolver turns an area-level
  // Allowed on a destructive action into Ask), and it gets one Activity line
  // saying no card was shown: a stretch in which DorkOS goes quiet must not also
  // be one in which it goes blind.
  if (permission?.state === 'allowed') {
    const approval: GrantedApproval = { via: 'permission', source: permission.source };
    if (tier === 'destructive') {
      audit({ action, ...attributed, decision: { outcome: 'allowed', approval } });
    }
    return { outcome: 'allowed', approval };
  }

  // Ask on an `act` call raises a card, like a destructive one always does.
  // `act` with no area, or with an area that is not Ask, is allowed and audited —
  // by the attribution observer on invoke, so exactly one Activity record
  // describes the call.
  const askingForAct = tier === 'act' && permission?.state === 'ask';
  if (tier === 'act' && !askingForAct && !blockedAsk) return { outcome: 'allowed' };

  if (!gate) {
    const payload = denied(
      action,
      'enforcement_unavailable',
      `"${action.title}" ${needsApprovalClause(tier)} and DorkOS cannot ask anyone to approve it right now, so it was refused.`,
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
  let binding: {
    capabilityId: string;
    inputHash: string;
    authorityBindingDigest?: string;
  };
  try {
    binding = {
      capabilityId: action.id,
      inputHash: hashApprovalInput(input),
      ...(connectorAuthority ? { authorityBindingDigest: connectorAuthority.digest } : {}),
    };
  } catch (err) {
    logger.error('[capabilities] destructive input could not be bound to an approval', {
      capabilityId: action.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return refuse(
      'input_not_bindable',
      `"${action.title}" ${needsApprovalClause(tier)}, and DorkOS cannot describe this exact call well enough ` +
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
      `"${action.title}" ${needsApprovalClause(tier)} and DorkOS could not record an approval request for it, so it was refused.`,
      { approvable: false }
    );
    audit({ action, ...attributed, decision: { outcome: 'denied', payload } });
  };

  /**
   * Record a fresh request for THIS action and tell the caller how to retry.
   *
   * Typed to {@link FreshAskReason}, not the wider reason union: everything that
   * reaches here mints a NEW approval, and `isFreshApprovalAsk` promises exactly
   * that to the in-session hold. `awaiting_decision` echoes an existing approval
   * and is built inline below, so the compiler now keeps the two apart.
   */
  const ask = (reason: FreshAskReason): TierEnforcementDecision => {
    // A request past Blocked is rate-limited from the approvals store BEFORE
    // anything is minted, so a looping agent gets one card, never a stack of
    // them, and a restart cannot reset the count (spec `agent-permissions` D8).
    if (blockedAsk && permission) {
      let limit: BlockedRequestLimit | undefined;
      try {
        limit = gate!.approvals.blockedRequestLimit({
          agentPath: identity!.agentPath,
          area: permission.area,
          capabilityId: action.id,
        });
      } catch (err) {
        auditStoreFailure();
        throw err;
      }
      if (limit) {
        const payload = denied(
          action,
          BLOCKED_LIMIT_REASON[limit.limit],
          blockedLimitMessage(limit, permission.area),
          { approvable: false, ...('approvalId' in limit ? { approvalId: limit.approvalId } : {}) }
        );
        audit({ action, ...attributed, decision: { outcome: 'denied', payload } });
        return { outcome: 'denied', payload };
      }
    }
    let ticket: ApprovalTicket;
    try {
      const detail = detailFor(action, input);
      const remaining = subject ? describeRemainingArguments(action, input) : undefined;
      ticket = gate!.approvals.request({
        ...binding,
        summary: describeGatedAttempt(action, input, identity, subject),
        ...(detail !== undefined ? { detail } : {}),
        ...(requestedBy ? { requestedBy } : {}),
        ...(subject ? { subject } : {}),
        ...(remaining !== undefined ? { otherArguments: remaining } : {}),
        // Recorded only when nothing named the caller, because that is the only
        // case it says anything a person does not already have.
        ...(!requestedBy && origin ? { origin } : {}),
        ...(connectorAuthority ? { connectorAuthority } : {}),
        // The raw path alongside the display label, because an Always allow
        // writes onto the agent and the blocked-request limits count per agent,
        // and a label is not a key. An anonymous caller records none, which is
        // what keeps Always allow off its card.
        ...(identity ? { requestedByPath: identity.agentPath } : {}),
        // The area the gate decided on, so the card and the grant route read
        // the same answer to "may this be allowed always?".
        area: permission?.area ?? null,
        ...(blockedAsk && blockedRequest ? { blockedRequest } : {}),
        // Where to tell the answer, when the surface had a session at all. Not
        // read by any decision here — see the field's own docblock.
        ...(requestingSession ? { requestingSession } : {}),
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
      message: approvalMessage(reason, action.title, tier, blockedAsk),
      retry: retryGuidance(retryChannel, interactive),
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
      return {
        outcome: 'allowed',
        approval: {
          via: 'approval',
          approvalId: result.approvalId,
          ...(result.authorityBindingDigest
            ? { authorityBindingDigest: result.authorityBindingDigest }
            : {}),
        },
      };

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
        message: approvalMessage('awaiting_decision', action.title, tier),
        retry: retryGuidance(retryChannel, interactive),
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
export async function authorizeCapability(
  registry: CapabilityRegistry,
  id: string,
  input: unknown,
  context: CapabilityInvocationContext
): Promise<TierEnforcementDecision> {
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
  const parsed = capability.input.parse(input);
  const permission = await resolveCallPermission({
    action: capability,
    ...(context.identity ? { identity: context.identity } : {}),
  });
  return enforceCapabilityTier({
    action: capability,
    input: parsed,
    permission,
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
