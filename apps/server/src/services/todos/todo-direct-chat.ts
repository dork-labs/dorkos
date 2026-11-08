/**
 * Where a to-do's turn runs, and its card (DOR-3088, Security's Option A for "to-do turns run in
 * the DM, under a card").
 *
 * - Every to-do assigned to an agent gets one card in the person's Direct chat with that agent,
 *   written in DorkOS's own voice. The card's stored text is a fixed line, never the to-do's words:
 *   the app draws the to-do itself, as the reader may see it, so nothing a stranger wrote enters
 *   the Direct chat's log.
 * - Only a to-do that runs there (`todoRunsInDirectChat`, decided at each turn start) starts its
 *   turn in that chat's own session. Every other to-do keeps a chat of its own, as before.
 * - Every to-do turn names its ceiling (Must 4): the to-do's stored bound, or else its agent's set
 *   level. When neither can be read, the stranger's bound. Never the chat's own mode.
 *
 * @module services/todos/todo-direct-chat
 */
import { and, eq, roomEntries, sql, type Db } from '@dorkos/db';
import type { TurnPermissionBound } from '@dorkos/shared/agent-runtime';
import { levelOfMode } from '@dorkos/shared/permission-semantics';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { getDirectChats } from '../rooms/direct-chat/index.js';
import { getRoomService } from '../rooms/index.js';
import { resolveAgentLaunchLevel } from '../session/resolution/agent-launch-level.js';
import { logger } from '../../lib/logger.js';

/** The card's stored text: a fixed line, so no to-do's words reach the chat's log. */
export const TODO_CARD_TEXT = 'New to-do';

/** A person's Direct chat with one agent: its room and its session. */
export interface TodoDirectChat {
  /** The chat's room, where the card goes. */
  readonly roomId: string;
  /** The chat's own session, where a person's to-do runs. */
  readonly sessionId: string;
}

/** The parts of the rooms a to-do reaches, as seams so tests drive fakes. */
export interface TodoDirectChatPort {
  /** The person's Direct chat with an agent, found or made; undefined when rooms are not up. */
  chatFor(agentPath: string, displayName: string): TodoDirectChat | undefined;
  /** Post a to-do's card into a room, once: a second call for the same to-do does nothing. */
  postCardOnce(roomId: string, todoId: string): void;
  /** An agent's set level as a turn bound, or the stranger's bound when it can't be read. */
  agentLevel(agentPath: string, runtimeType: string): Promise<TurnPermissionBound>;
}

/** Whether a room already holds a to-do's card. */
function hasCard(db: Db, roomId: string, todoId: string): boolean {
  const found = db
    .select({ id: roomEntries.id })
    .from(roomEntries)
    .where(
      and(
        eq(roomEntries.roomId, roomId),
        sql`json_extract(${roomEntries.body}, '$.todo.todoId') = ${todoId}`
      )
    )
    .get();
  return found !== undefined;
}

/**
 * The production port: the live Direct chats, the room service's card writer, and the agent's
 * level read the way a new chat reads it.
 *
 * @param db - The DorkOS database.
 */
export function todoDirectChatPort(db: Db): TodoDirectChatPort {
  return {
    chatFor(agentPath, displayName) {
      const chats = getDirectChats();
      if (!chats) return undefined;
      const chat = chats.ensureForAgent(agentPath, displayName);
      return { roomId: chat.roomId, sessionId: chat.sessionId };
    },
    postCardOnce(roomId, todoId) {
      if (hasCard(db, roomId, todoId)) return;
      getRoomService().postTodoCard(roomId, { text: TODO_CARD_TEXT, todoId });
    },
    async agentLevel(agentPath, runtimeType) {
      try {
        const capabilities = runtimeRegistry.get(runtimeType).getCapabilities();
        const declared = capabilities.permissionModes;
        const { mode } = await resolveAgentLaunchLevel({ agentPath, capabilities });
        // Nothing configured: the runtime's own default decides, as for a new chat.
        return levelOfMode(declared, mode ?? declared.default) ?? 'runtime-default';
      } catch (err) {
        logger.warn('[todos] could not read the agent’s level; holding the turn to the default', {
          error: err instanceof Error ? err.message : String(err),
        });
        return 'runtime-default';
      }
    },
  };
}
