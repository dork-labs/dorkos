/**
 * The production seams behind {@link TodoTurns} (DOR-3088): how a to-do's turn reaches the session
 * launcher, whether its agent is paused, the rooms' shared budget, and the source message read
 * from the room. Kept apart so the turns' own tests drive fakes and this is the one file that
 * reaches the launcher for a to-do.
 *
 * @module services/commitments/todo-turn-wiring
 */
import { randomUUID } from 'node:crypto';
import { ulid } from 'ulidx';
import { authors, eq, roomEntries, type Db } from '@dorkos/db';
import type { MeshCore } from '@dorkos/mesh';
import {
  dispatchSessionMessage,
  isSessionLaunchRefusal,
} from '../session/launch/launch-session.js';
import { agentPause } from '../mesh/pause/agent-pause.js';
import { roomTurnBudget } from '../rooms/limits/shared-turn-budget.js';
import { logger } from '../../lib/logger.js';
import type { TodoTurnsDeps } from './todo-turns.js';
import { agentInRoom } from './todo-source.js';

/** What the seams are built from. */
export interface TodoTurnSeamDeps {
  /** The DorkOS database. */
  readonly db: Db;
  /** Mesh, read per launch: it starts later in boot. */
  readonly meshCore: () => Pick<MeshCore, 'get' | 'getProjectPath'> | undefined;
}

/**
 * Build the launcher, pause check, shared budget and source reader for {@link TodoTurns}.
 *
 * @param deps - The database and the lazy agent registry.
 */
export function todoTurnSeams(deps: TodoTurnSeamDeps): Omit<TodoTurnsDeps, 'db' | 'now'> {
  return {
    async launch(request) {
      const mesh = deps.meshCore();
      const manifest = mesh?.get(request.agentId);
      const agentPath = mesh?.getProjectPath(request.agentId);
      if (!manifest || !agentPath) throw new Error('That agent is not on the team.');
      // A fresh chat per to-do turn, unattended: nobody is watching it run, so no card holds it.
      // `chat-message` is the origin whose turns a ceiling read at launch holds, as here.
      const sessionId = randomUUID();
      const result = await dispatchSessionMessage({
        origin: { kind: 'chat-message' },
        sessionId,
        messageId: ulid(),
        request: { content: request.content, agentPath, runtime: manifest.runtime },
        clientId: 'todos',
        meshCore: mesh as MeshCore,
        roomSessionPlace: undefined,
        unattended: true,
        ...(request.permissionCeiling !== undefined
          ? { permissionCeiling: request.permissionCeiling }
          : {}),
        ...(request.carriedMarks ? { carriedMarks: request.carriedMarks } : {}),
        countsTowardLaunchCap: true,
        onSettled: () => undefined,
      });
      if (isSessionLaunchRefusal(result)) throw new Error(result.message);
      if (!result.accepted) throw new Error('The chat did not take the to-do.');
      return { sessionId: result.canonicalId ?? sessionId };
    },
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
