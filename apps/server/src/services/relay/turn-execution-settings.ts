/**
 * What model a relay-triggered turn runs on.
 *
 * The relay adapter lives in `@dorkos/relay` and cannot see a manifest, the
 * user's config or the settings table, so it asks for this through a seam
 * ({@link ExecutionSettingsResolver}) and the server answers. Before that seam
 * existed nothing on the path answered at all: an agent pinned to Opus replied
 * to a colleague on whatever the server happened to default to, while the very
 * same agent addressed in a room or from the cockpit answered on Opus
 * (DOR-1344).
 *
 * The answer is deliberately the SAME one a room turn gets — both go through
 * {@link resolveUnattendedSessionDefaults} — because "which model is this agent"
 * must not depend on who is asking it.
 *
 * ## Two branches, one rule
 *
 * A session that already has stored settings is a running conversation and
 * keeps them: "applies to new conversations, running ones keep their settings."
 * Everywhere else that rule is kept by handing the runtime nothing and letting
 * it hydrate the row itself, which is what `ensureForMessage` does. The relay
 * cannot do that — it calls `ensureSession` first, which creates the session
 * record before any hydration would run — so it reads the row here and passes
 * the values through. Same promise, one step earlier.
 *
 * The permission mode is not in either branch. The relay resolves its own from
 * the binding that carried the message, and treats an absent one as prompting
 * rather than as consent (DOR-604); an answer from here would be a second
 * answer to a settled question.
 *
 * @module services/relay/turn-execution-settings
 */
import type { ExecutionSettingsResolver, TurnExecutionSettings } from '@dorkos/relay';
import { logger } from '../../lib/logger.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { resolveUnattendedSessionDefaults } from '../session/index.js';

/**
 * Build the resolver the Claude Code relay adapter asks before every turn.
 *
 * @param runtimeType - The runtime the adapter's sessions actually run on. It
 *   is the adapter's own runtime, not the one an agent's manifest names: a
 *   manifest written for a runtime this build did not register is resolved onto
 *   this one, and its model is dropped rather than handed to a runtime from
 *   another provider's namespace (see `resolveSessionDefaults`).
 * @returns A resolver that never throws — a settings problem is a reason to run
 *   the turn on the runtime's own default, never a reason to drop a message.
 */
export function createTurnExecutionSettingsResolver(
  runtimeType: string
): ExecutionSettingsResolver {
  return async ({ sessionId, agentDirectory }) => {
    const stored = await readStoredSettings(sessionId);
    if (stored) return stored;
    const declared = runtimeRegistry.get(runtimeType)?.getCapabilities().settings;
    const { model, effort } = await resolveUnattendedSessionDefaults({
      runtimeType,
      ...(agentDirectory ? { agentPath: agentDirectory } : {}),
      ...(declared ? { declared } : {}),
    });
    // Picked out by name rather than spread: the resolver's return type also
    // admits a permission mode (for the attended callers that ask it for one),
    // and this path must never carry one back to the relay.
    return { ...(model !== undefined && { model }), ...(effort !== undefined && { effort }) };
  };
}

/**
 * What this session already runs with, or `null` when it is a new one.
 *
 * `fastMode` travels with the other two: it is a session setting a person can
 * change, and the whole point of this branch is that their choices survive an
 * eviction or a restart.
 *
 * Tolerant of a failing read on purpose. A locked database here means the
 * question "has this conversation got settings?" is unanswerable for a moment,
 * and the honest fallback is the ladder every new session starts on — not a
 * refused turn.
 *
 * @param sessionId - The key the relay turn runs under.
 */
async function readStoredSettings(sessionId: string): Promise<TurnExecutionSettings | null> {
  try {
    const stored = await runtimeRegistry.getSessionSettings(sessionId);
    if (!stored) return null;
    return {
      ...(stored.model !== undefined && { model: stored.model }),
      ...(stored.effort !== undefined && { effort: stored.effort }),
      ...(stored.fastMode !== undefined && { fastMode: stored.fastMode }),
    };
  } catch (err) {
    logger.warn('[relay] could not read the stored settings for a session', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
