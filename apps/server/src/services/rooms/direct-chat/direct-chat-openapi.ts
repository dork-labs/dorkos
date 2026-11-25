/**
 * OpenAPI entry for `POST /api/direct-chats`, projected from the schemas the
 * route reads and answers with.
 *
 * @module services/rooms/direct-chat/direct-chat-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { DirectChatSchema, OpenDirectChatRequestSchema } from '@dorkos/shared/room-schemas';
import { problemResponse } from '../../core/openapi/problem-openapi.js';

/**
 * Register the Direct chat routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerDirectChatOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/api/direct-chats',
    tags: ['Rooms'],
    summary: "Open an agent's Direct chat",
    description:
      "An agent's Direct chat is its standing one-to-one with the person who owns DorkOS. You plus " +
      'one agent always opens the 1:1 view, so this names the chat to open for one agent, made ' +
      'the first time anything needs it. Name the agent by its directory, or name a direct message that ' +
      'holds only the person and one agent. The direct message underneath keeps the pings and older ' +
      'messages, and is never shown as a room. Safe to call again: the same agent always gets the ' +
      'same chat, until its direct message gains another member.',
    request: { body: { content: { 'application/json': { schema: OpenDirectChatRequestSchema } } } },
    responses: {
      200: {
        description: 'The Direct chat',
        content: { 'application/json': { schema: DirectChatSchema } },
      },
      400: problemResponse('`invalid_request`: the body named neither an agent nor a room'),
      403: problemResponse(
        '`operator_only`: the caller is an agent, or a person other than the owner'
      ),
      404: problemResponse('`not_found`: no registered agent lives in that directory'),
      409: problemResponse(
        '`conflict`: that room is not the owner’s two-member direct message with one agent'
      ),
      503: problemResponse('`temporarily_unavailable`: rooms are not running'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/direct-chats/by-session/{sessionId}',
    tags: ['Rooms'],
    summary: 'Whether a chat is an agent’s Direct chat',
    description:
      "Whether this chat is an agent's Direct chat, and if so the direct message underneath " +
      'it, so the 1:1 view can show the messages that reached it from elsewhere. Owner only.',
    request: { params: z.object({ sessionId: z.string() }) },
    responses: {
      200: {
        description: 'The Direct chat',
        content: { 'application/json': { schema: DirectChatSchema } },
      },
      403: problemResponse(
        '`operator_only`: the caller is an agent, or a person other than the owner'
      ),
      404: problemResponse('`not_found`: this chat is not a Direct chat'),
    },
  });
}
