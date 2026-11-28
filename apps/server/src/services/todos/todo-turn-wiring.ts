/**
 * The production seams behind {@link TodoTurns} (DOR-3088): where and how a to-do's turn runs,
 * the wake that starts it (spec `turns-survive-restarts` §6.3, through the turn port), whether
 * its agent is paused, the rooms' shared budget, and the source message read from the room. Kept
 * apart so the turns' own tests drive fakes and this is the one file that starts a to-do's turn.
 *
 * @module services/todos/todo-turn-wiring
 */
import { randomUUID } from 'node:crypto';
import { authors, eq, roomEntries, type Db } from '@dorkos/db';
import type { MeshCore } from '@dorkos/mesh';
import { agentPause } from '../mesh/pause/agent-pause.js';
import { roomTurnBudget } from '../rooms/limits/shared-turn-budget.js';
import { logger } from '../../lib/logger.js';
import type { TodoTurnsDeps } from './todo-turns.js';
import { agentInRoom } from './todo-source.js';
import { todoDirectChatPort, type TodoDirectChatPort } from './todo-direct-chat.js';

/** What the seams are built from. */
export interface TodoTurnSeamDeps {
  /** The DorkOS database. */
  readonly db: Db;
  /** Mesh, read per launch: it starts later in boot. */
  readonly meshCore: () => Pick<MeshCore, 'get' | 'getProjectPath'> | undefined;
  /** Saves a turn's wake (the run record's `wakeChat`), handed in at startup. */
  readonly wake: TodoTurnsDeps['wake'];
  /** The person's Direct chats and the card writer; the live rooms unless a test passes its own. */
  readonly directChats?: TodoDirectChatPort;
}

/**
 * Build the launch, the wake, the pause check, the shared budget and the source reader for
 * {@link TodoTurns}.
 *
 * @param deps - The database and the lazy agent registry.
 */
export function todoTurnSeams(deps: TodoTurnSeamDeps): Omit<TodoTurnsDeps, 'db' | 'now'> {
  const chats = deps.directChats ?? todoDirectChatPort(deps.db);
  return {
    async prepare(request) {
      const mesh = deps.meshCore();
      const manifest = mesh?.get(request.agentId);
      const agentPath = mesh?.getProjectPath(request.agentId);
      if (!manifest || !agentPath) throw new Error('That agent is not on the team.');
      // The person's Direct chat with the agent: where their own to-do runs, and where a to-do the
      // person gave gets its card, whichever chat runs the turn. A to-do one agent gives another
      // makes no chat and no card. A chat or card that can't be made never stops the turn.
      let chat: ReturnType<TodoDirectChatPort['chatFor']>;
      if (request.inDirectChat || request.cardForPerson) {
        try {
          chat = chats.chatFor(agentPath, manifest.name);
        } catch (err) {
          logger.warn('[todos] the Direct chat could not be found', {
            todoId: request.todoId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (chat && request.cardForPerson) {
        try {
          chats.postCardOnce(chat.roomId, request.todoId);
        } catch (err) {
          logger.warn('[todos] the to-do card could not be posted', {
            todoId: request.todoId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Every to-do turn names its ceiling: its stored bound, or its agent's set level, so the
      // chat it runs in can only hold it lower, never set it (Security's Must 4).
      const permissionCeiling =
        request.permissionCeiling ?? (await chats.agentLevel(agentPath, manifest.runtime));
      // The person's own to-do runs in their Direct chat with the agent; every other to-do in a
      // fresh chat of its own, so no outside words enter the person's conversation. Unattended
      // either way.
      const inChat = request.inDirectChat && chat !== undefined;
      return {
        sessionId: inChat ? chat!.sessionId : randomUUID(),
        agentId: request.agentId,
        content: request.content,
        tier: 'owner',
        runtime: manifest.runtime,
        unattended: true,
        permissionCeiling,
        ...(request.carriedMarks ? { carriedMarks: request.carriedMarks } : {}),
      };
    },
    wake: deps.wake,
    isPaused: (agentId) => agentPause()?.pausedAgent(agentId) !== undefined,
    // Keyed by the assigner, so its to-do turns share the install's wallet with room turns.
    // When the rooms' limits are off this answers yes without counting.
    sharedBudget: (assigner) => {
      try {
        return roomTurnBudget()?.tryReserve(`todos:${assigner}`).allowed ?? true;
      } catch (err) {
        // The to-do caps still hold on their own; a budget that cannot answer stops nothing.
        logger.warn('[todos] the rooms turn budget could not answer', {
          error: err instanceof Error ? err.message : String(err),
        });
        return true;
      }
    },
    readSource(entryId, agentId) {
      const entry = deps.db
        .select({
          roomId: roomEntries.roomId,
          authorId: roomEntries.authorId,
          body: roomEntries.body,
        })
        .from(roomEntries)
        .where(eq(roomEntries.id, entryId))
        .get();
      if (!entry) return undefined;
      // Only a room the agent running the turn is in: a to-do must not carry a message out of a
      // room its assignee cannot read. An agent's author is keyed by its home folder.
      const agentPath = deps.meshCore()?.getProjectPath(agentId);
      if (!agentPath) return undefined;
      if (!agentInRoom(deps.db, entry.roomId, agentPath)) return undefined;
      let text: string | undefined;
      try {
        const body = JSON.parse(entry.body) as { text?: unknown };
        text = typeof body.text === 'string' ? body.text : undefined;
      } catch {
        text = undefined;
      }
      if (text === undefined) return undefined;
      const author = deps.db
        .select({ name: authors.displayName })
        .from(authors)
        .where(eq(authors.id, entry.authorId))
        .get();
      return { author: author?.name ?? entry.authorId, text };
    },
  };
}
