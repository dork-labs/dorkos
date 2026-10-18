/**
 * `POST /api/direct-chats` — open an agent's Direct chat (rule S12, DOR-2997).
 *
 * The person plus one agent always opens the 1:1 view. This answers which
 * session that is for one agent: its standing chat, made the first time it is
 * needed. The app asks it from every door that leads there (the agent's row,
 * Talk, a ping, an old link to the DM room) and opens the session it names.
 *
 * **The person who owns this install only.** A Direct chat is their own
 * conversation, so an agent caller and any other person are refused.
 *
 * @module routes/direct-chats
 */
import { Hono } from 'hono';
import { OpenDirectChatRequestSchema } from '@dorkos/shared/room-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { getDirectChats } from '../services/rooms/direct-chat/index.js';
import { RoomError } from '../services/rooms/index.js';
import { isOwnerCaller } from './room-error-response.js';
import { parseOrRefuse, roomRoute } from './room-route.js';

/** The mesh reads this route needs: placing an agent id on disk. */
export interface DirectChatMesh {
  get(agentId: string): { name: string; displayName?: string } | undefined;
  getProjectPath(agentId: string): string | undefined;
}

/**
 * Build the route.
 *
 * @param mesh - The mesh, read per request: it starts after the routes mount.
 */
export function createDirectChatRoutes(mesh: () => DirectChatMesh | undefined): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.post('/', (c) => {
    const body = parseOrRefuse(c, OpenDirectChatRequestSchema, readJsonBody(c));
    if (body instanceof Response) return body;
    return roomRoute(c, 'POST /direct-chats', (caller) => {
      const viewer = caller();
      if (viewer.kind !== 'human' || !isOwnerCaller(viewer)) {
        throw new RoomError('OPERATOR_ONLY', 'Only the person who owns DorkOS has Direct chats.');
      }
      const chats = getDirectChats();
      if (!chats) return c.json({ error: 'Rooms are not running', code: 'ROOMS_UNAVAILABLE' }, 503);
      if ('agentId' in body) {
        const agent = mesh()?.get(body.agentId);
        const agentPath = mesh()?.getProjectPath(body.agentId);
        if (!agent || !agentPath) {
          return c.json({ error: 'No such agent', code: 'AGENT_NOT_FOUND' }, 404);
        }
        const chat = chats.ensureForAgent(agentPath, agent.displayName ?? agent.name);
        return c.json({ sessionId: chat.sessionId, roomId: chat.roomId, agentPath });
      }
      const chat = chats.ensureForRoom(body.roomId);
      if (!chat) {
        return c.json({ error: 'That room is not a Direct chat', code: 'NOT_A_DIRECT_CHAT' }, 409);
      }
      return c.json({ sessionId: chat.sessionId, roomId: chat.roomId, agentPath: chat.agentPath });
    });
  });

  return router;
}
