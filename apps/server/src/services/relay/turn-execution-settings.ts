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
 * ## Stored settings win PER KEY, not per row
 *
 * A setting a person chose for this conversation wins: "applies to new
 * conversations, running ones keep their settings." Everywhere else that rule
 * is kept by handing the runtime nothing and letting it hydrate the row itself,
 * which is what `ensureForMessage` does. The relay cannot do that — it calls
 * `ensureSession` first, which creates the session record before any hydration
 * would run — so the row is read here and merged in. Same promise, one step
 * earlier.
 *
 * **Key by key, because a row is not an answer to every question.** Moving the
 * trust dial writes a row that names a permission mode and NOTHING else, and a
 * row-shaped rule would read that as "this conversation has settings" and skip
 * the ladder entirely — so an agent would lose its model the moment somebody
 * touched its permissions, permanently, for that conversation. The other
 * surfaces do not have that hazard because `persistSessionRuntime` fills the
 * row's NULL columns from the same ladder (`fillNullsWith(seedForNewRow(…))`),
 * and nothing on the relay path calls it. Merging per key is what makes this
 * path yield what those already yield.
 *
 * The permission mode is in neither half. The relay resolves its own from the
 * binding that carried the message, and treats an absent one as prompting
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
    const declared = runtimeRegistry.get(runtimeType)?.getCapabilities().settings;
    const ladder = await resolveUnattendedSessionDefaults({
      runtimeType,
      ...(agentDirectory ? { agentPath: agentDirectory } : {}),
      ...(declared ? { declared } : {}),
    });
    // Picked out by name rather than spread, in both halves: `SessionSettings`
    // also admits a permission mode (the attended callers ask the ladder for
    // one, and a stored row usually holds one), and neither may travel back to
    // the relay. `fastMode` has no tier below the row — no manifest field and no
    // server default name it — so the row is the only place it can come from.
    const model = stored.model ?? ladder.model;
    const effort = stored.effort ?? ladder.effort;
    return {
      ...(model !== undefined && { model }),
      ...(effort !== undefined && { effort }),
      ...(stored.fastMode !== undefined && { fastMode: stored.fastMode }),
    };
  };
}

/**
 * What a person has already chosen for this conversation — an empty object when
 * they have chosen nothing, which a session with no row and a row that names
 * only a permission mode both are, and both truthfully.
 *
 * Tolerant of a failing read on purpose. A locked database here means the
 * question "what has this conversation got?" is unanswerable for a moment, and
 * the honest fallback is the ladder every new session starts on — not a refused
 * turn.
 *
 * @param sessionId - The key the relay turn runs under.
 */
async function readStoredSettings(sessionId: string): Promise<TurnExecutionSettings> {
  try {
    const stored = await runtimeRegistry.getSessionSettings(sessionId);
    if (!stored) return {};
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
    return {};
  }
}
