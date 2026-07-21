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
  SessionListResponseSchema,
  RecentSessionsQuerySchema,
  RecentSessionsResponseSchema,
  UpdateSessionRequestSchema,
  SendMessageRequestSchema,
  SendMessageResponseSchema,
  ApprovalRequestSchema,
  SubmitAnswersRequestSchema,
  UiActionRequestSchema,
  McpAppResourceRequestSchema,
  McpAppResourceResponseSchema,
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
  ForkShapeRequestSchema,
} from '@dorkos/shared/schemas';
import {
  RelayEnvelopeSchema,
  SendMessageRequestSchema as RelaySendMessageRequestSchema,
  MessageListQuerySchema,
  InboxQuerySchema,
  EndpointRegistrationSchema,
  RelayFlowEventSchema,
  RelayFlowDirectionSchema,
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
import { SessionSnapshotSchema, SessionEventSchema } from '@dorkos/shared/session-stream';
import { z } from 'zod';

/**
 * Local Zod 4 mirror of `@dorkos/marketplace`'s `PackageTypeSchema`. The
 * package exports a Zod 3 schema that cannot be composed with the server's
 * Zod 4 OpenAPI registry, so we redeclare it here. Keep in sync with
 * `packages/marketplace/src/package-types.ts`.
 */
const LocalPackageTypeSchema = z.enum(['agent', 'plugin', 'skill-pack', 'adapter', 'shape']);

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
    displayName: z.string().optional(),
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

// `relay_flow` is broadcast on the unified `/api/events` SSE stream, which
// (like its `relay_bindings_changed`/`relay_adapters_changed` siblings) has
// no dedicated REST path to hang a response schema off of. Register it as a
// standalone component so the metadata-only wire contract is still
// discoverable in the generated OpenAPI document.
registry.register('RelayFlowDirection', RelayFlowDirectionSchema);
registry.register('RelayFlowEvent', RelayFlowEventSchema);

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
  description:
    'Aggregates sessions across every registered runtime (ADR-0310). Runtimes that fail or time out degrade to `warnings[]` entries with partial results.',
  request: {
    query: ListSessionsQuerySchema,
  },
  responses: {
    200: {
      description: 'Session list envelope (merged across runtimes, sorted by updatedAt desc)',
      content: {
        'application/json': { schema: SessionListResponseSchema },
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
  path: '/api/sessions/recent',
  tags: ['Sessions'],
  summary: 'List recent sessions across all agents',
  description:
    'Fans out session listing across every registered agent (DOR-329), merges by `updatedAt` descending, trims to `limit`, and returns a per-agent latest-activity map plus per-runtime `warnings[]` (ADR-0310).',
  request: {
    query: RecentSessionsQuerySchema,
  },
  responses: {
    200: {
      description: 'Recent sessions envelope with per-agent activity map',
      content: {
        'application/json': { schema: RecentSessionsResponseSchema },
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
  path: '/api/sessions/{id}/events',
  tags: ['Sessions'],
  summary: 'Durable session stream (snapshot → replay → live)',
  description:
    'Always-on Server-Sent Events stream — the single delivery path for session ' +
    'state (spec chat-stream-reconnection, ADR-0264/ADR-0266). NO feature flag or ' +
    '`enableCrossClientSync` gate. On a COLD connect it emits one `snapshot` event ' +
    '(a SessionSnapshot: completed messages, in-progress turn, status, non-expired ' +
    'pending interactions, and the resume `cursor`) then goes live, emitting one ' +
    'SessionEvent per frame. Each LIVE frame is preceded by an `id: <sessionId>-<epoch>-<seq>` ' +
    'line; the browser echoes it back as `Last-Event-ID` on reconnect. On a RESUME ' +
    'connect — `Last-Event-ID: <sessionId>-<epoch>-<seq>` header OR `?after=<cursor>` query — ' +
    'it SKIPS the snapshot and replays only events with `seq` greater than the cursor, ' +
    'then goes live. A cursor the server cannot serve gap-free (mismatched epoch after ' +
    'a restart, or one trimmed past the replay buffer) falls back to the cold ' +
    'snapshot path instead of resuming. A `: keepalive` comment is sent every ~15s and `X-Accel-Buffering: ' +
    'no` defeats proxy buffering. Collapses DOR-73 Path A (pull) + Path B (re-emit) ' +
    'into one snapshot+replay mechanism; the single always-on delivery path.',
  request: {
    params: z.object({ id: z.string().uuid() }),
    query: z.object({
      cwd: z.string().optional().openapi({ description: 'Project directory (boundary-checked).' }),
      after: z
        .string()
        .optional()
        .openapi({ description: 'Resume cursor; replay events with seq greater than this.' }),
    }),
    headers: z.object({
      'Last-Event-ID': z.string().optional().openapi({
        description:
          'Resume token `<sessionId>-<epoch>-<seq>`; replays only the gap. A token from a previous server process (epoch mismatch) or beyond the replay buffer falls back to a cold snapshot.',
      }),
    }),
  },
  responses: {
    200: {
      description:
        'SSE stream. Cold connect: a `snapshot` event then `id:`-framed SessionEvents. ' +
        'Resume connect: replayed-then-live `id:`-framed SessionEvents (no snapshot).',
      content: {
        'text/event-stream': {
          schema: z.union([SessionSnapshotSchema, SessionEventSchema]).openapi({
            description: 'A SessionSnapshot (cold connect) followed by SessionEvent frames.',
          }),
        },
      },
    },
    400: {
      description: 'Invalid session ID',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Session not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
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
  summary: 'Send message (trigger-only)',
  description:
    'TRIGGERS a turn and returns immediately — it does NOT stream tokens (ADR-0264). ' +
    'The turn runs server-side and its events are delivered solely on the durable ' +
    '`GET /api/sessions/{id}/events` stream (the single delivery path). The `202` body ' +
    'carries the CANONICAL session id: for a brand-new session this is the real id ' +
    'assigned during the turn (it differs from the client-supplied id), so the client ' +
    're-keys its URL and `/events` subscription to it. To avoid missing the turn, a ' +
    'client should be subscribed to `/events` before (or concurrently with) this POST.',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { 'application/json': { schema: SendMessageRequestSchema } },
    },
  },
  responses: {
    202: {
      description: 'Turn accepted and started; body carries the canonical session id',
      content: {
        'application/json': { schema: SendMessageResponseSchema },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Session locked by another client',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/sessions/{id}/command-intents/{intent}',
  tags: ['Sessions'],
  summary: 'Trigger a runtime-fulfilled command intent (trigger-only)',
  description:
    'TRIGGERS a RUNTIME-fulfilled command intent (currently `compact`) and returns ' +
    'immediately (DOR-109, ADR-0273/ADR-0264). The runtime expands the neutral intent ' +
    'into its native mechanism (Claude: bare `/compact`; OpenCode: `session.summarize`), ' +
    'and the outcome — a compaction — is delivered solely on the durable ' +
    '`GET /api/sessions/{id}/events` stream (e.g. a `compact_boundary`), NOT in this ' +
    'response. The client-native intents (`clear`, `context`) are handled entirely ' +
    'client-side and never reach this route. Capability-gated: a runtime that does not ' +
    'support the intent (e.g. Codex) returns `422` and the adapter is never called — ' +
    'never a silent no-op. Mirrors the message trigger: `409` SESSION_LOCKED when a turn ' +
    'is already running.',
  request: {
    params: z.object({ id: z.string().uuid(), intent: z.enum(['compact']) }),
    body: {
      description:
        'Optional trailing instructions the user typed after the intent token ' +
        '(e.g. `/compact focus on the API changes`). Forwarded to runtimes whose ' +
        'native mechanism accepts guidance (claude-code); ignored by those whose ' +
        'mechanism takes none (opencode).',
      required: false,
      content: {
        'application/json': {
          schema: z.object({ instructions: z.string().optional() }),
        },
      },
    },
  },
  responses: {
    202: {
      description: 'Intent accepted and started; body carries the session id',
      content: {
        'application/json': { schema: SendMessageResponseSchema },
      },
    },
    400: {
      description: 'Invalid session id or malformed request body',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Session not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Session locked by another client',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    422: {
      description: 'Unknown intent, or the session runtime does not support it',
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

registry.registerPath({
  method: 'post',
  path: '/api/sessions/{id}/ui-action',
  tags: ['Sessions'],
  summary: 'Dispatch a generative-UI widget agent action',
  description:
    'A click on an `agent`-kind widget action. Injects a structured `<ui_action>` block as the next user turn (trigger-only, 202; the turn streams over /events). Mirrors the message trigger: 409 SESSION_LOCKED when a turn is already running.',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { 'application/json': { schema: UiActionRequestSchema } },
    },
  },
  responses: {
    202: {
      description: 'Action accepted; the turn is delivered over /events',
      content: {
        'application/json': { schema: SendMessageResponseSchema },
      },
    },
    400: {
      description: 'Validation error',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Session not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Session is running a turn (locked)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/sessions/{id}/mcp-app/resource',
  tags: ['Sessions'],
  summary: 'Read a ui:// MCP App resource',
  description:
    "Reads a `ui://` MCP App resource (SEP-1865) for client rendering. The server opens its own short-lived MCP client using connection config it captured internally — the stdio/http config never travels to the client. Enforces the `ui://` scheme, `text/html` mime, and that the server belongs to the session's MCP set.",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { 'application/json': { schema: McpAppResourceRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The resource body plus its sandbox metadata',
      content: { 'application/json': { schema: McpAppResourceResponseSchema } },
    },
    400: {
      description: 'Validation error or non-ui:// URI',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Session, server, or captured config not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    415: {
      description: 'Resource is not renderable HTML',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    502: {
      description: 'Upstream MCP read failed',
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

const PermissionModeDescriptorSchema = z.object({
  id: z.string().openapi({ description: 'Runtime-specific permission-mode identifier.' }),
  label: z.string().openapi({ description: 'Display label for UI pickers.' }),
  description: z.string().optional().openapi({
    description: 'Optional helper copy shown beneath the label in rich pickers.',
  }),
});

const RuntimeCapabilitiesSchema = z.object({
  type: z.string().openapi({ description: 'Runtime identifier, e.g. claude-code' }),
  supportsToolApproval: z.boolean(),
  supportsCostTracking: z.boolean(),
  supportsResume: z.boolean(),
  supportsMcp: z.boolean(),
  supportsQuestionPrompt: z.boolean(),
  supportsPlugins: z.boolean().openapi({
    description: 'Whether this runtime can load plugins.',
  }),
  permissionModes: z
    .object({
      supported: z.boolean(),
      values: z.array(PermissionModeDescriptorSchema),
    })
    .openapi({
      description:
        'Structured permission-mode capability. `supported: false, values: []` means no picker is shown.',
    }),
  features: z.record(z.string(), z.unknown()).openapi({
    description: 'Runtime-specific extension point; see ADR 0256.',
  }),
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
  description: "Returns the server's boundary-resolved default working directory.",
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

/** A single derived index row for a relay message (per endpoint). */
const IndexedMessageSchema = z.object({
  id: z.string(),
  subject: z.string(),
  endpointHash: z.string(),
  status: z.enum(['pending', 'delivered', 'failed']),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  sender: z.string().nullable().optional(),
});

/**
 * A message's honest, joined detail: a representative row plus every
 * per-endpoint delivery row sharing the envelope id.
 */
const RelayMessageDetailSchema = IndexedMessageSchema.extend({
  deliveries: z.array(IndexedMessageSchema),
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
      description: 'Message details with per-endpoint delivery breakdown',
      content: { 'application/json': { schema: RelayMessageDetailSchema } },
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
  description:
    'Defaults to `pending` messages only, so budget-rejected `failed` messages never surface ' +
    'next to deliverables unless a caller explicitly opts in via `?status=`.',
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
            messages: z.array(
              z.object({
                id: z.string(),
                subject: z.string(),
                endpointHash: z.string(),
                status: z.enum(['pending', 'delivered', 'failed']),
                createdAt: z.string(),
                expiresAt: z.string().nullable(),
                sender: z.string().nullable().optional(),
                payload: z
                  .unknown()
                  .describe(
                    'Envelope payload read from Maildir; null once the message is acknowledged'
                  ),
              })
            ),
            nextCursor: z.string().optional(),
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

const PackageScopeSchema = z.enum(['global', 'agent-local', 'override']);

const PackageProvidesSchema = z.object({
  commands: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
  hooks: z.boolean(),
});

/**
 * Base installed-package shape returned by the LIST endpoint
 * (`GET /api/marketplace/installed`). One entry PER INSTALLATION — a package
 * installed globally and on two agents yields three entries, each carrying its
 * scope and (for agent scopes) the owning agent's identity. It deliberately
 * omits `provides`: the list route does not run `computeProvides`, so
 * documenting capability counts here would over-promise a field the list
 * response never populates.
 */
const InstalledPackageSchema = z.object({
  name: z.string(),
  version: z.string(),
  type: LocalPackageTypeSchema,
  installPath: z.string(),
  installedFrom: z.string().optional(),
  installedAt: z.string().optional(),
  scope: PackageScopeSchema.optional(),
  agentPath: z.string().optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
});

/**
 * Per-installation shape returned by `GET /api/marketplace/installed/{name}`.
 * Extends the base with `provides` — the capability counts that only the
 * single-package route computes via `computeProvides`.
 */
const InstalledPackageDetailSchema = InstalledPackageSchema.extend({
  provides: PackageProvidesSchema.optional(),
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
  description:
    'Without projectPath: one entry per installation across all scopes (global roots plus ' +
    "every registered agent's local installs), each tagged with scope and agent identity. " +
    'With projectPath: the merged view for that single project — one entry per package name.',
  request: {
    query: z.object({ projectPath: z.string().optional() }),
  },
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
  summary: 'List every installation of a package',
  description:
    'Every installation of the named package across all scopes (global + each agent), ' +
    'each enriched with capability counts (commands, skills, hooks).',
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    200: {
      description: 'Installations of the package',
      content: {
        'application/json': {
          schema: z.object({ installations: z.array(InstalledPackageDetailSchema) }),
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
      description: 'Package manifest, staged path, permission preview, and optional README',
      content: {
        'application/json': {
          schema: z.object({
            manifest: LocalMarketplacePackageManifestSchema,
            packagePath: z.string(),
            preview: LocalPermissionPreviewSchema,
            // Raw README markdown read from the staged clone; omitted when the
            // package ships no README (see routes/marketplace.ts readPackageReadme).
            readme: z.string().optional(),
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

// --- Cloud (device-link) ---

const CloudLinkStateSchema = z.enum(['idle', 'pending', 'linked', 'expired', 'denied', 'unlinked']);

const StartLinkResultSchema = z.object({
  userCode: z
    .string()
    .openapi({ description: 'The 8-character code the human enters at the cloud.' }),
  verificationUri: z.string().openapi({ description: 'Where the human goes to approve the link.' }),
  expiresAt: z.string().openapi({ description: 'ISO timestamp after which the code is dead.' }),
});

const CloudLinkStatusSchema = z.object({
  state: CloudLinkStateSchema,
  accountLabel: z.string().optional(),
  lastHeartbeatAt: z.string().optional(),
});

const CloudSummarySchema = z.object({
  linked: z.boolean(),
  accountLabel: z.string().nullable(),
  lastHeartbeatAt: z.string().nullable(),
});

registry.registerPath({
  method: 'post',
  path: '/api/cloud/link/start',
  tags: ['Cloud'],
  summary: 'Begin the device flow to link this instance to a DorkOS account',
  description:
    'Requests a device code from the DorkOS cloud and starts a background poll. Returns the ' +
    'user code + verification URI for the human to approve; poll GET /api/cloud/link/status for ' +
    'the outcome. Independent of local login (config.auth.enabled).',
  responses: {
    200: {
      description: 'Device codes to display',
      content: { 'application/json': { schema: StartLinkResultSchema } },
    },
    502: {
      description: 'Could not reach the DorkOS cloud',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/cloud/link/status',
  tags: ['Cloud'],
  summary: 'Current device-link flow state',
  responses: {
    200: {
      description: 'Link-flow state machine',
      content: { 'application/json': { schema: CloudLinkStatusSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/cloud/unlink',
  tags: ['Cloud'],
  summary: 'Unlink this instance (best-effort cloud revoke, then clear local state)',
  responses: {
    200: {
      description: 'Unlinked',
      content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
    },
    500: {
      description: 'Unlink failed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/cloud/status',
  tags: ['Cloud'],
  summary: 'Settled linked/unlinked summary for Settings',
  responses: {
    200: {
      description: 'Linked state, account label, and last heartbeat',
      content: { 'application/json': { schema: CloudSummarySchema } },
    },
  },
});

// --- Shapes (DOR-355) ---

/**
 * Local Zod 4 mirror of the resolved Shape chrome (`ShapeLayoutSchema`). The
 * source is the Zod-3 `@dorkos/marketplace` schema, which cannot compose with
 * this Zod-4 registry — keep in sync with `packages/marketplace/manifest-schema.ts`.
 */
const LocalShapeLayoutSchema = z.object({
  sidebarOpen: z.boolean(),
  // A sidebar tab id, bounded. The sidebar tab strip exists only in the embedded
  // (Obsidian) shell; the web cockpit has no strip, so a pinned tab is a no-op
  // there. The `:` is still accepted so old manifests that pinned a namespaced
  // tab keep validating. Mirrors the bounded `sidebarTab` in manifest-schema.ts
  // and `UiSidebarTabSchema` in @dorkos/shared.
  sidebarTab: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/)
    .describe(
      "Sidebar tab id, e.g. a built-in ('overview', 'sessions', 'schedules', " +
        "'connections'). The sidebar tab strip exists only in the embedded " +
        '(Obsidian) app; on the web cockpit switching a sidebar tab is a no-op.'
    )
    .optional(),
  openPanels: z.array(z.enum(['settings', 'tasks', 'relay', 'picker'])),
  focusDashboardSections: z.array(z.string()),
});

/** Local Zod 4 mirror of {@link import('../shapes/apply-shape.js').OfferedAgent}. */
const LocalOfferedAgentSchema = z.object({
  ref: z.string(),
  affinity: z.enum(['suggested', 'default']),
  satisfied: z.boolean(),
  arrival: z.boolean(),
  autoFollow: z.boolean(),
  agentId: z.string().optional(),
  projectPath: z.string().optional(),
  displayName: z.string(),
  template: z.record(z.string(), z.unknown()).optional(),
  scheduleSummary: z.string().optional(),
});

/** Local Zod 4 mirror of {@link import('../shapes/apply-shape.js').ApplyShapeResult}. */
const LocalApplyShapeResultSchema = z
  .object({
    ok: z.boolean(),
    applied: z.object({
      layout: LocalShapeLayoutSchema,
      activatedExtensions: z.array(z.string()),
      deactivatedExtensions: z.array(z.string()).optional(),
      schedulesCreated: z.array(z.string()),
      schedulesRebound: z.array(z.string()),
      schedulesRemoved: z.array(z.string()).optional(),
    }),
    warnings: z.array(z.string()),
    offeredAgents: z.array(LocalOfferedAgentSchema),
  })
  .openapi('ApplyShapeResult');

/** Local Zod 4 mirror of {@link import('../shapes/shape-services.js').InstalledShapeSummary}. */
const LocalInstalledShapeSummarySchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  active: z.boolean(),
  lineage: z
    .object({
      forkedFrom: z.string(),
      forkedFromVersion: z.string().optional(),
      forkedAt: z.string(),
    })
    .optional(),
});

/** Local Zod 4 mirror of {@link import('../shapes/fork.js').ForkShapeResult}. */
const LocalForkShapeResultSchema = z
  .object({
    ok: z.literal(true),
    name: z.string(),
    forkedFrom: z.string(),
    installPath: z.string(),
    manifest: z.record(z.string(), z.unknown()),
  })
  .openapi('ForkShapeResult');

registry.registerPath({
  method: 'get',
  path: '/api/shapes',
  tags: ['Shapes'],
  summary: 'List installed Shapes',
  description:
    'Returns every installed Shape with its display name, active flag (`ui.shapes.active`), and fork lineage.',
  responses: {
    200: {
      description: 'Installed Shapes',
      content: {
        'application/json': {
          schema: z.object({ shapes: z.array(LocalInstalledShapeSummarySchema) }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/shapes/{name}/apply',
  tags: ['Shapes'],
  summary: 'Apply an installed Shape',
  description:
    'Enables the Shape’s extensions, resolves connections, stands up schedules, offers agents (never forces one), and records the active Shape. Only "Shape not installed" is fatal (404); every other missing piece degrades to a `warnings[]` entry. `applied.layout` carries the chrome the client restores without a second fetch (spec §5/§9).',
  request: { params: z.object({ name: z.string() }) },
  responses: {
    200: {
      description:
        'Apply result (chrome + activated extensions + created schedules, warnings, offers)',
      content: { 'application/json': { schema: LocalApplyShapeResultSchema } },
    },
    404: {
      description: 'Shape is not installed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/shapes/{name}/fork',
  tags: ['Shapes'],
  summary: 'Fork an installed Shape',
  description:
    'Clones an installed Shape into a new, independently-editable one and stamps `lineage`. `captureCurrent` snapshots the live arrangement when forking the active Shape.',
  request: {
    params: z.object({ name: z.string() }),
    body: { content: { 'application/json': { schema: ForkShapeRequestSchema } } },
  },
  responses: {
    201: {
      description: 'The forked Shape descriptor',
      content: { 'application/json': { schema: LocalForkShapeResultSchema } },
    },
    404: {
      description: 'Source Shape is not installed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Fork name is invalid or already taken',
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
