/**
 * OpenAPI entry for `POST /api/direct-chats`, projected from the schemas the
 * route reads and answers with.
 *
 * @module services/rooms/direct-chat/direct-chat-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { ErrorResponseSchema } from '@dorkos/shared/schemas';
import { DirectChatSchema, OpenDirectChatRequestSchema } from '@dorkos/shared/room-schemas';

/**
 * Register the Direct chat route.
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
      'the first time anything needs it. Name the agent by its Mesh id, or name a direct message that ' +
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
      404: refusal('No agent has that id'),
      409: refusal('That room is not the owner’s two-member direct message with one agent'),
    },
  });
}
