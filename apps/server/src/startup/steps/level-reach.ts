/**
 * The production wiring of the note a person's change to an agent's level
 * carries (DOR-3175): that agent's chats from `session_metadata`, each
 * runtime's modes and the agent's level from the runtime registry, and the
 * rise facts the turn-start check reads.
 *
 * @module startup/steps/level-reach
 */
import { eq, sessionMetadata, type Db } from '@dorkos/db';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { createLevelReachNote } from '../../services/core/permissions/level-reach-note.js';
import { chatRiseFacts } from '../../services/core/turn-power/chat-rise-facts.js';
import { resolveAgentLaunchLevel } from '../../services/session/resolution/agent-launch-level.js';

/**
 * Build the note reader over the live database and registry.
 *
 * @param db - The consolidated database.
 */
export function levelReachNoteFor(db: Db): ReturnType<typeof createLevelReachNote> {
  const capabilitiesOf = (runtime: string) =>
    runtimeRegistry.has(runtime) ? runtimeRegistry.get(runtime).getCapabilities() : undefined;
  return createLevelReachNote({
    chatsOf: (agentPath) =>
      db
        .select({
          sessionId: sessionMetadata.sessionId,
          runtime: sessionMetadata.runtime,
          permissionMode: sessionMetadata.permissionMode,
        })
        .from(sessionMetadata)
        .where(eq(sessionMetadata.agentPath, agentPath))
        .all(),
    modes: (runtime) => capabilitiesOf(runtime)?.permissionModes,
    levelModeOf: async (agentPath, runtime) =>
      (await resolveAgentLaunchLevel({ agentPath, capabilities: capabilitiesOf(runtime) })).mode,
    mayRise: (sessionId) => chatRiseFacts()?.mayRise(sessionId) === true,
  });
}
