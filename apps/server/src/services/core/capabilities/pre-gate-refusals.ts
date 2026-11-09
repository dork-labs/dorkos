/**
 * Refusals that run BEFORE the permission gate (DOR-4060): a call no level, no
 * card and no saved "Always allow" may let through answers here, at once, with
 * nothing to approve.
 *
 * The protected-files rule is the first: an agent never starts a chat in
 * DorkOS's data folder or the home folder, and no DorkOS tool opens, reads or
 * copies a protected file, or one with more than one hard link. A card in front
 * of those would only ask a person to approve a leak, so the check runs ahead of
 * the card rather than behind it.
 *
 * Each domain registers the check for its own tool, where the code that knows
 * how its arguments name a file already lives, so this module imports no domain
 * and the two gates (`registry.invoke` and the hand-registered tool gate) ask
 * one function. The handlers still ask the same rules themselves: this is the
 * early answer, not the only one.
 *
 * @module services/core/capabilities/pre-gate-refusals
 */
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { TierDeniedPayload } from './tier-enforcement.js';

/** What a pre-gate check knows about the call, all of it from the surface, never the arguments. */
export interface PreGateCaller {
  /** The calling session, when the surface has one. */
  sessionId?: string;
  /** That session's folder, when the surface carries one. */
  cwd?: string;
  /** The calling agent's own home, when DorkOS verified one. */
  agentPath?: string;
}

/**
 * One tool's early check. Returns the sentence to refuse with, or `null` to let
 * the call reach the gate. It must not throw; a check that cannot decide lets the
 * call through to the handler, which asks the same rule again.
 */
export type PreGateCheck = (input: unknown, caller: PreGateCaller) => string | null;

const checks = new Map<string, PreGateCheck>();

/**
 * Register the early check for one capability id or hand-registered tool name.
 * A second registration for the same id replaces the first (a module reload).
 *
 * @param id - The capability id (`ui.control`) or MCP tool name (`session_start`).
 * @param check - The check.
 */
export function registerPreGateRefusal(id: string, check: PreGateCheck): void {
  checks.set(id, check);
}

/**
 * The sentence an early check refuses with, or `null`. For a hook that answers
 * before the runtime's own card, as Claude Code's `PreToolUse` does.
 *
 * @param id - The capability id or MCP tool name.
 * @param input - The arguments.
 * @param caller - Who is calling.
 */
export function preGateMessage(id: string, input: unknown, caller: PreGateCaller): string | null {
  const check = checks.get(id);
  if (!check) return null;
  try {
    return check(input, caller);
  } catch {
    return null;
  }
}

/**
 * The refusal for this call, as a denial nobody can approve past, or `null`.
 *
 * @param action - The action about to be gated.
 * @param input - Its arguments.
 * @param caller - Who is calling, from the surface.
 */
export function preGateRefusal(
  action: { readonly id: string; readonly title: string; readonly tier: CapabilityTier },
  input: unknown,
  caller: PreGateCaller
): TierDeniedPayload | null {
  const message = preGateMessage(action.id, input, caller);
  if (message === null) return null;
  return {
    status: 'denied',
    capabilityId: action.id,
    capabilityTitle: action.title,
    tier: action.tier,
    reason: 'permission_blocked',
    approvable: false,
    message,
  };
}
