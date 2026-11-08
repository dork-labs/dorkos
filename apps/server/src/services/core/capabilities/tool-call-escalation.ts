/**
 * A seam for a hand-registered tool whose ARGUMENTS can reach a permission
 * action of their own (DOR-3703): `tasks_update` with a `permissionMode` or a
 * `status` is no longer only "change a scheduled task", it is also
 * `tasks.set_mode` or `tasks.approve`, each set on its own.
 *
 * The tool gate (`mcp-tool-gate.ts`) asks the escalator registered for the tool
 * before it enforces the tier. An escalator may hand back a different action to
 * decide and card the call as, and the permission that decides it, so a card
 * is raised, held and answered by the machinery every other card uses: bound
 * to a hash of exactly these arguments, answered only through the person's
 * approval route. It can only make a call stricter than the tool's own answer,
 * never looser, except to let a call through to a handler that will refuse it
 * whole (so nobody is asked about a call that cannot run).
 *
 * The gate notes, per call, which action a person granted and how; the handler
 * reads it back with {@link escalatedGrantFor}, so a call that needed a person
 * and reached the handler without one is refused there too.
 *
 * @module services/core/capabilities/tool-call-escalation
 */
import type { ApprovalOrigin } from '@dorkos/shared/approval-schemas';
import type { AgentIdentity } from '../agent-identity/agent-identity-service.js';
import type { CallPermission } from './permission-enforcement.js';
import type { GatedAction, TierEnforcementDecision } from './tier-enforcement.js';
import { logger } from '../../../lib/logger.js';

/** Where a gated call came from, as the gate verified it. */
export interface ToolCallContext {
  /** The calling agent, when the surface resolved one. */
  identity?: AgentIdentity;
  /** The surface: `session` is an agent's own tools inside its own chat. */
  origin: ApprovalOrigin;
  /** The calling chat, when there is one. */
  sessionId?: string;
  /** The folder the calling chat runs in, when the surface knows it. */
  cwd?: string;
}

/** What an escalator decided: the action to decide the call as, and the permission. */
export interface ToolCallEscalation {
  /** The action the call is decided, carded and audited as. */
  action: GatedAction;
  /** The permission that decides it. */
  permission: CallPermission | null;
  /**
   * What the call would change, in words, bound into the approval beside the
   * arguments and shown on the card: the same arguments against a different
   * state are a different change, and do not spend this approval.
   */
  change?: string;
}

/** One escalator: `null` leaves the call to the tool's own permission. */
export type ToolCallEscalator = (call: {
  action: GatedAction;
  input: unknown;
  permission: CallPermission | null;
  context: ToolCallContext;
}) => Promise<ToolCallEscalation | null>;

/** How a call the escalator decided got through the gate. */
export interface EscalatedGrant {
  /** The action it was decided as. */
  actionId: string;
  /** `card` when a person approved it, `allowed` when a setting did. */
  via: 'card' | 'allowed';
  /** The approval a person answered, when one was spent. */
  approvalId?: string;
  /** The surface it came over. */
  origin: ApprovalOrigin;
  /** The change it was decided on, when the escalator described one. */
  change?: string;
}

const escalators = new Map<string, ToolCallEscalator>();
const grants = new WeakMap<object, EscalatedGrant>();

/**
 * Register the escalator for one tool, replacing any earlier one.
 *
 * @param toolName - The hand-registered tool.
 * @param escalator - Decides the calls whose arguments reach an action of their own.
 * @returns A function that removes it again (for tests).
 */
export function registerToolCallEscalator(
  toolName: string,
  escalator: ToolCallEscalator
): () => void {
  escalators.set(toolName, escalator);
  return () => {
    if (escalators.get(toolName) === escalator) escalators.delete(toolName);
  };
}

/**
 * Ask the tool's escalator about one call. An escalator that throws decides
 * the call as Blocked, with no card: a rule nobody could evaluate is not met.
 *
 * @param call - The tool's action, the parsed input, its permission, and the caller.
 */
export async function escalateToolCall(call: {
  action: GatedAction;
  input: unknown;
  permission: CallPermission | null;
  context: ToolCallContext;
}): Promise<ToolCallEscalation | null> {
  const escalator = escalators.get(call.action.id);
  if (!escalator) return null;
  try {
    return await escalator(call);
  } catch (err) {
    logger.error('[capabilities] a tool-call escalator threw; refusing the call', {
      toolName: call.action.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      action: call.action,
      permission: {
        area: call.permission?.area ?? 'permissions',
        state: 'blocked',
        source: 'always-asks',
        layer: 'floor',
        unreadable: true,
      },
    };
  }
}

/**
 * Note how an escalated call got through, for its handler to read back. A call
 * no escalator decided, or one the gate did not allow, notes nothing.
 *
 * @param input - The exact input object the handler will receive.
 * @param escalation - What the escalator decided.
 * @param decision - What the gate decided.
 * @param origin - The surface.
 */
export function noteEscalatedGrant(
  input: unknown,
  escalation: ToolCallEscalation | null,
  decision: TierEnforcementDecision,
  origin: ApprovalOrigin
): void {
  if (!escalation || decision.outcome !== 'allowed') return;
  if (input === null || typeof input !== 'object') return;
  const approval = decision.approval;
  grants.set(input, {
    actionId: escalation.action.id,
    via: approval?.via === 'approval' ? 'card' : 'allowed',
    ...(approval?.via === 'approval' ? { approvalId: approval.approvalId } : {}),
    origin,
    ...(escalation.change !== undefined ? { change: escalation.change } : {}),
  });
}

/**
 * How the gate let this exact input through, or `undefined` when no escalator
 * decided it (the handler was reached some other way, or the call reached no
 * action of its own).
 *
 * @param input - The input object the handler received.
 */
export function escalatedGrantFor(input: unknown): EscalatedGrant | undefined {
  return input !== null && typeof input === 'object' ? grants.get(input) : undefined;
}
