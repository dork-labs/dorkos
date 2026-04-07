/**
 * OpenAPI 3.1.0 spec auto-generated from Zod schemas.
 *
 * Registers all API endpoints with descriptions, request/response schemas.
 * Powers `/api/docs` (Scalar UI) and `/api/openapi.json`.
 *
 * @module services/openapi-registry
 */
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { env } from '../../env.js';
import {
  SessionSchema,
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
  TaskSchema,
  TaskRunSchema,
  CreateTaskRequestSchema,
  UpdateTaskRequestSchema,
  ListTaskRunsQuerySchema,
  ModelOptionSchema,
} from '@dorkos/shared/schemas';
import {
  RelayEnvelopeSchema,
  SendMessageRequestSchema as RelaySendMessageRequestSchema,
  MessageListQuerySchema,
  InboxQuerySchema,
  EndpointRegistrationSchema,
} from '@dorkos/shared/relay-schemas';
import {
  AgentManifestSchema,
  DiscoveryCandidateSchema,
  DenialRecordSchema,
  DiscoverRequestSchema as MeshDiscoverRequestSchema,
  RegisterAgentRequestSchema,
  DenyRequestSchema as MeshDenyRequestSchema,
  UpdateAgentRequestSchema,
  AgentListQuerySchema,
} from '@dorkos/shared/mesh-schemas';
import { z } from 'zod';

/**
 * Local Zod 4 mirror of `@dorkos/marketplace`'s `PackageTypeSchema`. The
 * package exports a Zod 3 schema that cannot be composed with the server's
 * Zod 4 OpenAPI registry, so we redeclare it here. Keep in sync with
 * `packages/marketplace/src/package-types.ts`.
 */
const LocalPackageTypeSchema = z.enum(['agent', 'plugin', 'skill-pack', 'adapter']);

/**
 * Local Zod 4 mirror of `@dorkos/marketplace`'s `MarketplaceJsonSchema` shape.
 * Only the fields surfaced by the API are modelled — the `passthrough()`
 * behaviour of the source schema is approximated with `.catchall(z.unknown())`
 * so unknown fields still round-trip through OpenAPI.
 */
const LocalMarketplaceJsonSchema = z
  .object({
    name: z.string(),
    plugins: z.array(
      z
        .object({
          name: z.string(),
          source: z.string(),
          description: z.string().optional(),
          version: z.string().optional(),
        })
        .catchall(z.unknown())
    ),
  })
  .catchall(z.unknown());

/**
 * Local Zod 4 mirror of a single marketplace.json entry with the
 * discovered marketplace name tag appended. Returned by
 * `GET /api/marketplace/packages`. Keep in sync with
 * `packages/marketplace/src/marketplace-json-schema.ts` and the
 * `AggregatedPackage` type declared in `routes/marketplace.ts`.
 */
const LocalAggregatedPackageSchema = z
  .object({
    name: z.string(),
    source: z.string(),
    description: z.string().optional(),
    version: z.string().optional(),
    marketplace: z.string(),
  })
  .catchall(z.unknown());

/**
 * Local Zod 4 mirror of `@dorkos/marketplace`'s `MarketplacePackageManifest`.
 * Only the fields surfaced by the HTTP API are modelled. Keep in sync with
 * `packages/marketplace/src/package-manifest-schema.ts`.
 */
const LocalMarketplacePackageManifestSchema = z
  .object({
    schemaVersion: z.number(),
    name: z.string(),
    version: z.string(),
    type: LocalPackageTypeSchema,
    description: z.string().optional(),
  })
  .catchall(z.unknown());

/**
 * Local Zod 4 mirror of the server-side `InstallRequest` minus `name`
 * (the package name is taken from the URL `:name` parameter). Keep in sync
 * with `apps/server/src/services/marketplace/types.ts`.
 */
const LocalInstallRequestBodySchema = z.object({
  marketplace: z.string().optional(),
  source: z.string().optional(),
  force: z.boolean().optional(),
  yes: z.boolean().optional(),
  projectPath: z.string().optional(),
});

