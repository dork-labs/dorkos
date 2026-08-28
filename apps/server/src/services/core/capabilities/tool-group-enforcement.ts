/**
 * The per-agent tool-group gate: DorkOS's first capability filter that actually
 * refuses (spec `rooms-management-tools` §D1–D3, DOR-1611).
 *
 * A capability may declare a {@link CapabilityToolGroup} on its definition. When
 * it does, {@link enforceToolGroupGrant} runs inside `registry.invoke` — BEFORE
 * the tier gate, so a refused call never mints an approval card for an action
 * that was never going to run — and the call proceeds only for an identified
 * agent that holds the grant on its own manifest.
 *
 * ## A sibling of the tier gate, not a branch inside it
 *
 * `enforceCapabilityTier` answers "is this caller restricted?". This answers "does
 * this caller hold this grant?". They are different questions with opposite fail
 * directions, and hiding the second inside the first would be a name that lies.
 * What the two DO share is their refusal shape: this gate returns the existing
 * `TierDeniedPayload` with `reason: 'tool_group_disabled'`, so every surface that
 * already renders a refusal — HTTP 403, a non-`isError` MCP text result, a
 * `capability.denied` Activity line — renders this one with no new code.
 *
 * ## Why keying on identity is right here and wrong one file over
 *
 * `tier-enforcement.ts` refuses to key on identity presence, because its question
 * is NEGATIVE — an absent identity reads as "not restricted" and fails OPEN, which
 * an agent with shell access reaches by dropping its own token.
 *
 * This question is POSITIVE: "does this caller hold the grant?". An absent
 * identity holds nothing, so it fails CLOSED. Both obey the invariant the doctrine
 * protects — dropping a credential can never widen what a caller reaches. Under a
 * positive grant, dropping one strictly narrows.
 *
 * The fail table, which is the whole design:
 *
 * | Resolved caller                           | Outcome                          |
 * | ----------------------------------------- | -------------------------------- |
 * | Identified agent, grant `true`            | runs                             |
 * | Identified agent, grant `false` or absent | refused                          |
 * | Identity present but the lookup throws    | refused                          |
 * | Trusted caller                            | runs — see below                 |
 * | Unidentified                              | refused                          |
 *
 * The trusted row is not an exception carved here: `registry.invoke` calls this
 * gate inside its `if (!supplied.trusted)` block, on the standing rule that
 * whoever may decide an approval may act without one. A consequence worth
 * knowing: `trustedCaller` is minted at two production sites and the invoke route
 * is not one of them, so a capability declaring a tool group is agent-only by
 * construction.
 *
 * @module services/core/capabilities/tool-group-enforcement
 */
import type { CapabilityToolGroup } from './capability-definition.js';
import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import type {
  GatedAction,
  TierDeniedPayload,
  TierEnforcementAttempt,
  TierEnforcementDecision,
} from './tier-enforcement.js';
import { logger } from '../../../lib/logger.js';

/**
 * Whether one agent holds one capability tool group.
 *
 * An interface, injected at boot, read FRESH on every gated call: a person may
 * revoke the grant between two invocations, and a captured value would answer a
 * question that has to be current. This is what makes "turning the switch off
 * stops the very next call" a property of the code rather than a promise.
 *
 * The same rule, for the same reason, as `StandingGrantLookup` next door.
 */
export interface ToolGroupGrantLookup {
  /**
   * Whether this agent holds this group.
   *
   * Returns `false` for an agent with no manifest, no `enabledToolGroups`, or the
   * key absent. Throwing is treated as `false` by the caller: a grant that cannot
   * be read is a grant that is not held.
   *
   * @param agentPath - The calling agent's project directory.
   * @param group - The group the capability declared.
   * @returns Whether the grant is held.
   */
  holds: (agentPath: string, group: CapabilityToolGroup) => Promise<boolean>;
}

/** What {@link initToolGroupGate} wires this gate to at boot. */
export interface ToolGroupGateOptions {
  /**
   * How the gate reads a grant. Its ABSENCE fails closed: with nothing wired, no
   * grant is ever held, so every capability declaring a group is refused. That is
   * the safe direction and it is why boot may wire this after the routers are
   * mounted without opening a window.
   */
  grants: ToolGroupGrantLookup;
  /**
   * Called for every refusal, so an attempt an agent made and did not get is
   * visible to the operator. Boot passes the SAME observer the tier gate uses,
   * which turns a `denied` decision into a `capability.denied` Activity event.
   *
   * Must never throw; this module swallows anything it does. Forgetting to wire
   * it costs the audit line, never the refusal.
   */
  onAttempt?: (attempt: TierEnforcementAttempt) => void;
}

