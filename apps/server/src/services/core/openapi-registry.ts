/**
 * OpenAPI 3.1.0 spec auto-generated from Zod schemas.
 *
 * Registers all API endpoints with descriptions, request/response schemas.
 * Powers `/api/docs` (Scalar UI) and `/api/openapi.json`.
 *
 * @module services/openapi-registry
 */
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { DEFAULT_PORT } from '@dorkos/shared/constants';
import {
  SessionSchema,
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
  SendMessageRequestSchema,
  ApprovalRequestSchema,
  SubmitAnswersRequestSchema,
  ListSessionsQuerySchema,
  BrowseDirectoryQuerySchema,
  BrowseDirectoryResponseSchema,
  CommandsQuerySchema,
  CommandRegistrySchema,
  HealthResponseSchema,
  ErrorResponseSchema,
  HistoryMessageSchema,
  TaskItemSchema,
  PulseScheduleSchema,
  PulseRunSchema,
  CreateScheduleRequestSchema,
  UpdateScheduleRequestSchema,
  ListRunsQuerySchema,
} from '@dorkos/shared/schemas';
import {
  RelayEnvelopeSchema,
  SendMessageRequestSchema as RelaySendMessageRequestSchema,
  MessageListQuerySchema,
  InboxQuerySchema,
  EndpointRegistrationSchema,
} from '@dorkos/shared/relay-schemas';
import { z } from 'zod';

const registry = new OpenAPIRegistry();

// --- Health ---

registry.registerPath({
  method: 'get',
  path: '/api/health',
  tags: ['Health'],
  summary: 'Health check',
  responses: {
    200: {
      description: 'Server is healthy',
      content: { 'application/json': { schema: HealthResponseSchema } },
    },
  },
});

// --- Sessions ---