/**
 * Local Zod 4 mirror of {@link import('../marketplace/types.js').ConflictReport}.
 * Keep in sync with `apps/server/src/services/marketplace/types.ts`.
 */
const LocalConflictReportSchema = z.object({
  level: z.enum(['error', 'warning']),
  type: z.enum(['package-name', 'slot', 'skill-name', 'task-name', 'cron-collision', 'adapter-id']),
  description: z.string(),
  conflictingPackage: z.string().optional(),
});

/**
 * Local Zod 4 mirror of {@link import('../marketplace/types.js').PermissionPreview}.
 * Keep in sync with `apps/server/src/services/marketplace/types.ts`.
 */
const LocalPermissionPreviewSchema = z.object({
  fileChanges: z.array(
    z.object({
      path: z.string(),
      action: z.enum(['create', 'modify', 'delete']),
    })
  ),
  extensions: z.array(z.object({ id: z.string(), slots: z.array(z.string()) })),
  tasks: z.array(z.object({ name: z.string(), cron: z.string().nullable() })),
  secrets: z.array(
    z.object({
      key: z.string(),
      required: z.boolean(),
      description: z.string().optional(),
    })
  ),
  externalHosts: z.array(z.string()),
  requires: z.array(
    z.object({
      type: z.string(),
      name: z.string(),
      version: z.string().optional(),
      satisfied: z.boolean(),
    })
  ),
  conflicts: z.array(LocalConflictReportSchema),
});

/**
 * Local Zod 4 mirror of {@link import('../marketplace/types.js').InstallResult}.
 * Keep in sync with `apps/server/src/services/marketplace/types.ts`.
 */
const LocalInstallResultSchema = z.object({
  ok: z.boolean(),
  packageName: z.string(),
  version: z.string(),
  type: LocalPackageTypeSchema,
  installPath: z.string(),
  manifest: LocalMarketplacePackageManifestSchema,
  rollbackBranch: z.string().optional(),
  warnings: z.array(z.string()),
});

/** Local Zod 4 mirror of the update flow's per-package advisory check. */
const LocalUpdateCheckResultSchema = z.object({
  packageName: z.string(),
  installedVersion: z.string(),
  latestVersion: z.string(),
  hasUpdate: z.boolean(),
  marketplace: z.string(),
});

/**
 * Local Zod 4 mirror of {@link import('../marketplace/flows/update.js').UpdateResult}.
 * Keep in sync with `apps/server/src/services/marketplace/flows/update.ts`.
 */
const LocalUpdateResultSchema = z.object({
  checks: z.array(LocalUpdateCheckResultSchema),
  applied: z.array(LocalInstallResultSchema),
});

/**
 * Local Zod 4 mirror of {@link import('../marketplace/flows/uninstall.js').UninstallResult}.
 * Keep in sync with `apps/server/src/services/marketplace/flows/uninstall.ts`.
 */
const LocalUninstallResultSchema = z.object({
  ok: z.boolean(),
  packageName: z.string(),
  removedFiles: z.number().int().nonnegative(),
  preservedData: z.array(z.string()),
});

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

// --- Models ---

registry.registerPath({
  method: 'get',
  path: '/api/models',
  tags: ['Models'],
  summary: 'List available Claude models',
  description:
    'Returns models available to the user. Serves SDK-reported models if cached, otherwise returns defaults.',
  responses: {
    200: {
      description: 'List of available models',
      content: {
        'application/json': {
          schema: z.object({ models: z.array(ModelOptionSchema) }),
        },
      },
    },
  },
});

// --- Capabilities ---

const RuntimeCapabilitiesSchema = z.object({
  type: z.string().openapi({ description: 'Runtime identifier, e.g. claude-code' }),
  supportsPermissionModes: z.boolean(),
  supportedPermissionModes: z.array(z.string()).optional(),
  supportsToolApproval: z.boolean(),
  supportsCostTracking: z.boolean(),
  supportsResume: z.boolean(),
  supportsMcp: z.boolean(),
  supportsQuestionPrompt: z.boolean(),
});