/** Boot-wired gate state. Absent means "no grant is held by anybody". */
let gate: ToolGroupGateOptions | undefined;

/**
 * Wire the tool-group gate to its grant lookup. Called once at boot, beside
 * `initCapabilityTierGate`.
 *
 * @param options - The grant lookup and the audit hook.
 */
export function initToolGroupGate(options: ToolGroupGateOptions): void {
  gate = options;
}

/**
 * Drop the wired gate. Test-only seam, mirroring `resetCapabilityTierGate`.
 */
export function resetToolGroupGate(): void {
  gate = undefined;
}

/**
 * The action this gate reads: a tier gate's {@link GatedAction} plus the group the
 * capability declared.
 *
 * A `CapabilityDefinition` satisfies it structurally, exactly as it satisfies
 * `GatedAction` — the registry path passes the definition itself and nothing is
 * restated.
 */
export type ToolGroupGatedAction = GatedAction & {
  /** The grant this action requires, or `undefined` for the ungated majority. */
  toolGroup?: CapabilityToolGroup;
};

/** Everything the gate needs to decide one invocation. */
export interface ToolGroupGateRequest {
  /** The capability about to be invoked. */
  action: ToolGroupGatedAction;
  /** The calling agent, when the surface resolved one. */
  identity?: AgentIdentity;
}

/**
 * What this gate decided. `allowed` is the only outcome `invoke` may proceed on;
 * the refusal carries the payload to hand the caller verbatim.
 */
export type ToolGroupDecision =
  { outcome: 'allowed' } | Extract<TierEnforcementDecision, { outcome: 'denied' }>;

/**
 * The sentence a refused agent reads.
 *
 * Names the remedy and who owns it, in the product's voice, the way the rooms
 * domain's own owner-presence refusal does. `approvable: false` travels with it so
 * the model knows no approval can unlock this and does not loop asking.
 */
const REFUSAL_MESSAGE =
  'Managing rooms is turned off for this agent. Ask the person who runs this ' +
  'install to turn on "Manage rooms" in this agent\'s Tools settings.';

/** The refusal each group is worded with. One group today; see D5 on adding one. */
const REFUSAL_BY_GROUP: Record<CapabilityToolGroup, string> = {
  roomsManage: REFUSAL_MESSAGE,
};

/** Report a refusal to the audit hook without ever failing the call. */
function audit(attempt: TierEnforcementAttempt): void {
  try {
    gate?.onAttempt?.(attempt);
  } catch {
    // An audit failure must not change what the caller is told.
  }
}

/**
 * Whether this caller holds the group, resolved FRESH and failing closed on
 * anything that is not a clear yes.
 *
 * @param agentPath - The calling agent's project directory.
 * @param group - The group the capability declared.
 * @returns Whether the grant is held.
 */
async function holdsGrant(agentPath: string, group: CapabilityToolGroup): Promise<boolean> {
  const lookup = gate?.grants;
  if (!lookup) return false;
  try {
    return await lookup.holds(agentPath, group);
  } catch (err) {
    logger.error('[capabilities] tool-group grant could not be read; refusing the call', {
      group,
      agentPath,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Enforce a capability's declared tool group for one invocation.
 *
 * One caller: `registry.invoke`, inside its untrusted branch and before the tier
 * gate. A capability with no `toolGroup` costs one `undefined` check and is
 * allowed without reading anything.
 *
 * @param request - The capability about to run and the calling identity.
 * @returns What the gate decided. Proceed only on `allowed`.
 */
export async function enforceToolGroupGrant(
  request: ToolGroupGateRequest
): Promise<ToolGroupDecision> {
  const { action, identity } = request;
  const group = action.toolGroup;
  if (!group) return { outcome: 'allowed' };

  if (identity && (await holdsGrant(identity.agentPath, group))) {
    return { outcome: 'allowed' };
  }

  const payload: TierDeniedPayload = {
    status: 'denied',
    capabilityId: action.id,
    capabilityTitle: action.title,
    tier: action.tier,
    reason: 'tool_group_disabled',
    // Load-bearing: there is no approval that unlocks this, only a person
    // turning the grant on, and a model told otherwise will ask forever.
    approvable: false,
    message: REFUSAL_BY_GROUP[group],
  };
  const decision = { outcome: 'denied', payload } as const;
  audit({ action, ...(identity ? { identity } : {}), decision });
  return decision;
}
