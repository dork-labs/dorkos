/**
 * OpenAPI entry for `POST /api/direct-chats`, projected from the schemas the
 * route reads and answers with.
 *
 * @module services/rooms/direct-chat/direct-chat-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ErrorResponseSchema } from '@dorkos/shared/schemas';
import { DirectChatSchema, OpenDirectChatRequestSchema } from '@dorkos/shared/room-schemas';

/**
 * Register the Direct chat routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerDirectChatOpenApi(registry: OpenAPIRegistry): void {
  const refusal = (description: string) => ({
    description,
    content: { 'application/json': { schema: ErrorResponseSchema } },
  });
  registry.registerPath({
    method: 'post',
    path: '/api/direct-chats',
    tags: ['Rooms'],
    summary: "Open an agent's Direct chat",
    description:
      "An agent's Direct chat is its standing one-to-one with the person who owns DorkOS. You plus " +
      'one agent always opens the 1:1 view, so this names the session to open for one agent, made ' +
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
      400: refusal('The body named neither an agent nor a room'),
      403: refusal('The caller is an agent, or a person other than the owner'),
      404: refusal('No registered agent lives in that directory'),
      409: refusal('That room is not the owner’s two-member direct message with one agent'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/direct-chats/by-session/{sessionId}',
    tags: ['Rooms'],
    summary: 'The Direct chat a session is',
    description:
      "Whether this session is an agent's Direct chat, and if so the direct message underneath " +
      'it, so the 1:1 view can show the messages that reached it outside the session. Owner only.',
    request: { params: z.object({ sessionId: z.string() }) },
    responses: {
      200: {
        description: 'The Direct chat',
        content: { 'application/json': { schema: DirectChatSchema } },
      },
      403: refusal('The caller is an agent, or a person other than the owner'),
      404: refusal('This session is not a Direct chat'),
    },
  });
}
