import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from '@asteasolutions/zod-to-openapi';
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
} from '@dorkos/shared/schemas';
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
  description: 'Browse directories on the server filesystem. Restricted to the home directory for security.',
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
  description: 'Returns the server\'s default working directory (process.cwd()).',
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

// --- Generator ---

export function generateOpenAPISpec() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'DorkOS API',
      version: '0.1.0',
      description:
        'REST/SSE API for Claude Code sessions, built with the Claude Agent SDK.',
    },
    servers: [{ url: 'http://localhost:6942' }],
  });
}
