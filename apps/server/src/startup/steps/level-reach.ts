/**
 * The production wiring of the note a person's change to a level carries
 * (DOR-3175): every chat from `session_metadata` and its native binding, each
 * runtime's modes, the agent's own stop through the permission gate, the
 * stored global and per-runtime stops, and the facts the turn-start check reads.
 *
 * @module startup/steps/level-reach
 */
import { eq, sessionMetadata, sessionNativeBindings, type Db } from '@dorkos/db';
import type { ConfigManager } from '../../services/core/config-manager.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { permissionGateSources } from '../../services/core/capabilities/index.js';
import { readTrustStops } from '../../services/core/permissions/index.js';
import { createLevelReachNote } from '../../services/core/permissions/level-reach-note.js';
import { resolveLevelAgent } from '../../services/core/turn-power/agent-level-bound.js';
import { chatRiseFacts } from '../../services/core/turn-power/chat-rise-facts.js';

/**
 * Build the note reader over the live database, config and registry.
 *
 * @param db - The consolidated database.
 * @param config - The config manager the stored stops are read from.
 */
export function levelReachNoteFor(
  db: Db,
  config: Pick<ConfigManager, 'getDot'>
): ReturnType<typeof createLevelReachNote> {
  return createLevelReachNote({
    chats: () =>
      db
        .select({
          sessionId: sessionMetadata.sessionId,
          runtime: sessionMetadata.runtime,
          permissionMode: sessionMetadata.permissionMode,
          agentPath: sessionMetadata.agentPath,
          cwd: sessionNativeBindings.cwd,
        })
        .from(sessionMetadata)
        .leftJoin(
          sessionNativeBindings,
          eq(sessionNativeBindings.sessionId, sessionMetadata.sessionId)
        )
        .all(),
    agentOf: (chat) =>
      resolveLevelAgent(chat.cwd ?? chat.agentPath ?? undefined, undefined, chat.agentPath),
    modes: (runtime) =>
      runtimeRegistry.has(runtime)
        ? runtimeRegistry.get(runtime).getCapabilities().permissionModes
        : undefined,
    ownStop: async (agentPath) =>
      (await permissionGateSources().readAgentPermissions(agentPath))?.filesAndCommands ?? null,
    defaultStops: () => readTrustStops(config),
    // No facts wired reads as marked and not by hand: nothing is counted as rising.
    marked: (sessionId) => chatRiseFacts()?.marked(sessionId) ?? true,
    personSet: (sessionId) => chatRiseFacts()?.personSet(sessionId) ?? false,
  });
}
