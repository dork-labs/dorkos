/**
 * The production wiring of the line a person's change to a level adds to its history entry
 * (DOR-3175): every chat from `session_metadata` and its native binding, each
 * runtime's modes, the agent's own stop through the permission gate, the
 * stored global and per-runtime stops, and the facts the turn-start check reads.
 *
 * @module startup/steps/level-reach
 */
import {
  eq,
  rooms,
  roomSessions,
  sessionMetadata,
  sessionNativeBindings,
  type Db,
} from '@dorkos/db';
import { chatTitleOf } from '../../services/session/chat-messages/chat-message-wiring.js';
import type { ConfigManager } from '../../services/core/config-manager.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { permissionGateSources } from '../../services/core/capabilities/index.js';
import { readTrustStops } from '../../services/core/permissions/index.js';
import { createLevelReachNote } from '../../services/core/permissions/level-reach-note.js';
import { resolveLevelAgent } from '../../services/core/turn-power/agent-level-bound.js';
import { chatRiseFacts } from '../../services/core/turn-power/chat-rise-facts.js';

/** A chat's folder as its runtime holds it live, when the runtime has it. */
function liveCwdOf(sessionId: string, runtime: string | null): string | null {
  if (!runtime || !runtimeRegistry.has(runtime)) return null;
  try {
    return runtimeRegistry.get(runtime).getSessionCwd?.(sessionId) ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the reach reader over the live database, config and registry.
 *
 * @param db - The consolidated database.
 * @param config - The config manager the stored stops are read from.
 */
export function levelReachFor(
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
        .all()
        // Where the chat stands, as its turn would read it: the runtime's live
        // record first (a direct chat started with a folder and no recorded agent
        // is found only there), then the native binding.
        .map((chat) => ({ ...chat, cwd: liveCwdOf(chat.sessionId, chat.runtime) ?? chat.cwd })),
    // The same lookup the turn uses, so the count and the bound cannot disagree.
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
    titleOf: async (sessionId) => {
      const seat = db
        .select({ title: rooms.title })
        .from(roomSessions)
        .innerJoin(rooms, eq(rooms.id, roomSessions.roomId))
        .where(eq(roomSessions.sessionId, sessionId))
        .get();
      return seat ? `#${seat.title}` : await chatTitleOf(sessionId);
    },
  });
}