registry.registerPath({
  method: 'post',
  path: '/api/sessions',
  tags: ['Sessions'],
  summary: 'Create a new session',
  request: {
    body: {
      content: { 'application/json': { schema: CreateSessionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Created session',
      content: { 'application/json': { schema: SessionSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/sessions',
  tags: ['Sessions'],
  summary: 'List all sessions',
  request: {
    query: ListSessionsQuerySchema,
  },
  responses: {
    200: {
      description: 'Array of sessions',
      content: {
        'application/json': { schema: z.array(SessionSchema) },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/sessions/{id}',
  tags: ['Sessions'],
  summary: 'Get session details',
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Session details',
      content: { 'application/json': { schema: SessionSchema } },
    },
    404: {
      description: 'Session not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/sessions/{id}/messages',
  tags: ['Sessions'],
  summary: 'Get message history',
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Message history',
      content: {
        'application/json': {
          schema: z.object({ messages: z.array(HistoryMessageSchema) }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/sessions/{id}/tasks',
  tags: ['Sessions'],
  summary: 'Get task state from session transcript',
  request: {
    params: z.object({ id: z.string().uuid() }),
  },
  responses: {
    200: {
      description: 'Task list',
      content: {
        'application/json': {
          schema: z.object({ tasks: z.array(TaskItemSchema) }),
        },
      },
    },
    404: {
      description: 'Session not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/sessions/{id}',
  tags: ['Sessions'],
  summary: 'Update session settings',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { 'application/json': { schema: UpdateSessionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated session',
      content: { 'application/json': { schema: SessionSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Session not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/sessions/{id}/messages',
  tags: ['Sessions'],
  summary: 'Send message (SSE stream response)',
  description:
    'Sends a message to the Claude agent and streams the response as Server-Sent Events. ' +
    'Event types: text_delta, tool_call_start, tool_call_delta, tool_call_end, tool_result, ' +
    'approval_required, question_prompt, error, done, session_status, task_update. ' +
    'Each SSE message has the format: `event: message\\ndata: {"type":"<type>","data":{...}}\\n\\n`',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { 'application/json': { schema: SendMessageRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'SSE stream of StreamEvent objects',
      content: {
        'text/event-stream': {
          schema: z.string().openapi({ description: 'Server-Sent Events stream' }),
        },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/sessions/{id}/approve',
  tags: ['Sessions'],
  summary: 'Approve pending tool call',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { 'application/json': { schema: ApprovalRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Approved',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }) },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'No pending approval',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/sessions/{id}/deny',
  tags: ['Sessions'],
  summary: 'Deny pending tool call',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { 'application/json': { schema: ApprovalRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Denied',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }) },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'No pending approval',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/sessions/{id}/submit-answers',
  tags: ['Sessions'],
  summary: 'Submit answers for AskUserQuestion',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { 'application/json': { schema: SubmitAnswersRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Answers submitted',
      content: {
        'application/json': { schema: z.object({ ok: z.boolean() }) },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'No pending question',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// --- Directory ---

registry.registerPath({
  method: 'get',
  path: '/api/directory',
  tags: ['Directory'],
  summary: 'Browse directories',
  description:
    'Browse directories on the server filesystem. Restricted to the home directory for security.',
  request: {
    query: BrowseDirectoryQuerySchema,
  },
  responses: {
    200: {
      description: 'Directory listing',
      content: { 'application/json': { schema: BrowseDirectoryResponseSchema } },
    },
    400: {
      description: 'Invalid path',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Access denied (path outside home directory)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Directory not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/directory/default',
  tags: ['Directory'],
  summary: 'Get default working directory',
  description: "Returns the server's default working directory (process.cwd()).",
  responses: {
    200: {
      description: 'Default directory path',
      content: {
        'application/json': {
          schema: z.object({ path: z.string() }),
        },
      },
    },
  },
});

// --- Commands ---

registry.registerPath({
  method: 'get',
  path: '/api/commands',
  tags: ['Commands'],
  summary: 'List all slash commands',
  request: {
    query: CommandsQuerySchema,
  },
  responses: {
    200: {
      description: 'Command registry',
      content: { 'application/json': { schema: CommandRegistrySchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// --- Pulse Scheduler ---

registry.registerPath({
  method: 'get',
  path: '/api/pulse/schedules',
  tags: ['Pulse'],
  summary: 'List all schedules',
  responses: {
    200: {
      description: 'Array of schedules with nextRun',
      content: { 'application/json': { schema: z.array(PulseScheduleSchema) } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/pulse/schedules',
  tags: ['Pulse'],
  summary: 'Create a schedule',
  request: {
    body: {
      content: { 'application/json': { schema: CreateScheduleRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Created schedule',
      content: { 'application/json': { schema: PulseScheduleSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'CWD outside directory boundary',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/pulse/schedules/{id}',
  tags: ['Pulse'],
  summary: 'Update a schedule',
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { 'application/json': { schema: UpdateScheduleRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated schedule',
      content: { 'application/json': { schema: PulseScheduleSchema } },
    },
    404: {
      description: 'Schedule not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/pulse/schedules/{id}',
  tags: ['Pulse'],
  summary: 'Delete a schedule',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Deleted',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    404: {
      description: 'Schedule not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/pulse/schedules/{id}/trigger',
  tags: ['Pulse'],
  summary: 'Manually trigger a schedule run',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    201: {
      description: 'Run started',
      content: { 'application/json': { schema: z.object({ runId: z.string() }) } },
    },
    404: {
      description: 'Schedule not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/pulse/runs',
  tags: ['Pulse'],
  summary: 'List runs',
  request: {
    query: ListRunsQuerySchema,
  },
  responses: {
    200: {
      description: 'Array of runs',
      content: { 'application/json': { schema: z.array(PulseRunSchema) } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/pulse/runs/{id}',
  tags: ['Pulse'],
  summary: 'Get a specific run',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Run details',
      content: { 'application/json': { schema: PulseRunSchema } },
    },
    404: {
      description: 'Run not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/pulse/runs/{id}/cancel',
  tags: ['Pulse'],
  summary: 'Cancel a running job',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Cancelled',
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
    },
    404: {
      description: 'Run not found or not active',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// --- Relay ---

registry.registerPath({
  method: 'post',
  path: '/api/relay/messages',
  tags: ['Relay'],
  summary: 'Send a relay message',
  request: {
    body: {
      content: { 'application/json': { schema: RelaySendMessageRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Message sent',
      content: {
        'application/json': {
          schema: z.object({ messageId: z.string(), deliveredTo: z.number() }),
        },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/relay/messages',
  tags: ['Relay'],
  summary: 'List relay messages',
  request: {
    query: MessageListQuerySchema,
  },
  responses: {
    200: {
      description: 'Array of messages with cursor',
      content: {
        'application/json': {
          schema: z.object({
            messages: z.array(RelayEnvelopeSchema),
            cursor: z.string().optional(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/relay/messages/{id}',
  tags: ['Relay'],
  summary: 'Get a specific message',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Message details',
      content: { 'application/json': { schema: RelayEnvelopeSchema } },
    },
    404: {
      description: 'Message not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/relay/endpoints',
  tags: ['Relay'],
  summary: 'List registered endpoints',
  responses: {
    200: {
      description: 'Array of endpoints',
      content: {
        'application/json': {
          schema: z.array(
            z.object({ subject: z.string(), description: z.string().optional() })
          ),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/relay/endpoints',
  tags: ['Relay'],
  summary: 'Register an endpoint',
  request: {
    body: {
      content: { 'application/json': { schema: EndpointRegistrationSchema } },
    },
  },
  responses: {
    201: {
      description: 'Endpoint registered',
      content: {
        'application/json': {
          schema: z.object({ subject: z.string(), created: z.boolean() }),
        },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/relay/endpoints/{subject}',
  tags: ['Relay'],
  summary: 'Unregister an endpoint',
  request: {
    params: z.object({ subject: z.string() }),
  },
  responses: {
    200: {
      description: 'Endpoint removed',
      content: {
        'application/json': { schema: z.object({ success: z.boolean() }) },
      },
    },
    404: {
      description: 'Endpoint not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/relay/endpoints/{subject}/inbox',
  tags: ['Relay'],
  summary: 'Read inbox for an endpoint',
  request: {
    params: z.object({ subject: z.string() }),
    query: InboxQuerySchema,
  },
  responses: {
    200: {
      description: 'Inbox messages with cursor',
      content: {
        'application/json': {
          schema: z.object({
            messages: z.array(RelayEnvelopeSchema),
            cursor: z.string().optional(),
          }),
        },
      },
    },
    404: {
      description: 'Endpoint not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/relay/dead-letters',
  tags: ['Relay'],
  summary: 'List dead-letter messages',
  request: {
    query: MessageListQuerySchema,
  },
  responses: {
    200: {
      description: 'Dead-letter messages',
      content: {
        'application/json': {
          schema: z.object({
            messages: z.array(RelayEnvelopeSchema),
            cursor: z.string().optional(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/relay/metrics',
  tags: ['Relay'],
  summary: 'Relay system metrics',
  responses: {
    200: {
      description: 'Metrics data',
      content: {
        'application/json': {
          schema: z.object({
            totalMessages: z.number(),
            totalEndpoints: z.number(),
            totalDeadLetters: z.number(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/relay/stream',
  tags: ['Relay'],
  summary: 'SSE event stream for relay activity',
  description:
    'Server-Sent Events stream for real-time relay activity. ' +
    'Supports server-side subject filtering via query param. ' +
    'Event types: relay_connected, relay_message, relay_delivery, relay_dead_letter, relay_metrics.',
  request: {
    query: z.object({
      subject: z.string().optional().openapi({ description: 'Subject pattern filter' }),
    }),
  },
  responses: {
    200: {
      description: 'SSE event stream',
      content: {
        'text/event-stream': {
          schema: z.string().openapi({ description: 'Server-Sent Events stream' }),
        },
      },
    },
  },
});

// --- Generator ---

/** Generate the full OpenAPI 3.1.0 document from registered paths and schemas. */
export function generateOpenAPISpec() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'DorkOS API',
      version: '0.2.0',
      description: 'REST/SSE API for Claude Code sessions, built with the Claude Agent SDK.',
    },
    servers: [{ url: `http://localhost:${process.env.DORKOS_PORT || DEFAULT_PORT}` }],
  });
}
