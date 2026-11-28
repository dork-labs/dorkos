/**
 * OpenAPI entries for `/api/hub/computers` (`routes/hub-computers.ts`): a
 * hub's owner chatting with the agents on their linked computers. The answer
 * bodies are the relay protocol's own (`@dorkos/shared/session-relay`); the
 * request bodies are documented here, and the route checks each one against
 * the protocol's schema before anything is sent.
 *
 * @module services/core/hub-relay/hub-computers-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  RelayResultBodySchemas,
  SESSION_RELAY_MAX_MESSAGE_LENGTH,
} from '@dorkos/shared/session-relay';
import { MessageDispositionSchema } from '@dorkos/shared/schemas';
import { HubComputerListSchema } from '@dorkos/shared/session-relay-link';
import { problemResponse } from '../openapi/problem-openapi.js';

const TAGS = ['Hub'];

const ComputerParams = z.object({ computerId: z.string() });
const SessionParams = ComputerParams.extend({
  sessionId: z.string().uuid().describe('The chat, a lowercase UUID'),
});

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

/**
 * Every refusal these routes can answer with, beside the success: problem
 * documents in our own words, never the computer's (DOR-4979).
 */
const REFUSALS = {
  400: problemResponse('Not a request the relay carries (`invalid_request`)'),
  403: problemResponse(
    "Not the person's own browser sign-in (`person_only`): an agent or an API key never " +
      'reaches these routes. Or the computer refused it (`forbidden`)'
  ),
  404: problemResponse('Not a hub, no such linked computer, or no such chat or agent on it'),
  409: problemResponse('The computer could not do that right now (`conflict`)'),
  413: problemResponse('The request is too large to relay (`request_too_large`)'),
  429: problemResponse('Too many requests to the computer, or at once (`rate_limited`)'),
  502: problemResponse(
    'The computer turned the request away (`computer_refused`), failed it, or sent an ' +
      'answer that could not be read (`upstream_unavailable`)'
  ),
  501: problemResponse(
    'The computer needs an update for this; `feature` names it (`needs_update`)'
  ),
  503: problemResponse(
    'The computer is not connected. It is being woken; try again after `Retry-After` seconds ' +
      '(`computer_waking`). Or its connection ended before it answered (`computer_offline`).'
  ),
  504: problemResponse('The computer did not answer in time (`computer_timed_out`)'),
};

/**
 * Register the hub's linked-computer chat routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerHubComputersOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/hub/computers',
    tags: TAGS,
    summary: 'List linked computers',
    description:
      'On a hub: each computer it serves, the name it linked with, whether it is connected now, ' +
      'and the relay features it advertised. Elsewhere this path is not found.',
    responses: {
      200: json(HubComputerListSchema, 'The linked computers'),
      403: REFUSALS[403],
      404: REFUSALS[404],
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/hub/computers/{computerId}/agents/{agentId}/chats',
    tags: TAGS,
    summary: "List an agent's chats on a linked computer",
    request: { params: ComputerParams.extend({ agentId: z.string().describe('A Mesh agent id') }) },
    responses: { 200: json(RelayResultBodySchemas['chats.list'], 'The chats'), ...REFUSALS },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/hub/computers/{computerId}/sessions/{sessionId}/messages',
    tags: TAGS,
    summary: 'Send a message to a chat on a linked computer',
    description: 'With `newChat`, the message starts a new chat with that agent under `sessionId`.',
    request: {
      params: SessionParams,
      body: {
        content: {
          'application/json': {
            schema: z.object({
              content: z.string().min(1).max(SESSION_RELAY_MAX_MESSAGE_LENGTH),
              newChat: z.object({ agentId: z.string() }).optional(),
              clientMessageId: z.string().optional(),
              disposition: MessageDispositionSchema.optional(),
            }),
          },
        },
      },
    },
    responses: { 200: json(RelayResultBodySchemas['session.send'], 'Sent'), ...REFUSALS },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/hub/computers/{computerId}/sessions/{sessionId}/interrupt',
    tags: TAGS,
    summary: 'Stop a chat on a linked computer',
    request: { params: SessionParams },
    responses: { 200: json(RelayResultBodySchemas['session.interrupt'], 'Stopped'), ...REFUSALS },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/hub/computers/{computerId}/sessions/{sessionId}/answers',
    tags: TAGS,
    summary: 'Answer a question in a chat on a linked computer',
    description: 'Answers what the agent asked. Approvals are not answered here.',
    request: {
      params: SessionParams,
      body: {
        content: {
          'application/json': {
            schema: z.object({
              toolCallId: z.string(),
              answers: z.record(z.string(), z.string()),
            }),
          },
        },
      },
    },
    responses: {
      200: json(RelayResultBodySchemas['interaction.respond'], 'Answered'),
      ...REFUSALS,
    },
  });
}

/**
 * Register the relayed chat stream. Called after the chat's own stream is
 * registered, so the frames' shared components keep the form that route gives them.
 *
 * @param registry - The server's OpenAPI registry.
 * @param frames - One frame's `data:`: the chat stream's frames, or the `error` event.
 */
export function registerHubComputerStreamOpenApi(
  registry: OpenAPIRegistry,
  frames: z.ZodType
): void {
  registry.registerPath({
    method: 'get',
    path: '/api/hub/computers/{computerId}/sessions/{sessionId}/events',
    operationId: 'hub.stream_session_events',
    tags: TAGS,
    summary: 'Stream a chat on a linked computer',
    description:
      "Server-Sent Events relayed from the computer's own chat stream: each event keeps " +
      'its name, JSON data and resume id. Send the last id back as `Last-Event-ID` (or ' +
      '`?resume=`) to continue after it. An `error` event carries the reason when the computer ' +
      'ends the stream with one.',
    request: {
      params: SessionParams,
      query: z.object({ resume: z.string().optional() }),
    },
    responses: {
      200: {
        description: "The event stream: each frame's `data:` as the chat's own stream sends it",
        content: { 'text/event-stream': { schema: frames } },
      },
      ...REFUSALS,
      406: problemResponse('The request does not accept `text/event-stream` (`not_acceptable`)'),
    },
  });
}