registry.registerPath({
  method: 'get',
  path: '/api/capabilities',
  tags: ['Capabilities'],
  summary: 'Get runtime capabilities',
  description:
    'Returns capabilities for all registered runtimes, keyed by type string, ' +
    'along with the default runtime type.',
  responses: {
    200: {
      description: 'Runtime capabilities',
      content: {
        'application/json': {
          schema: z.object({
            capabilities: z.record(z.string(), RuntimeCapabilitiesSchema),
            defaultRuntime: z.string(),
          }),
        },
      },
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

// --- Tasks Scheduler ---

registry.registerPath({
  method: 'get',
  path: '/api/tasks',
  tags: ['Tasks'],
  summary: 'List all schedules',
  responses: {
    200: {
      description: 'Array of schedules with nextRun',
      content: { 'application/json': { schema: z.array(TaskSchema) } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/tasks',
  tags: ['Tasks'],
  summary: 'Create a schedule',
  request: {
    body: {
      content: { 'application/json': { schema: CreateTaskRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Created schedule',
      content: { 'application/json': { schema: TaskSchema } },
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
  path: '/api/tasks/{id}',
  tags: ['Tasks'],
  summary: 'Update a schedule',
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { 'application/json': { schema: UpdateTaskRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated schedule',
      content: { 'application/json': { schema: TaskSchema } },
    },
    404: {
      description: 'Schedule not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/tasks/{id}',
  tags: ['Tasks'],
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
  path: '/api/tasks/{id}/trigger',
  tags: ['Tasks'],
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
  path: '/api/tasks/runs',
  tags: ['Tasks'],
  summary: 'List runs',
  request: {
    query: ListTaskRunsQuerySchema,
  },
  responses: {
    200: {
      description: 'Array of runs',
      content: { 'application/json': { schema: z.array(TaskRunSchema) } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/tasks/runs/{id}',
  tags: ['Tasks'],
  summary: 'Get a specific run',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Run details',
      content: { 'application/json': { schema: TaskRunSchema } },
    },
    404: {
      description: 'Run not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/tasks/runs/{id}/cancel',
  tags: ['Tasks'],
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
          schema: z.array(z.object({ subject: z.string(), description: z.string().optional() })),
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

// --- Mesh ---

registry.registerPath({
  method: 'post',
  path: '/api/mesh/discover',
  tags: ['Mesh'],
  summary: 'Discover mesh agents',
  request: {
    body: {
      content: { 'application/json': { schema: MeshDiscoverRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Discovered candidates',
      content: {
        'application/json': {
          schema: z.object({ candidates: z.array(DiscoveryCandidateSchema) }),
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
  path: '/api/mesh/agents',
  tags: ['Mesh'],
  summary: 'Register a mesh agent',
  request: {
    body: {
      content: { 'application/json': { schema: RegisterAgentRequestSchema } },
    },
  },
  responses: {
    201: {
      description: 'Registered agent',
      content: { 'application/json': { schema: AgentManifestSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/mesh/agents',
  tags: ['Mesh'],
  summary: 'List mesh agents',
  request: {
    query: AgentListQuerySchema,
  },
  responses: {
    200: {
      description: 'Array of agents',
      content: {
        'application/json': {
          schema: z.object({ agents: z.array(AgentManifestSchema) }),
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
  path: '/api/mesh/agents/{id}',
  tags: ['Mesh'],
  summary: 'Get mesh agent',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Agent details',
      content: { 'application/json': { schema: AgentManifestSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/mesh/agents/{id}',
  tags: ['Mesh'],
  summary: 'Update mesh agent',
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: { 'application/json': { schema: UpdateAgentRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Updated agent',
      content: { 'application/json': { schema: AgentManifestSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/mesh/agents/{id}',
  tags: ['Mesh'],
  summary: 'Unregister mesh agent',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Agent removed',
      content: {
        'application/json': { schema: z.object({ success: z.boolean() }) },
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
  path: '/api/mesh/deny',
  tags: ['Mesh'],
  summary: 'Deny a mesh candidate',
  request: {
    body: {
      content: { 'application/json': { schema: MeshDenyRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Candidate denied',
      content: {
        'application/json': { schema: z.object({ success: z.boolean() }) },
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
  path: '/api/mesh/denied',
  tags: ['Mesh'],
  summary: 'List denied mesh candidates',
  responses: {
    200: {
      description: 'Denied candidates',
      content: {
        'application/json': {
          schema: z.object({ denied: z.array(DenialRecordSchema) }),
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
  path: '/api/mesh/denied/{encodedPath}',
  tags: ['Mesh'],
  summary: 'Clear mesh denial',
  request: {
    params: z.object({ encodedPath: z.string() }),
  },
  responses: {
    200: {
      description: 'Denial cleared',
      content: {
        'application/json': { schema: z.object({ success: z.boolean() }) },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// --- Marketplace ---

const MarketplaceSourceSchema = z.object({
  name: z.string(),
  source: z.string(),
  enabled: z.boolean(),
  addedAt: z.string(),
});

const AddMarketplaceSourceBodySchema = z.object({
  name: z.string().min(1).max(128),
  source: z.string().min(1),
  enabled: z.boolean().optional(),
});

const InstalledPackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  type: LocalPackageTypeSchema,
  installPath: z.string(),
  installedFrom: z.string().optional(),
  installedAt: z.string().optional(),
});

const MarketplaceCacheStatusSchema = z.object({
  marketplaces: z.number().int().nonnegative(),
  packages: z.number().int().nonnegative(),
  totalSizeBytes: z.number().int().nonnegative(),
});

const PruneMarketplaceCacheBodySchema = z.object({
  keepLastN: z.number().int().nonnegative().optional(),
});

const PrunedCachedPackageSchema = z.object({
  packageName: z.string(),
  commitSha: z.string(),
  path: z.string(),
  cachedAt: z.string(),
});

const PruneMarketplaceCacheResponseSchema = z.object({
  removed: z.array(PrunedCachedPackageSchema),
  freedBytes: z.number().int().nonnegative(),
});

registry.registerPath({
  method: 'get',
  path: '/api/marketplace/sources',
  tags: ['Marketplace'],
  summary: 'List configured marketplace sources',
  responses: {
    200: {
      description: 'Configured marketplace sources',
      content: {
        'application/json': {
          schema: z.object({ sources: z.array(MarketplaceSourceSchema) }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/marketplace/sources',
  tags: ['Marketplace'],
  summary: 'Add a marketplace source',
  request: {
    body: {
      content: { 'application/json': { schema: AddMarketplaceSourceBodySchema } },
    },
  },
  responses: {
    201: {
      description: 'Source added',
      content: { 'application/json': { schema: MarketplaceSourceSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Duplicate source name',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/marketplace/sources/{name}',
  tags: ['Marketplace'],
  summary: 'Remove a marketplace source',
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    204: { description: 'Source removed' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/marketplace/sources/{name}/refresh',
  tags: ['Marketplace'],
  summary: 'Force refetch of a source marketplace.json',
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    200: {
      description: 'Refreshed marketplace document',
      content: {
        'application/json': {
          schema: z.object({
            marketplace: LocalMarketplaceJsonSchema,
            fetchedAt: z.string(),
          }),
        },
      },
    },
    404: {
      description: 'Source not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    502: {
      description: 'Upstream fetch failure',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/marketplace/installed',
  tags: ['Marketplace'],
  summary: 'List installed marketplace packages',
  responses: {
    200: {
      description: 'Installed packages',
      content: {
        'application/json': {
          schema: z.object({ packages: z.array(InstalledPackageSchema) }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/marketplace/installed/{name}',
  tags: ['Marketplace'],
  summary: 'Get an installed marketplace package',
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    200: {
      description: 'Installed package details',
      content: {
        'application/json': {
          schema: z.object({ package: InstalledPackageSchema }),
        },
      },
    },
    404: {
      description: 'Package not installed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/marketplace/cache',
  tags: ['Marketplace'],
  summary: 'Marketplace cache status',
  responses: {
    200: {
      description: 'Cache counts and total size',
      content: { 'application/json': { schema: MarketplaceCacheStatusSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/marketplace/cache',
  tags: ['Marketplace'],
  summary: 'Clear the marketplace cache',
  responses: {
    204: { description: 'Cache cleared' },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/marketplace/cache/prune',
  tags: ['Marketplace'],
  summary: 'Garbage-collect cached packages, keeping the N most recent per name',
  request: {
    body: {
      content: { 'application/json': { schema: PruneMarketplaceCacheBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Prune result',
      content: { 'application/json': { schema: PruneMarketplaceCacheResponseSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/marketplace/packages',
  tags: ['Marketplace'],
  summary: 'List installable packages (aggregated from every enabled source)',
  responses: {
    200: {
      description: 'Aggregated package list',
      content: {
        'application/json': {
          schema: z.object({ packages: z.array(LocalAggregatedPackageSchema) }),
        },
      },
    },
    500: {
      description: 'Aggregation failure',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/marketplace/packages/{name}',
  tags: ['Marketplace'],
  summary: 'Get package details (fetches, validates, builds a preview)',
  request: {
    params: z.object({ name: z.string() }),
    query: z.object({ marketplace: z.string().optional() }),
  },
  responses: {
    200: {
      description: 'Package manifest, staged path, and permission preview',
      content: {
        'application/json': {
          schema: z.object({
            manifest: LocalMarketplacePackageManifestSchema,
            packagePath: z.string(),
            preview: LocalPermissionPreviewSchema,
          }),
        },
      },
    },
    400: {
      description: 'Validation error or invalid package',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Marketplace or package not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/marketplace/packages/{name}/preview',
  tags: ['Marketplace'],
  summary: 'Build a permission preview without installing',
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: { 'application/json': { schema: LocalInstallRequestBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Permission preview, manifest, and staged path',
      content: {
        'application/json': {
          schema: z.object({
            preview: LocalPermissionPreviewSchema,
            manifest: LocalMarketplacePackageManifestSchema,
            packagePath: z.string(),
          }),
        },
      },
    },
    400: {
      description: 'Validation error or invalid package',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Marketplace or package not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/marketplace/packages/{name}/install',
  tags: ['Marketplace'],
  summary: 'Install a marketplace package',
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: { 'application/json': { schema: LocalInstallRequestBodySchema } },
    },
  },
  responses: {
    200: {
      description: 'Install result from the type-specific flow',
      content: { 'application/json': { schema: LocalInstallResultSchema } },
    },
    400: {
      description: 'Validation error or invalid package',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Marketplace or package not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Install blocked by conflicts',
      content: {
        'application/json': {
          schema: z.object({
            error: z.string(),
            conflicts: z.array(LocalConflictReportSchema),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/marketplace/packages/{name}/uninstall',
  tags: ['Marketplace'],
  summary: 'Uninstall a marketplace package',
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            purge: z.boolean().optional(),
            projectPath: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Uninstall result',
      content: { 'application/json': { schema: LocalUninstallResultSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Package not installed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/marketplace/packages/{name}/update',
  tags: ['Marketplace'],
  summary: 'Advisory update check (pass apply:true to actually update)',
  request: {
    params: z.object({ name: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            apply: z.boolean().optional(),
            projectPath: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Update advisory result (and any applied reinstalls)',
      content: { 'application/json': { schema: LocalUpdateResultSchema } },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Package not installed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// --- Generator ---

/** Generate the full OpenAPI 3.1.0 document from registered paths and schemas. */
export function generateOpenAPISpec(): ReturnType<
  InstanceType<typeof OpenApiGeneratorV31>['generateDocument']
> {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'DorkOS API',
      version: '0.2.0',
      description: 'REST/SSE API for Claude Code sessions, built with the Claude Agent SDK.',
    },
    servers: [{ url: `http://localhost:${env.DORKOS_PORT}` }],
  });
}
