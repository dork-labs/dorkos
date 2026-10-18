/**
 * `/api/direct-chats` — open an agent's Direct chat, or ask whether a session is
 * one (rule S12, DOR-2997).
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
import { getDirectChats, type DirectChat } from '../services/rooms/direct-chat/index.js';
import { RoomError } from '../services/rooms/index.js';
import { isOwnerCaller } from './room-error-response.js';
import { parseOrRefuse, roomRoute } from './room-route.js';

/** The mesh read this route needs: whether a directory is a registered agent. */
export interface DirectChatMesh {
  getByPath(agentPath: string): { name: string; displayName?: string } | undefined;
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
      if ('agentPath' in body) {
        // Only an agent Mesh registered: a directory is an identity here.
        const agent = mesh()?.getByPath(body.agentPath);
        if (!agent) return c.json({ error: 'No such agent', code: 'AGENT_NOT_FOUND' }, 404);
        const chat = chats.ensureForAgent(body.agentPath, agent.displayName ?? agent.name);
        return c.json(wire(chat));
      }
      const chat = chats.ensureForRoom(body.roomId);
      if (!chat) {
        return c.json({ error: 'That room is not a Direct chat', code: 'NOT_A_DIRECT_CHAT' }, 409);
      }
      return c.json(wire(chat));
    });
  });

  /**
   * GET /by-session/:sessionId — the Direct chat a session is, so the 1:1 view
   * can draw the messages in the log underneath it. 404 when it is not one.
   */
  router.get('/by-session/:sessionId', (c) =>
    roomRoute(c, 'GET /direct-chats/by-session/:sessionId', (caller) => {
      const viewer = caller();
      if (viewer.kind !== 'human' || !isOwnerCaller(viewer)) {
        throw new RoomError('OPERATOR_ONLY', 'Only the person who owns DorkOS has Direct chats.');
      }
      const chat = getDirectChats()?.forSession(c.req.param('sessionId'));
      if (!chat) return c.json({ error: 'Not a Direct chat', code: 'NOT_A_DIRECT_CHAT' }, 404);
      return c.json(wire(chat));
    })
  );

  return router;
}

/** A Direct chat as the wire carries it: never the agent's author id. */
function wire(chat: DirectChat) {
  return {
    sessionId: chat.sessionId,
    sessionIds: chat.sessionIds,
    roomId: chat.roomId,
    agentPath: chat.agentPath,
  };
}
