/**
 * The registry's half of argument escalation (DOR-3703): a capability's
 * `escalate` field, asked inside `registry.invoke` exactly where the
 * hand-registered tool gate asks a tool's escalator (`mcp-tool-gate.ts`):
 * after the permission is resolved, before the tier decides, with the grant
 * noted after. Kept out of `registry.ts`, which is near its line limit, with
 * the other half of what a call is carded as: the change it would make
 * (`describeApprovalChange`).
 *
 * Both gates run the escalator through one function
 * ({@link runToolCallEscalator}), so the same escalator decides a call the same
 * way on either: what it may raise, what it may not lower, and what a throw
 * means. That is what lets the hand tools move onto capabilities one group at a
 * time without a tool deciding differently on the way.
 *
 * @module services/core/capabilities/declarations/escalation
 */
import type { ApprovalOrigin } from '@dorkos/shared/approval-schemas';
import type { CapabilityDefinition, CapabilityDeps } from '../capability-definition.js';
import type { CapabilityInvocationContext } from '../registry.js';
import type { CallPermission } from '../permission-enforcement.js';
import type { GatedAction, TierEnforcementDecision } from '../tier-enforcement.js';
import {
  noteEscalatedGrant,
  runToolCallEscalator,
  type ToolCallContext,
} from '../tool-call-escalation.js';

/** What the tier gate decides one registry call as, after its escalator spoke. */
export interface EscalatedCapabilityCall {
  /** The action to decide, card and audit the call as: the capability, or what it escalated to. */
  action: GatedAction;
  /** The permission that decides it. */
  permission: CallPermission | null;
  /**
   * What the call would change, in words, bound into any approval: the
   * escalator's, else the capability's own `describeApprovalChange`.
   */
  change?: string;
  /**
   * Note how the call got through, for the handler to read back with
   * `escalatedGrantFor(input)`. Notes nothing for a call no escalator decided,
   * or one the gate did not allow.
   */
  note(decision: TierEnforcementDecision): void;
}

/**
 * The surface a registry call came over, as an escalator reads it: the
 * in-session server is the agent's own chat; every other surface is not.
 *
 * @param supplied - What the surface supplied.
 */
function originOf(supplied: CapabilityInvocationContext): ApprovalOrigin {
  return supplied.mcpServer === 'in-session' ? 'session' : 'external-mcp';
}

/**
 * Ask the capability's escalator about one call, when it has one, and describe
 * the change it would make. A trusted caller is a person, whom no agent
 * permission governs, so its call is decided as the capability itself, exactly
 * as before.
 *
 * @param deps - The registry's dependency bag, handed to the escalator.
 * @param capability - The capability being invoked.
 * @param input - The parsed input, the exact object the handler will receive.
 * @param permission - The capability's own permission, resolved for this call.
 * @param supplied - What the surface supplied: the caller and its chat.
 * @returns The action, permission and change to decide the call as.
 */
export async function escalateCall(
  deps: CapabilityDeps,
  capability: CapabilityDefinition,
  input: unknown,
  permission: CallPermission | null,
  supplied: CapabilityInvocationContext
): Promise<EscalatedCapabilityCall> {
  const { escalate } = capability;
  const describe = async (): Promise<string | undefined> =>
    capability.describeApprovalChange
      ? capability.describeApprovalChange(deps, input, supplied)
      : undefined;
  if (!escalate || supplied.trusted) {
    const change = await describe();
    return {
      action: capability,
      permission,
      ...(change !== undefined ? { change } : {}),
      note: () => undefined,
    };
  }
  const origin = originOf(supplied);
  const context: ToolCallContext = {
    ...(supplied.identity ? { identity: supplied.identity } : {}),
    origin,
    ...(supplied.sessionId ? { sessionId: supplied.sessionId } : {}),
    ...(supplied.cwd ? { cwd: supplied.cwd } : {}),
  };
  const escalation = await runToolCallEscalator((call) => escalate(deps, call), {
    action: capability,
    input,
    permission,
    context,
  });
  const change = escalation?.change ?? (await describe());
  return {
    action: escalation?.action ?? capability,
    permission: escalation ? escalation.permission : permission,
    ...(change !== undefined ? { change } : {}),
    note: (decision) => noteEscalatedGrant(input, escalation, decision, origin),
  };
}
