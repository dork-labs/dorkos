/**
 * Gate a capability by the id its hand-registered tool had (C9a, on Security's
 * terms of 2026-11-27): `CapabilityDefinition.gateActionId`.
 *
 * The tasks tools moved off the hand gate onto the registry with new dotted
 * ids, but people keep settings, approvals and refusals under the tool names
 * (`dorkos permissions set tasks_delete blocked`, `HUB_OWNED_ACTIONS`). A
 * converted capability declares its old name here, and the registry decides
 * every call as that name, so a stored Blocked still blocks and Ask still asks.
 *
 * Security's four terms, and where each is held:
 *
 * 1. **A closed list.** {@link LEGACY_GATE_ACTION_IDS} is frozen. A capability
 *    may name only an id on it, and only its own MCP tool name, so
 *    `composeRegistry` (through {@link assertGateActionId}) refuses an id off
 *    the list, and two capabilities cannot share one: they would share a tool
 *    name, which compose already refuses.
 * 2. **One lookup.** `registry.invoke` reads {@link gateViewOf} once, and every
 *    consumer downstream (the stored permissions, `HUB_OWNED_ACTIONS`, the
 *    pre-gate refusals, the escalators and their cards, the approval and its
 *    card, the outside-words marks, the audit) reads that view's `id`. The
 *    settings rows read the same function.
 * 3. **Bound to both.** {@link approvalBindingInput} puts the capability's own
 *    id in the approval's hash beside the gate id, so an approval minted for
 *    the old hand tool, or for another capability, does not fit.
 * 4. Rows, in `gate-action-id.test.ts` and the tasks tools' tests.
 *
 * @module services/core/capabilities/declarations/gate-action
 */
import type { CapabilityDefinition } from '../capability-definition.js';

/** The hand tools' names a converted capability may be gated by. Frozen: C9b adds its own. */
export const LEGACY_GATE_ACTION_IDS = Object.freeze([
  'tasks_list',
  'tasks_create',
  'tasks_update',
  'tasks_delete',
  'tasks_get_run_history',
] as const);

/** One id on {@link LEGACY_GATE_ACTION_IDS}. */
export type LegacyGateActionId = (typeof LEGACY_GATE_ACTION_IDS)[number];

const LEGACY = new Set<string>(LEGACY_GATE_ACTION_IDS);

/**
 * Refuse a `gateActionId` off the frozen list, or one that is not the
 * capability's own MCP tool name (which is what keeps two capabilities from
 * sharing one).
 *
 * @param capability - The capability being composed.
 * @throws When the declaration is not allowed.
 */
export function assertGateActionId(
  capability: Pick<CapabilityDefinition, 'id' | 'gateActionId' | 'surfaces'>
): void {
  const { id, gateActionId } = capability;
  if (gateActionId === undefined) return;
  if (!LEGACY.has(gateActionId)) {
    throw new Error(`Capability registry: "${id}" may not be gated as "${gateActionId}".`);
  }
  if (capability.surfaces.mcp?.toolName !== gateActionId) {
    throw new Error(
      `Capability registry: "${id}" may be gated only by its own MCP tool name, not "${gateActionId}".`
    );
  }
}

/** A capability as the gate sees it: gated by its old id, still bound to its own. */
export type GateView<C extends CapabilityDefinition> = C & { readonly boundCapabilityId?: string };

const views = new WeakMap<CapabilityDefinition, CapabilityDefinition>();

/**
 * The capability as every gate consumer reads it: unchanged, or, when it
 * declares a `gateActionId`, a copy whose `id` is that name and which carries
 * its own id as `boundCapabilityId` for the approval binding.
 *
 * @param capability - The capability, or `undefined` when none is registered.
 */
export function gateViewOf<C extends CapabilityDefinition>(capability: C): GateView<C>;
export function gateViewOf<C extends CapabilityDefinition>(
  capability: C | undefined
): GateView<C> | undefined;
export function gateViewOf<C extends CapabilityDefinition>(
  capability: C | undefined
): GateView<C> | undefined {
  if (!capability?.gateActionId) return capability;
  let view = views.get(capability);
  if (!view) {
    view = Object.freeze({
      ...capability,
      id: capability.gateActionId,
      boundCapabilityId: capability.id,
    }) as CapabilityDefinition;
    views.set(capability, view);
  }
  return view as GateView<C>;
}

/**
 * What an approval's hash covers: the input (and the change it was decided on),
 * plus the capability's own id when it is gated by an old one.
 *
 * @param action - The action being decided.
 * @param input - The parsed input.
 * @param change - The described change, when there is one.
 */
export function approvalBindingInput(
  action: { readonly boundCapabilityId?: string },
  input: unknown,
  change: string | undefined
): unknown {
  const base = change === undefined ? input : { input, change };
  return action.boundCapabilityId === undefined
    ? base
    : { capability: action.boundCapabilityId, binding: base };
}
