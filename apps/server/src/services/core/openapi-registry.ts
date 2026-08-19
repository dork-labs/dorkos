/**
 * OpenAPI 3.1.0 spec auto-generated from Zod schemas.
 *
 * Registers all API endpoints with descriptions, request/response schemas.
 * Powers `/api/docs` (Scalar UI) and `/api/openapi.json`.
 *
 * ## Two sources of paths
 *
 * 1. **Legacy hand-registered paths** — the bulk of this file: each route is
 *    described by a `registry.registerPath(...)` call by hand. Some of these
 *    schemas are Zod-3 mirrors (see the `Local*Schema` block below): the
 *    Zod-3 `@dorkos/marketplace` schemas cannot compose with this Zod-4 /
 *    zod-to-openapi-v8 registry, so they are redeclared here as Zod-4 and kept
 *    in sync by hand.
 * 2. **Registry-projected paths** — every capability that declares an `http`
 *    surface auto-registers its path via {@link registerCapabilitiesInOpenApi}
 *    at the bottom of this module (spec `capability-registry`, task 2.5). New
 *    capabilities appear in `/api/docs` automatically with no edit here; their
 *    schemas are native Zod-4, so no hand-mirroring is ever needed for them.
 *
 * The two sets never overlap: the projection throws at generation time if a
 * capability path collides with a hand-registered one. Migrating the legacy
 * hand-registered paths onto the registry, domain-by-domain, is a tracked
 * hygiene follow-up (not this task) — until then both sources coexist.
 *
 * @module services/openapi-registry
 */
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { env } from '../../env.js';
import {
  PermissionModeSchema,
  SessionSchema,
  SessionListResponseSchema,
  RecentSessionsQuerySchema,
  RecentSessionsResponseSchema,
  SessionDailyCountsQuerySchema,
  SessionDailyCountsResponseSchema,
  UpdateSessionRequestSchema,
  SendMessageRequestSchema,
  SendMessageResponseSchema,
  SessionTriggerResponseSchema,
  SessionQueueResponseSchema,
  UpdateQueuedMessageRequestSchema,
  UpdateQueuedMessageResponseSchema,
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
  CancelTaskRunResponseSchema,
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
  MoveBindingRequestSchema,
  BindingResponseSchema,
  UnclaimedChatListResponseSchema,
  ClaimUnclaimedChatRequestSchema,
  ClaimUnclaimedChatResponseSchema,
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
  TopologyViewSchema,
  UpdateAccessRuleRequestSchema,
  CrossNamespaceRuleSchema,
} from '@dorkos/shared/mesh-schemas';
import {
  AddRoomMemberRequestSchema,
  AuthorRefSchema,
  CreateRoomRequestSchema,
  ListRoomEntriesQuerySchema,
  ListRoomsQuerySchema,
  HaltRoomResponseSchema,
  PostThreadReplyRequestSchema,
  PostToRoomRequestSchema,
  RoomAttachmentUploadResponseSchema,
  RoomSessionsResponseSchema,
  PostToRoomResponseSchema,
  RoomEntryListResponseSchema,
  RoomEventSchema,
  ListThreadsQuerySchema,
  RoomListResponseSchema,
  ThreadListResponseSchema,
  RoomMemberSchema,
  RoomRosterEntrySchema,
  RoomSnapshotSchema,
  RoomWithRosterSchema,
  SetAuthorHandleRequestSchema,
  ToggleReactionRequestSchema,
  ToggleReactionResponseSchema,
  UpdateMembershipRequestSchema,
  UpdateRoomRequestSchema,
} from '@dorkos/shared/room-schemas';
import { ROOM_EXPORT_CONTENT_TYPE, RoomExportLineSchema } from '@dorkos/shared/room-export-schemas';
import { PendingInteractionsResponseSchema } from '@dorkos/shared/interaction-events';
import {
  ReadCursorParamsSchema,
  ReadCursorResponseSchema,
  ReadCursorSchema,
  SetReadCursorPositionRequestSchema,
} from '@dorkos/shared/read-cursor-schemas';
import {
  MemberRoomsResponseSchema,
  ProfileAvatarResponseSchema,
  ProfileUpdateRequestSchema,
  ProfileUpdateResponseSchema,
  TeamRosterResponseSchema,
} from '@dorkos/shared/team-schemas';
import { DeepHealthResponseSchema } from '@dorkos/shared/health-schemas';
import { SessionSnapshotSchema, SessionEventSchema } from '@dorkos/shared/session-stream';
import {
  PendingApprovalsResponseSchema,
  DenyApprovalBodySchema,
  GrantApprovalBodySchema,
  ApprovalDecisionResponseSchema,
  RevokeStandingPermissionResponseSchema,
  StandingPermissionNotRecordedResponseSchema,
  StandingPermissionsResponseSchema,
} from '@dorkos/shared/approval-schemas';
import { registerCapabilitiesInOpenApi } from './capabilities/index.js';
import { composeCapabilityRegistryForDocs } from './self-description/dorkos-registry.js';
import {
  ConnectorToolkitSchema,
  ConnectorRecommendationSchema,
  ConnectorProviderStatusSchema,
  ConnectorConnectStartResponseSchema,
  ConnectorConnectPollResponseSchema,
  ConnectorWarningSchema,
  PublicConnectedAccountSchema,
  SessionConnectorStatusSchema,
  SessionConnectorAttachResultSchema,
  AgentConnectorListResponseSchema,
  AgentConnectorAttachResultSchema,
} from '@dorkos/shared/connector-provider';
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
  hooks: z.array(
    z.object({
      event: z.string(),
      matcher: z.string().optional(),
      command: z.string(),
    })
  ),
  unreadableHooks: z.array(z.object({ path: z.string(), event: z.string().optional() })),
  schedules: z.array(
    z.object({
      name: z.string(),
      cron: z.string().nullable(),
      permissionMode: PermissionModeSchema,
      startsEnabled: z.boolean(),
    })
  ),
  secrets: z.array(
    z.object({
      key: z.string(),
      required: z.boolean(),
      description: z.string().optional(),
    })
  ),
  npmDependencies: z.array(
    z.object({ name: z.string(), range: z.string(), optional: z.boolean().optional() })
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
  dependencyWarnings: z.array(z.string()).optional(),
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

// `relay_flow` is broadcast on the unified `/api/events` WebSocket stream, which
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

registry.registerPath({
  method: 'get',
  path: '/api/health/deep',
  tags: ['Health'],
  summary: 'Deep health checks',
  description:
    'The setup checks that need a running server: room-to-session bindings with no transcript, ' +
    'quarantined relay access rules, unreadable chat-integration entries, relay bindings pointing ' +
    'at a missing adapter or agent, and duplicate agent ids. Always answers 200 — a failing check ' +
    'is data, not an HTTP error. Results are content-free (counts and plain sentences only) and ' +
    'share the `CheckResult` shape `dorkos doctor` renders; `dorkos doctor --deep` merges them ' +
    'into its checklist.',
  responses: {
    200: {
      description: 'One check result per deep check, in a fixed order',
      content: { 'application/json': { schema: DeepHealthResponseSchema } },
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
  path: '/api/sessions/pending-interactions',
  tags: ['Sessions'],
  summary: 'Every prompt waiting on a person',
  description:
    'One envelope per prompt any live session is parked on — a tool approval, a question, or an MCP elicitation — with server-authoritative time left and expired entries already dropped. `roomId` is present only for a session bound to a room. This is the seed a window reads on mount; after that the `interaction_pending` and `interaction_resolved` events on `/api/events` keep it current, so it is never polled. Bounded to live sessions: a projector lives until its session is evicted or the server restarts, so this answers for the recent fleet and not for all history.',
  responses: {
    200: {
      description: 'Every pending prompt, with the room each belongs to when it has one',
      content: { 'application/json': { schema: PendingInteractionsResponseSchema } },
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
  path: '/api/sessions/daily-counts',
  tags: ['Sessions'],
  summary: 'Count sessions started per day across all agents',
  description:
    'Counts the sessions started each local day across every registered agent (DOR-1039), oldest day first. Per-runtime failures degrade to `warnings[]`, which makes the counts a floor rather than a total (ADR-0310).',
  request: {
    query: SessionDailyCountsQuerySchema,
  },
  responses: {
    200: {
      description: 'Machine-wide daily session counts',
      content: {
        'application/json': { schema: SessionDailyCountsResponseSchema },
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
  summary: 'Durable session stream (SSE, or WebSocket at the same path)',
  description:
    'Always-on Server-Sent Events stream — the single delivery path for session ' +
    'state (spec chat-stream-reconnection, ADR-0264/ADR-0266). NO feature flag or ' +
    '`enableCrossClientSync` gate. On a COLD connect it emits one `snapshot` event ' +
    '(a SessionSnapshot: completed messages, in-progress turn, status, non-expired ' +
    'pending interactions, and the resume `cursor`) then goes live, emitting one ' +
    'SessionEvent per frame. Each LIVE frame is preceded by an `id: <sessionId>-<epoch>-<seq>` ' +
    'line; the client echoes it back as `Last-Event-ID` on reconnect. On a RESUME ' +
    'connect it SKIPS the snapshot and replays only events with `seq` greater than ' +
    'the cursor, then goes live. A cursor the server cannot serve gap-free falls back ' +
    'to the cold snapshot path instead of resuming. A `: keepalive` comment is sent ' +
    'every ~15s and `X-Accel-Buffering: no` defeats proxy buffering. ' +
    '**The same path also answers a WebSocket upgrade** (ADR 260805-041016), which is ' +
    'what the DorkOS cockpit uses — a browser allows only ~6 connections per origin ' +
    'and an SSE stream holds one open, so a few windows exhaust them. Identical ' +
    'contract; each message is one JSON text frame `{ event, data, id? }`, the resume ' +
    'cursor rides `?resume=` (a browser `WebSocket` cannot set headers), liveness is a ' +
    '`__heartbeat` frame rather than an SSE comment, and a refusal arrives as WebSocket ' +
    'close code `4000 + status` because a browser cannot read the status of a failed ' +
    'handshake. SSE remains the documented integration contract — see ' +
    '`docs/integrations/sse-protocol.mdx`.',
  request: {
    params: z.object({ id: z.string().uuid() }),
    query: z.object({
      cwd: z.string().optional().openapi({ description: 'Project directory (boundary-checked).' }),
      after: z
        .string()
        .optional()
        .openapi({ description: 'Resume cursor; replay events with seq greater than this.' }),
      resume: z.string().optional().openapi({
        description:
          'Resume token `<sessionId>-<epoch>-<seq>`, for WebSocket clients, which cannot set headers. Same meaning as `Last-Event-ID`; takes precedence over `after`.',
      }),
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
        'Resume connect: replayed-then-live `id:`-framed SessionEvents (no snapshot). ' +
        'A WebSocket upgrade of the same path answers `101` and carries the identical ' +
        'sequence as JSON frames.',
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
  description:
    'Moving an interactive session to a permission mode that never stops to ask ' +
    'requires an acknowledgement. That means any mode the runtime declares at the ' +
    '`autonomy` stop, and any mode it declares with `asks: "never"` and a `reach` ' +
    'other than `"read"` — Codex files such a mode at the middle stop. Satisfy it ' +
    'with `acknowledgedAutonomy: true` on this request, or with the standing ' +
    'record in `ui.autonomyAcknowledgedAt`. Without one the response is `428 ' +
    'AUTONOMY_ACK_REQUIRED` and nothing is persisted — obtain consent and retry ' +
    'the identical request (spec `trust-dial`, decision 5). This is a consent ' +
    'ritual for a person, not a boundary against a caller.',
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
      description: 'Validation error, or a permission mode the runtime does not declare',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Session not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    428: {
      description:
        'A mode that never stops to ask was requested without an acknowledgement ' +
        '(`AUTONOMY_ACK_REQUIRED`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/sessions/{id}/messages',
  tags: ['Sessions'],
  summary: 'Send message (accept-only)',
  description:
    'ACCEPTS a message and returns immediately — it does NOT stream tokens (ADR-0264) ' +
    'and does NOT wait for the session to be free. If the session is idle the turn ' +
    'starts now; if a turn is already running the message joins the session queue and ' +
    'runs when that turn ends. Either way the events are delivered solely on the ' +
    'durable `GET /api/sessions/{id}/events` stream (the single delivery path) — ' +
    '`turn_start` there is the only signal that THIS message actually started running. ' +
    'The `202` body cannot say which of the two happened: `queuePosition` reads `1` ' +
    'both when the turn started immediately and when the message became the sole entry ' +
    'in a queue behind a still-running turn, and `outcome` carries the requested and ' +
    'applied disposition (queue/steer/stage), not whether a turn began. A busy session ' +
    'is never a `409` here — read and edit what is waiting through ' +
    '`/api/sessions/{id}/queue`. The `202` also carries the CANONICAL session id: for a ' +
    'brand-new session this is the real id assigned during the turn (it differs from ' +
    'the client-supplied id), so the client re-keys its URL and `/events` subscription ' +
    'to it. To avoid missing the turn, a client should be subscribed to `/events` ' +
    'before (or concurrently with) this POST.',
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: {
      content: { 'application/json': { schema: SendMessageRequestSchema } },
    },
  },
  responses: {
    202: {
      description: 'Message accepted; body carries the canonical session id and the receipt',
      content: {
        'application/json': { schema: SendMessageResponseSchema },
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
  path: '/api/sessions/{id}/queue',
  tags: ['Sessions'],
  summary: 'List the messages waiting on a session',
  description:
    'The messages accepted for this session that have not run yet, head first. The ' +
    'same list rides the session snapshot on `GET /api/sessions/{id}/events`, so a ' +
    'cockpit never needs this route; it is here for integrations and debugging.',
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "The session's queue, in dispatch order",
      content: { 'application/json': { schema: SessionQueueResponseSchema } },
    },
    400: {
      description: 'Invalid session id',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/sessions/{id}/queue/{messageId}',
  tags: ['Sessions'],
  summary: 'Edit or move a waiting message',
  description:
    "Changes a waiting message's words, its place in the queue, or both. A move names " +
    'another message to land before or after rather than an index, because an index ' +
    'means something different to every window the moment anybody else edits the ' +
    'queue. The queue belongs to the SESSION: any client may edit any message on it, ' +
    'whichever client enqueued it.',
  request: {
    params: z.object({ id: z.string().uuid(), messageId: z.string() }),
    body: {
      content: { 'application/json': { schema: UpdateQueuedMessageRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The edited message and the queue around it',
      content: { 'application/json': { schema: UpdateQueuedMessageResponseSchema } },
    },
    400: {
      description: 'Invalid ids, or a body that asks for no change',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'No such message on this queue (dispatched, removed, or never here)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/sessions/{id}/queue/{messageId}',
  tags: ['Sessions'],
  summary: 'Remove a waiting message',
  description:
    'Takes a waiting message off the queue; it will not run. Any client may remove any ' +
    "message on the session's queue.",
  request: { params: z.object({ id: z.string().uuid(), messageId: z.string() }) },
  responses: {
    200: {
      description: 'The queue as it now stands',
      content: { 'application/json': { schema: SessionQueueResponseSchema } },
    },
    400: {
      description: 'Invalid ids',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'No such message on this queue',
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
    'never a silent no-op. Unlike the message trigger (which queues instead), this ' +
    'route still answers `409` SESSION_LOCKED when a turn is already running: a ' +
    "command intent is not a person's words waiting to be said, so it is refused " +
    'rather than queued.',
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
        'application/json': { schema: SessionTriggerResponseSchema },
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
    "A click on an `agent`-kind widget action. Injects a structured `<ui_action>` block as the next user turn (trigger-only, 202; the turn streams over /events). Unlike the message trigger (which queues instead), this route answers 409 SESSION_LOCKED while the agent is still PRODUCING a turn: a widget click is not a person's words waiting to be said, so it is refused rather than queued. A click that lands after the turn ended is accepted, even if the runtime is still closing that turn's stream behind it.",
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
        'application/json': { schema: SessionTriggerResponseSchema },
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
  stop: z.enum(['ask', 'act', 'autonomy']).openapi({
    description:
      'Which of the three fixed dial positions this mode belongs to: `ask` (stop before ' +
      'changing anything), `act` (work on, stop for the risky parts), `autonomy` (never stop). ' +
      'Clients render the position; they never invent a fourth or rename one.',
  }),
  promise: z.string().openapi({
    description:
      'One plain sentence about what happens under this mode, shown verbatim as the caption ' +
      'beneath the picker. Product copy — the consequence, not the mechanism.',
  }),
  asks: z.enum(['always', 'when-risky', 'never']).openapi({
    description:
      'How often this mode stops to ask the person, as the runtime measures its own behavior. ' +
      'Where it disagrees with `stop`’s canonical expectation (`ask`→always, `act`→when-risky, ' +
      '`autonomy`→never) the surface says so out loud rather than hiding the difference.',
  }),
  reach: z.enum(['read', 'edit', 'workspace', 'everything']).openapi({
    description:
      'How far this mode’s actions can reach, whether or not it asks first: `read` (nothing ' +
      'changes), `edit` (project files), `workspace` (files and commands inside the project), ' +
      '`everything` (no sandbox — the whole machine and the network). With `asks`, decides how ' +
      'loudly a client marks the mode: never-asking plus everything-reaching is the one ' +
      'combination that earns red.',
  }),
  axis: z
    .enum(['trust', 'working'])
    .optional()
    .openapi({
      description:
        'Which question this mode answers: `trust` (how much the agent may do without asking — ' +
        'the modes the three dial positions select between) or `working` (how it goes about the ' +
        'work, whatever the trust level, e.g. Claude’s `plan`). **Absent means `trust`**, so a ' +
        'runtime that says nothing gets the common answer and keeps its place on the dial. ' +
        'Declare `working` only for a mode that is not a point on the trust axis at all.',
    }),
  native: z
    .string()
    .optional()
    .openapi({
      description:
        'The runtime’s own name for this mode when it differs from `id` — e.g. Codex’s ' +
        '`workspace-write`. Shown in detail views; absent when the id is the native name.',
    }),
});

const RuntimeCapabilitiesSchema = z.object({
  type: z.string().openapi({ description: 'Runtime identifier, e.g. claude-code' }),
  supportsToolApproval: z.boolean(),
  supportsCostTracking: z.boolean(),
  supportsResume: z.boolean(),
  supportsMcp: z.boolean(),
  supportsManagedMcpServers: z.boolean().openapi({
    description:
      'Whether DorkOS can inject the agent’s own managed MCP servers into its sessions (distinct from the in-process DorkOS tool server, `supportsMcp`).',
  }),
  supportsQuestionPrompt: z.boolean(),
  supportsPlugins: z.boolean().openapi({
    description: 'Whether this runtime can load plugins.',
  }),
  permissionModes: z
    .object({
      supported: z.boolean(),
      default: z.string().optional().openapi({
        description:
          'Mode id used when a session has no stored preference. Always one of `values[].id`. Absent when the runtime declares none.',
      }),
      values: z.array(PermissionModeDescriptorSchema),
    })
    .openapi({
      description:
        'Structured permission-mode capability. `supported: false, values: []` means no picker is shown.',
    }),
  settings: z
    .object({
      configSection: z.string().nullable().openapi({
        description:
          'Key of this runtime’s section under `runtimes.*` in user config (`claudeCode`, `codex`, `opencode`). `null` when the runtime has no config section, in which case it never appears in `executionDefaults.perRuntime`.',
      }),
      supportsEffort: z.boolean().openapi({
        description:
          'Whether this runtime takes a reasoning-effort setting at all. Per-model support is a separate, catalog-level fact on `ModelOption.supportsEffort`.',
      }),
      sections: z.array(z.object({ kind: z.string() })).openapi({
        description:
          'Ordered bespoke settings sections the runtime declares, by renderer kind (`claude-accounts`, `opencode-power-source`). Unknown kinds render nothing.',
      }),
    })
    .openapi({
      description:
        'Static settings declaration: which config section holds this runtime’s defaults, whether it takes effort, and which bespoke sections its settings card renders.',
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
  summary: 'Stop a running job',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'A runner has the stop request, or the run had already finished',
      content: { 'application/json': { schema: CancelTaskRunResponseSchema } },
    },
    404: {
      description: 'Run not found',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    502: {
      description:
        'The stop request went out and nothing acknowledged it — the run may still be going',
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
  method: 'get',
  path: '/api/mesh/topology',
  tags: ['Mesh'],
  summary: 'Get mesh topology',
  description:
    'Every agent on this machine, grouped by namespace, with the access rules that decide who ' +
    'can message whom. The view is scoped to what the caller can reach: namespaces the caller ' +
    'has no access to are omitted entirely. `openMesh` reports the mesh-wide "let all my agents ' +
    'talk to each other" switch.',
  request: {
    query: z.object({
      namespace: z
        .string()
        .optional()
        .openapi({
          description:
            "The calling agent's namespace, which scopes the view to the namespaces it can " +
            'reach. Defaults to `*`, the unscoped admin view.',
          example: '*',
        }),
    }),
  },
  responses: {
    200: {
      description: 'Topology view scoped to the caller',
      content: { 'application/json': { schema: TopologyViewSchema } },
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/mesh/topology/access',
  tags: ['Mesh'],
  summary: 'Update a mesh access rule',
  description:
    'Grant or revoke one directional access rule between two namespaces — `allow` lets agents ' +
    'in the source namespace message agents in the target one, `deny` takes that grant away. ' +
    'Rules are one-way: allowing `a -> b` does not let `b` answer back.\n\n' +
    '`*` on BOTH sides is the mesh-wide "let all my agents talk to each other" switch: `allow` ' +
    'turns it on, `deny` turns it off. `*` on one side only is rejected with a 400 — it would ' +
    'open far more traffic than the caller asked for.',
  request: {
    body: {
      content: { 'application/json': { schema: UpdateAccessRuleRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The rule as applied',
      content: { 'application/json': { schema: CrossNamespaceRuleSchema } },
    },
    400: {
      description: 'Validation error, including `*` on one side only',
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
  dependencyWarnings: z.array(z.string()).optional(),
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

/**
 * The refusal both package-source WRITE routes answer with when the caller is not
 * the operator (DOR-502). Not an approval gate: there is no token that unlocks it.
 */
const MarketplaceSourceRefusalSchema = z.object({
  error: z.string(),
  code: z.literal('operator_only_marketplace_source'),
  message: z.string(),
});

registry.registerPath({
  method: 'post',
  path: '/api/marketplace/sources',
  tags: ['Marketplace'],
  summary: 'Add a marketplace source (operator only)',
  description:
    'Only the person running DorkOS may add a package source. Any caller that could not decide ' +
    'an approval is refused with 403, which includes one presenting an agent identity, one ' +
    'presenting an approval token, and (with local login on) one with no signed-in identity. ' +
    'There is no approval that unlocks it.',
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
    403: {
      description: 'Caller is not the operator',
      content: { 'application/json': { schema: MarketplaceSourceRefusalSchema } },
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
  summary: 'Remove a marketplace source (operator only)',
  description:
    'Only the person running DorkOS may remove a package source. Any caller that could not ' +
    'decide an approval is refused with 403, which includes one presenting an agent identity, ' +
    'one presenting an approval token, and (with local login on) one with no signed-in ' +
    'identity. There is no approval that unlocks it.',
  request: {
    params: z.object({ name: z.string() }),
  },
  responses: {
    204: { description: 'Source removed' },
    403: {
      description: 'Caller is not the operator',
      content: { 'application/json': { schema: MarketplaceSourceRefusalSchema } },
    },
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
    'Clones an installed Shape into a new, independently-editable one and stamps `lineage`. `captureCurrent` snapshots the live arrangement when forking the active Shape: the currently-enabled extensions (read server-side) plus the caller’s `liveLayout`. `liveLayout` is a PARTIAL chrome snapshot merged field-wise over the source Shape’s `layout` — every field the caller omits keeps the source’s value, so a client never overwrites chrome it cannot observe.',
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

// --- Connectors ---
// Response shapes come straight from `@dorkos/shared/connector-provider` — the
// same schemas the Transport methods and client hooks are typed with, so the
// documented API cannot drift from the one the client consumes.

registry.registerPath({
  method: 'get',
  path: '/api/connectors/providers',
  tags: ['Connectors'],
  summary: 'List connector provider setup statuses',
  description:
    'Reference-free setup state per credential-gated provider: configured/registered booleans, ' +
    'the custody stance with its plain-language disclosure, and — when a configured provider ' +
    'refused to register — the honest error text. Never carries a secret or a credential reference.',
  responses: {
    200: {
      description: 'Provider setup statuses',
      content: {
        'application/json': {
          schema: z.object({ providers: z.array(ConnectorProviderStatusSchema) }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/connectors/providers/{provider}/credential',
  tags: ['Connectors'],
  summary: 'Store a provider vendor key and register the provider live',
  description:
    'Stores the key in the encrypted credential store and reloads the provider — no restart. ' +
    'The secret is never echoed; the response is the fresh provider status.',
  request: {
    params: z.object({ provider: z.string() }),
    body: {
      content: { 'application/json': { schema: z.object({ secret: z.string().min(1) }) } },
    },
  },
  responses: {
    200: {
      description: 'The provider status after the reload',
      content: { 'application/json': { schema: ConnectorProviderStatusSchema } },
    },
    400: {
      description: 'Unknown provider or empty secret',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/connectors/providers/{provider}/credential',
  tags: ['Connectors'],
  summary: 'Remove a provider vendor key (idempotent) and unregister the provider',
  description:
    'Deletes the stored key and reloads the provider, which unregisters it. Idempotent — a ' +
    'missing key still answers 200 with the (unconfigured) status.',
  request: {
    params: z.object({ provider: z.string() }),
  },
  responses: {
    200: {
      description: 'The provider status after the reload',
      content: { 'application/json': { schema: ConnectorProviderStatusSchema } },
    },
    400: {
      description: 'Unknown provider',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/connectors/toolkits',
  tags: ['Connectors'],
  summary: 'List connectable services (aggregated across providers)',
  description:
    'Aggregates `listToolkits()` across every registered connector provider, deduped by slug, ' +
    'degrading one unreachable provider to a `warnings[]` entry (ADR-0310).',
  responses: {
    200: {
      description: 'Connectable services plus per-provider degradation warnings',
      content: {
        'application/json': {
          schema: z.object({
            toolkits: z.array(ConnectorToolkitSchema),
            warnings: z.array(ConnectorWarningSchema),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/connectors/recommend',
  tags: ['Connectors'],
  summary: 'Recommend how to connect a service (relay-adapter > gateway > raw-mcp)',
  description:
    'Returns ranked recommendations for a service, best first: a purpose-built relay adapter ' +
    '(rank 0) outranks a gateway backend (rank 1), which outranks a raw-MCP baseline (rank 2). ' +
    'This is the routing surface the "Connect to Slack" and "Connect to my Gmail" evals assert against.',
  request: {
    query: z.object({ service: z.string() }),
  },
  responses: {
    200: {
      description: 'Ranked connector recommendations (ascending by rank) plus degradation warnings',
      content: {
        'application/json': {
          schema: z.object({
            recommendations: z.array(ConnectorRecommendationSchema),
            warnings: z.array(ConnectorWarningSchema),
          }),
        },
      },
    },
    400: {
      description: 'Missing service query parameter',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/connectors/{provider}/connect',
  tags: ['Connectors'],
  summary: 'Begin a connect flow for a toolkit',
  description:
    'Starts an OAuth/connect flow on the named provider and returns a consent URL plus a ' +
    'pollable flow id. Secrets stay server-side — the response is reference-shaped.',
  request: {
    params: z.object({ provider: z.string() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ toolkit: z.string(), label: z.string().optional() }),
        },
      },
    },
  },
  responses: {
    200: {
      description:
        'Connect started; carries the authorize URL, a pollable flow id, and the custody ' +
        'disclosure to show BEFORE the URL is opened',
      content: { 'application/json': { schema: ConnectorConnectStartResponseSchema } },
    },
    400: {
      description: 'Validation error, unknown toolkit, or a duplicate single-account connect',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Unknown connector provider',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/connectors/flows/{flowId}',
  tags: ['Connectors'],
  summary: 'Poll a connect flow to completion',
  description:
    'Polls an in-flight connect flow. Failure is typed on the result (`status: "failed"`), never ' +
    'thrown. On `connected`, the new account is bound to its owning provider for later routing.',
  request: {
    params: z.object({ flowId: z.string() }),
  },
  responses: {
    200: {
      description:
        'The pollable connect state (pending | connected | failed); on connected the account ' +
        'is public-shaped (provider stripped, custody sentence attached)',
      content: { 'application/json': { schema: ConnectorConnectPollResponseSchema } },
    },
    404: {
      description: 'Unknown connect flow',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/connectors/accounts',
  tags: ['Connectors'],
  summary: 'List connected accounts (aggregated, provider stripped)',
  description:
    'Aggregates connected accounts across providers with per-provider degradation. The server-only ' +
    '`provider` field is stripped and no connection details ever reach the client (spec §Security).',
  request: {
    query: z.object({ toolkit: z.string().optional() }),
  },
  responses: {
    200: {
      description: 'Connected accounts (provider stripped) plus degradation warnings',
      content: {
        'application/json': {
          schema: z.object({
            accounts: z.array(PublicConnectedAccountSchema),
            warnings: z.array(ConnectorWarningSchema),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/connectors/accounts/{accountId}',
  tags: ['Connectors'],
  summary: 'Disconnect an account (idempotent)',
  description:
    'Revokes the account at its owning provider and clears its routing binding. Idempotent — ' +
    'disconnecting an unknown or already-removed id still resolves 204.',
  request: {
    params: z.object({ accountId: z.string() }),
  },
  responses: {
    204: { description: 'Account disconnected (or already absent)' },
  },
});

// --- Session ↔ connector attach/detach (the consent binding) ---

registry.registerPath({
  method: 'get',
  path: '/api/sessions/{id}/connectors',
  tags: ['Connectors'],
  summary: "A session's connector surface (attached accounts + warnings)",
  description:
    'Lists the connected accounts explicitly attached to a session, each with its exposure state, ' +
    'plus per-account warnings for attached accounts that cannot be exposed right now (the ' +
    '`toolServerForAccount` null branch: expired / revoked / unavailable).',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Attached accounts and per-account degradation warnings',
      content: { 'application/json': { schema: SessionConnectorStatusSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/sessions/{id}/connectors/{accountId}',
  tags: ['Connectors'],
  summary: 'Attach a connected account to a session (the consent point)',
  description:
    'Attaches an account to a session so its tools are exposed as an MCP tool server, and ' +
    're-shows the custody disclosure (spec §Detailed Design 3). A known account whose connection ' +
    'resolves null still attaches (consent recorded) but is reported unexposed via a warning; no ' +
    'connection detail ever crosses to the client.',
  request: {
    params: z.object({ id: z.string(), accountId: z.string() }),
  },
  responses: {
    200: {
      description:
        'The account attached; carries its status, the custody disclosure, and any warning',
      content: { 'application/json': { schema: SessionConnectorAttachResultSchema } },
    },
    404: {
      description: 'Unknown connected account',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/sessions/{id}/connectors/{accountId}',
  tags: ['Connectors'],
  summary: 'Detach a connected account from a session (idempotent)',
  description:
    'Removes the consent binding so the account is no longer exposed to the session. Idempotent — ' +
    'detaching an unattached account still resolves 204.',
  request: {
    params: z.object({ id: z.string(), accountId: z.string() }),
  },
  responses: {
    204: { description: 'Account detached (or already absent)' },
  },
});

// --- Agent ↔ connector attach/detach (standing consent) — connection-scoping spec §Part 1 ---

registry.registerPath({
  method: 'get',
  path: '/api/agents/{agentId}/connectors',
  tags: ['Connectors'],
  summary: "An agent's standing connector attachments",
  description:
    'Lists the accounts standingly attached to an agent. Every session of this agent inherits ' +
    'these accounts on its next hydration unless a session-level override says otherwise ' +
    '(precedence: session > agent, no merge).',
  request: {
    params: z.object({ agentId: z.string() }),
  },
  responses: {
    200: {
      description: "The agent's standing attachments",
      content: { 'application/json': { schema: AgentConnectorListResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/agents/{agentId}/connectors/{accountId}',
  tags: ['Connectors'],
  summary: 'Attach an account to an agent, standingly (the consent point)',
  description:
    'Records standing consent for the agent to use this account; re-shows the custody ' +
    'disclosure. Resolution of the connection itself happens per session, at hydration time.',
  request: {
    params: z.object({ agentId: z.string(), accountId: z.string() }),
  },
  responses: {
    200: {
      description: 'The attachment recorded, plus the custody disclosure',
      content: { 'application/json': { schema: AgentConnectorAttachResultSchema } },
    },
    404: {
      description: 'Unknown connected account',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/agents/{agentId}/connectors/{accountId}',
  tags: ['Connectors'],
  summary: 'Detach an account from an agent (idempotent)',
  description:
    'Revokes standing consent. Idempotent — detaching an unattached account still resolves 204.',
  request: {
    params: z.object({ agentId: z.string(), accountId: z.string() }),
  },
  responses: {
    204: { description: 'Account detached (or already absent)' },
  },
});

// --- Binding move (connection-scoping spec §Part 2) ---

registry.registerPath({
  method: 'post',
  path: '/api/relay/bindings/{id}/move',
  tags: ['Relay'],
  summary: 'Re-point an existing binding to a different agent',
  description:
    'Moves the binding in place — same id, same chatId, new agentId — the one narrow ' +
    'exception to "bindings are re-created, not re-pointed." Clears the binding\'s stale ' +
    'session mappings so the next inbound message starts fresh under the new agent.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: MoveBindingRequestSchema } } },
  },
  responses: {
    200: {
      description: 'The re-pointed binding',
      content: { 'application/json': { schema: BindingResponseSchema } },
    },
    400: {
      description: 'Unknown agent',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Unknown binding',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// --- Unclaimed chats — the claim feed (connection-scoping spec §Part 3) ---

registry.registerPath({
  method: 'get',
  path: '/api/relay/unclaimed-chats',
  tags: ['Relay'],
  summary: 'List chats with no binding to route them (default: pending)',
  description:
    'Chats an adapter heard from with no binding — the durable, damped record of what used ' +
    'to be a silent drop. Carries only sender identity metadata, never a message body.',
  request: {
    query: z.object({
      status: z.enum(['pending', 'claimed', 'ignored', 'blocked']).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Matching unclaimed chats',
      content: { 'application/json': { schema: UnclaimedChatListResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/relay/unclaimed-chats/{id}/claim',
  tags: ['Relay'],
  summary: 'Claim an unclaimed chat onto an agent',
  description:
    'Creates a binding through the same uniqueness-checked path a manual binding create ' +
    'uses — a race against a manually created binding for the same chat 409s identically. ' +
    '`bridge: true` is the claim card\'s primary action, "Answer in a channel": claim, ' +
    'binding, and bridge in one call through the same lifecycle "Bridge to a channel" uses. ' +
    'The claim always succeeds when the response is 201; a failed bridge step is reported as ' +
    '`bridgeError` rather than failing the claim.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: ClaimUnclaimedChatRequestSchema } } },
  },
  responses: {
    201: {
      description: 'The binding created from this claim, optionally bridged',
      content: { 'application/json': { schema: ClaimUnclaimedChatResponseSchema } },
    },
    400: {
      description: 'Unknown agent',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'Unknown unclaimed chat',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'The chat was bound by something else in the meantime',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/relay/unclaimed-chats/{id}/ignore',
  tags: ['Relay'],
  summary: 'Mute an unclaimed chat (idempotent)',
  description: 'Future sightings still bump counters, silently — the chat never resurfaces.',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    204: { description: 'Muted' },
    404: {
      description: 'Unknown unclaimed chat',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/relay/unclaimed-chats/{id}/block',
  tags: ['Relay'],
  summary: 'Block an unclaimed chat (idempotent)',
  description: 'Drops all future traffic from this chat recordless — no further row writes.',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    204: { description: 'Blocked' },
    404: {
      description: 'Unknown unclaimed chat',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// --- Approvals (spec `agent-trust` §3.3) ---

registry.registerPath({
  method: 'get',
  path: '/api/approvals/pending',
  tags: ['Approvals'],
  summary: 'List approvals waiting on a person',
  description:
    'Approvals an agent has requested and nobody has decided yet, oldest first. Expired requests ' +
    'are excluded, and no response here ever carries token material.',
  responses: {
    200: {
      description: 'Pending approvals',
      content: { 'application/json': { schema: PendingApprovalsResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/approvals/{id}/grant',
  tags: ['Approvals'],
  summary: 'Allow the requested action',
  description:
    'Grants a pending approval so the requester can spend its token once, on exactly the ' +
    'capability and input the approval is bound to. Deciding is the human half of the gate, and it ' +
    'needs proof of a person rather than the absence of proof of a machine: a caller presenting an ' +
    'agent identity (`X-DorkOS-Agent`) or an approval token (`X-DorkOS-Approval`) is refused in ' +
    'every posture, and when local login is enabled an authenticated user is required. With login ' +
    'disabled DorkOS cannot tell the cockpit apart from a local script, so every decision is ' +
    'recorded in the Activity feed with the posture it was made under.\n\n' +
    'The body accepts a `standing` flag, which also stops DorkOS asking about this agent doing ' +
    'this thing for as long as `approvals.trustWindowMinutes` says. Opening one needs a person ' +
    'signed in to the cockpit, so it needs Require login to be on: with login off there is no ' +
    'session cookie and DorkOS cannot tell the operator from an agent running as the same user. ' +
    'It is refused rather than quietly downgraded to a plain one-time yes, and the refusal comes ' +
    'before anything is granted, so a caller that asked for two things and can only have one gets ' +
    'neither and is told which part failed. On success the response carries the permission that ' +
    'was opened. Re-answering the same question replaces the live permission and starts a fresh ' +
    'window; using a permission never extends it.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: GrantApprovalBodySchema } } },
  },
  responses: {
    200: {
      description: 'Approval granted',
      content: { 'application/json': { schema: ApprovalDecisionResponseSchema } },
    },
    403: {
      description:
        'Refused: an agent cannot decide (`AGENT_CANNOT_DECIDE`), and neither can the caller ' +
        'holding the approval token (`REQUESTER_CANNOT_DECIDE`). For `standing: true`, also when ' +
        'login is off (`standing_grants_require_login`) or the caller has no session cookie ' +
        '(`operator_cookie_required`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Login is enabled and the caller is not signed in (`AUTH_REQUIRED`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'No such approval',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description:
        'Already decided; or `standing: true` was asked for while standing permissions are ' +
        'switched off (`STANDING_GRANTS_DISABLED`), or for an approval that recorded no agent ' +
        'path, so there is no agent to stop asking about (`APPROVAL_HAS_NO_AGENT`). Nothing is ' +
        'granted in the last two cases',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    410: {
      description: 'Expired before it was decided',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description:
        'The one-time yes was recorded but the permission was not ' +
        '(`STANDING_PERMISSION_NOT_RECORDED`). The two are separate writes; this answer carries ' +
        '`approvalId` and `outcome` so a caller can tell it apart from "nothing happened" — ' +
        'retrying the whole call would answer 409, which reads like the permission exists',
      content: {
        'application/json': { schema: StandingPermissionNotRecordedResponseSchema },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/approvals/{id}/deny',
  tags: ['Approvals'],
  summary: 'Refuse the requested action',
  description:
    'Denies a pending approval, with an optional reason the requester sees. Who may decide is ' +
    'exactly as for grant: no agent identity, no approval token, and an authenticated user when ' +
    'local login is enabled.',
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { 'application/json': { schema: DenyApprovalBodySchema } } },
  },
  responses: {
    200: {
      description: 'Approval denied',
      content: { 'application/json': { schema: ApprovalDecisionResponseSchema } },
    },
    403: {
      description:
        'Refused: an agent cannot decide (`AGENT_CANNOT_DECIDE`), and neither can the caller ' +
        'holding the approval token (`REQUESTER_CANNOT_DECIDE`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Login is enabled and the caller is not signed in (`AUTH_REQUIRED`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    400: {
      description: 'Invalid body',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'No such approval',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'Already decided',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    410: {
      description: 'Expired before it was decided',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/approvals/grants',
  tags: ['Approvals'],
  summary: 'List live standing permissions',
  description:
    'The standing permissions that are live right now: which agent, which action, and when each ' +
    'one runs out. A permission nobody can find is a dark pattern, so this is the list the ' +
    'cockpit shows in both places it offers to end one. Expiry is applied here rather than left ' +
    'to a sweep, so a permission whose window has closed is already gone from this list.\n\n' +
    'Authorized like deciding an approval, NOT like reading the pending list, and the difference ' +
    'is deliberate. A pending card is meant to be agent-readable. This list is prospective: it ' +
    'says which irreversible action will go through silently right now and the minute the window ' +
    "shuts, and it names other agents' pairings. So a caller presenting an agent identity or an " +
    'approval token is refused.\n\n' +
    'It carries what the cockpit renders and nothing more. Who opened each permission, when, ' +
    'under which posture, and which card it came from are recorded in the ' +
    '`approval.grant_created` Activity event instead, which is where an audit question belongs.',
  responses: {
    200: {
      description: 'Live standing permissions, soonest to expire first',
      content: { 'application/json': { schema: StandingPermissionsResponseSchema } },
    },
    403: {
      description:
        'Refused: an agent cannot read this (`AGENT_CANNOT_DECIDE`), and neither can the caller ' +
        'holding the approval token (`REQUESTER_CANNOT_DECIDE`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Login is enabled and the caller is not signed in (`AUTH_REQUIRED`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/approvals/grants/{id}',
  tags: ['Approvals'],
  summary: 'End one standing permission',
  description:
    'Ends a standing permission, so DorkOS asks again before the next time that agent runs that ' +
    'action. It does not undo anything that already ran.\n\n' +
    'Ending one NARROWS what an agent may do, so it needs no session cookie — unlike opening one. ' +
    'It still needs proof of a person in the same sense deciding an approval does: a caller ' +
    'presenting an agent identity or an approval token is refused in every posture. A second ' +
    'click answers 404, so the moment a permission ended cannot be rewritten.',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'The permission was ended',
      content: { 'application/json': { schema: RevokeStandingPermissionResponseSchema } },
    },
    403: {
      description:
        'Refused: an agent cannot decide (`AGENT_CANNOT_DECIDE`), and neither can the caller ' +
        'holding the approval token (`REQUESTER_CANNOT_DECIDE`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: {
      description: 'Login is enabled and the caller is not signed in (`AUTH_REQUIRED`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'No permission is live under that id (`UNKNOWN_STANDING_PERMISSION`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// --- Rooms (spec `rooms` §4) ---

/** `:id` on every room path. A ULID, not a UUID — rooms are minted by `ulidx`. */
const RoomIdParams = z.object({ id: z.string().min(1) });
/** `:id` plus the `:authorId` the membership routes address. */
const RoomMemberParams = RoomIdParams.extend({ authorId: z.string().min(1) });
/** `:id` plus the `:entryId` a reaction attaches to — the entry's ULID, not its seq. */
const RoomEntryParams = RoomIdParams.extend({ entryId: z.string().min(1) });
/** `:id` plus the `:attachmentId` a stored file is served under. */
const RoomAttachmentParams = RoomIdParams.extend({ attachmentId: z.string().min(1) });

/** 404 body shared by every room path: an unknown room and one the caller may not see. */
const roomNotFound = {
  description: 'No such room, or the caller may not see it (an agent sees only its own rooms)',
  content: { 'application/json': { schema: ErrorResponseSchema } },
};
/**
 * 401 shared by every path that resolves a room caller.
 *
 * Listed on the paths whose description makes a claim about agent callers, so
 * that claim stays true — the refusal itself is cross-cutting and comes from
 * `resolveCaller` before any route body runs (DOR-1361).
 */
const roomAgentUnverified = {
  description:
    'The caller presented an `X-DorkOS-Agent` token this machine could not verify — revoked, ' +
    'expired, or never minted here (`AGENT_IDENTITY_UNVERIFIED`)',
  content: { 'application/json': { schema: ErrorResponseSchema } },
};
const roomValidationError = {
  description: 'Validation error',
  content: { 'application/json': { schema: ErrorResponseSchema } },
};
const roomOperatorOnly = {
  description: 'Only the local human may change a roster; an agent caller is refused',
  content: { 'application/json': { schema: ErrorResponseSchema } },
};

registry.registerPath({
  method: 'get',
  path: '/api/rooms',
  tags: ['Rooms'],
  summary: 'List rooms visible to the caller',
  description:
    'A human sees every room; an agent presenting a valid `X-DorkOS-Agent` sees only rooms it belongs to, and one presenting a token this machine cannot verify is refused with 401 rather than shown the operator’s list. `unreadCount` is null for a room the caller is not a member of, and `participants` is null for anything that is not a direct message.',
  request: { query: ListRoomsQuerySchema },
  responses: {
    200: {
      description: 'Rooms, newest activity first',
      content: { 'application/json': { schema: RoomListResponseSchema } },
    },
    400: roomValidationError,
    401: roomAgentUnverified,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/rooms/threads',
  tags: ['Rooms'],
  summary: 'List threads the caller takes part in, across every room',
  description:
    "Every thread the caller started or replied in, newest activity first, with the room it lives in, an excerpt of its opening message, its reply count and how many of those replies are above the caller's read cursor. Participation selects a thread and the room's roster permits it: the caller wrote the root or one of the replies, AND is on that room's roster today — so a room they have been removed from contributes no threads at all. There is no follow list and nothing here is stored; the list is derived from the room log on every read. `unreadCount` shares the room's single `(member, room)` cursor, so opening a room clears its threads' counts along with its own.",
  request: { query: ListThreadsQuerySchema },
  responses: {
    200: {
      description: 'Threads, newest activity first',
      content: { 'application/json': { schema: ThreadListResponseSchema } },
    },
    400: roomValidationError,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/rooms',
  tags: ['Rooms'],
  summary: 'Open a channel or a DM',
  description:
    'The room and its seeded roster are written in one transaction, including any agent named by `agentPaths` — so creating a DM is one call and a failed resolve leaves no room behind. A DM may name any number of agents; one gives a one-to-one conversation and several give a group. **Creating a DM is idempotent on its member set**: when a direct message already holds exactly these authors (the creator included, order irrelevant, neither a superset nor a subset), that room is returned instead of a second one being minted, and an archived match is un-archived first. The existing room keeps its own title and its place in the activity order — opening a conversation is not activity in it. Read the status to tell the two apart: **201** means a room was created, **200** means one was already there. The body is identical either way, so the status is the only signal.',
  request: { body: { content: { 'application/json': { schema: CreateRoomRequestSchema } } } },
  responses: {
    201: {
      description: 'A new room, with its roster',
      content: { 'application/json': { schema: RoomWithRosterSchema } },
    },
    200: {
      description:
        'The direct message that already held exactly these members, returned instead of a second one being created (un-archived first if it was archived)',
      content: { 'application/json': { schema: RoomWithRosterSchema } },
    },
    400: roomValidationError,
    403: {
      description: 'An agent caller tried to seed the room with a SECOND agent',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'A live channel already holds that slug',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/rooms/{id}',
  tags: ['Rooms'],
  summary: 'Get one room with its roster',
  request: { params: RoomIdParams },
  responses: {
    200: {
      description: 'The room and its members',
      content: { 'application/json': { schema: RoomWithRosterSchema } },
    },
    404: roomNotFound,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/rooms/{id}/sessions',
  tags: ['Rooms'],
  summary: "Where each of a room's agents does its work",
  description:
    'One `authorId → sessionId` pair per agent that has answered in this room, and nothing else — no session content, no working directory, no status. The narrowness is the point: this exists so a cockpit can turn "Meeting Notes is working on it" into a link you can follow, and a route that answered more would be a second way to read a session, reached through a room. A room the caller cannot see answers 404, exactly as reading the room does. **Only a person may ask** — an agent enumerating its room-mates\' sessions is arbitration this domain has declined, so a caller whose `X-DorkOS-Agent` token resolves to a live agent is refused 403 `PEOPLE_ONLY`, and one whose token does not resolve is refused 401 before the room is looked up at all. A revoked agent is still an agent.',
  request: { params: RoomIdParams },
  responses: {
    200: {
      description: 'The bindings, one per agent that has answered here',
      content: { 'application/json': { schema: RoomSessionsResponseSchema } },
    },
    401: roomAgentUnverified,
    403: {
      description: 'The caller presented an agent identity, which may not ask this (`PEOPLE_ONLY`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: roomNotFound,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/rooms/{id}',
  tags: ['Rooms'],
  summary: 'Update a room title, topic, or archived flag',
  description:
    'Archiving a channel releases its slug. Un-archiving reclaims it, and is refused with 409 when another channel took it meanwhile.',
  request: {
    params: RoomIdParams,
    body: { content: { 'application/json': { schema: UpdateRoomRequestSchema } } },
  },
  responses: {
    200: {
      description: 'The updated room with its roster',
      content: { 'application/json': { schema: RoomWithRosterSchema } },
    },
    400: roomValidationError,
    404: roomNotFound,
    409: {
      description: 'Un-archiving would collide with a live channel holding the slug',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/rooms/{id}/entries',
  tags: ['Rooms'],
  summary: 'Read a page of room history',
  description:
    'Oldest-first within the page. Page backwards with `before=<seq>`. The room log is never trimmed, so any page remains readable.',
  request: { params: RoomIdParams, query: ListRoomEntriesQuerySchema },
  responses: {
    200: {
      description: 'A page of entries',
      content: { 'application/json': { schema: RoomEntryListResponseSchema } },
    },
    400: roomValidationError,
    404: roomNotFound,
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/rooms/{id}/export',
  tags: ['Rooms'],
  summary: "Export a room's whole history as a JSONL file",
  description:
    'Rooms live only in SQLite, so this is the projection that gives them what a file gives you for free: something you can grep, copy, and keep when you leave (DOR-1225). The body is `application/x-ndjson` — one JSON object per line, the same family a session transcript is in — served as a download. Three line types, always in this order: one `RoomExportHeader` (the room, its roster, who exported it and when), then one `RoomExportEntry` per entry in ascending `seq`, then one `RoomExportSummary`. Thread replies ride in the same stream as everything else, since a thread is a relation between entries rather than a room of its own; `threadRootEntryId` puts one back in its thread. **Every author id is resolved inline on the line that uses it** — the message author, everyone it mentioned, and everyone behind each reaction — so one line answers who said what to whom without a reader that holds the header. Attachments are carried by REFERENCE (id, name, size, type and URL), never as bytes. **The last line is the receipt**: a download that dies half-way is a valid JSONL file with nothing inside it saying so, so a reader checks that the final line is a `summary` and that its `entryCount` matches. **Membership gates it**, exactly as it gates `read_room_history` — "not a member" answers as "no such room", so a room id is never a capability. One deliberate difference from that tool: **the join-seq floor is not applied to the operator exporting their own room.** The floor stops a member retroactively reading what was said before they arrived, which is a rule about one participant\'s view; an export is the exit path, and an owner handed a copy of their own room with the first months missing has not been given their data. Everybody else exports strictly above their own `joinedSeq`, and `scope.joinFloorApplied` says which of the two this file is. Read-only: the database stays the truth and nothing reads one of these files back in.',
  request: { params: RoomIdParams },
  responses: {
    200: {
      description: 'The export, one JSON object per line',
      headers: z.object({
        'Content-Disposition': z
          .string()
          .describe(
            'Always `attachment; filename="room-<slug-or-id>-<YYYY-MM-DD>.jsonl"`. Part of the contract, not a courtesy: `dorkos room export` reads the name out of it when no `--out` is given, so a client may rely on the filename being present and quoted. The date is the EXPORT\'s, so two exports of one room a month apart do not overwrite each other.'
          ),
        'X-Content-Type-Options': z
          .string()
          .describe("Always `nosniff` — this is a file of other people's words."),
      }),
      content: { [ROOM_EXPORT_CONTENT_TYPE]: { schema: RoomExportLineSchema } },
    },
    404: roomNotFound,
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/rooms/{id}/entries',
  tags: ['Rooms'],
  summary: 'Post to a room (trigger-only)',
  description:
    'Returns 202 with the entry identity only. The entry itself reaches every reader — including the poster — over `GET /api/rooms/{id}/events`, mirroring `POST /api/sessions/{id}/messages` (ADR-0264). The author is resolved server-side from the caller identity and is never read from the body — an agent presenting a valid `X-DorkOS-Agent` posts as itself, and one presenting a token this machine cannot verify is refused with 401 rather than posting as the operator. Every agent member the post addresses is then triggered, bounded by the cascade guard; their replies arrive on the same stream.',
  request: {
    params: RoomIdParams,
    body: { content: { 'application/json': { schema: PostToRoomRequestSchema } } },
  },
  responses: {
    202: {
      description: 'Accepted; delivery rides the room SSE stream',
      content: { 'application/json': { schema: PostToRoomResponseSchema } },
    },
    400: roomValidationError,
    401: roomAgentUnverified,
    404: roomNotFound,
    409: {
      description: 'The room is archived',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/rooms/{id}/attachments',
  tags: ['Rooms'],
  summary: 'Upload files into a room, before the message that carries them',
  description:
    "Multipart, field name `files`. Only a person who is a member of the room may upload; an agent is refused BEFORE its bytes are read — 403 when its token resolves to a live agent, 401 when it does not — because an agent shares files by writing them into its own working directory. Limits come from the `uploads` section of user config — the same limits chat uses. Every field on the stored record is server-derived: the filename is sanitized, the size is what landed, and `preview` is set ONLY when the MAGIC BYTES are PNG, JPEG or WebP — the filename and the `Content-Type` the client claims are not evidence, since both are written by whoever is uploading. That single field decides whether `GET` will ever serve the file inline, which is what keeps an uploaded `.html` or SVG from rendering as a document on the cockpit's own origin. The response carries one `RoomAttachment` per file, in request order; a following `POST /api/rooms/{id}/entries` names them by id in `attachmentIds`, and the server binds them to the entry inside the entry's own transaction, so the message and its files land together or not at all.",
  request: {
    params: RoomIdParams,
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            files: z.array(z.string().openapi({ type: 'string', format: 'binary' })),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Stored; ids to reference in the post that follows',
      content: { 'application/json': { schema: RoomAttachmentUploadResponseSchema } },
    },
    400: roomValidationError,
    401: roomAgentUnverified,
    403: {
      description: 'Only a person can attach a file; an agent caller is refused',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: roomNotFound,
    409: {
      description: 'The room is archived',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    413: {
      description: 'A file is larger than the configured limit, refused while still being read',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    415: {
      description: "A file's type is not in the configured allowlist",
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/rooms/{id}/attachments/{attachmentId}',
  tags: ['Rooms'],
  summary: 'Download one of a room’s files',
  description:
    'A file that is already ON a message is readable by anyone who may read that message; a file that has been uploaded and not yet posted is readable only by whoever uploaded it, so nobody can enumerate a stranger\'s staging area. Every other case — wrong room, no such id, somebody else\'s unposted file — answers 404 rather than 403, so existence is never leaked. `Content-Type` and `Content-Disposition` are decided by the stored `preview` and by nothing else: a byte-verified image is served as what it is, `inline`; everything else is `application/octet-stream` as an `attachment`, whatever it was uploaded as. `X-Content-Type-Options: nosniff` rides along on both. The response carries a WEAK `ETag` — `W/"<size>-<mtime>"`, from one `stat` — so a conditional request with `If-None-Match` answers 304 without the server reading a single byte. Weak because it is honest: size plus modification time cannot promise byte equality the way a content hash can. In practice it is stronger than the label suggests, because an attachment is written once under a freshly minted id and never rewritten. Hashing the content instead would have meant reading the whole file into memory to decide whether to send it, which is the opposite of what a conditional request is for.',
  request: { params: RoomAttachmentParams },
  responses: {
    200: {
      description: 'The bytes, typed and dispositioned by what they were verified to be',
      content: { '*/*': { schema: { type: 'string', format: 'binary' } } },
    },
    304: { description: 'Not modified — the `If-None-Match` ETag still matches' },
    400: {
      description: 'The id could never name a stored file',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'No such file, or not yours to read',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/rooms/{id}/entries/{entryId}/reactions',
  tags: ['Rooms'],
  summary: 'React to an entry, or take a reaction back',
  description:
    'Keyed on `(you, this entry, this emoji)`, which holds at most one reaction however many times anyone asks. With no `on` in the body this is a TOGGLE — the same emoji again removes it — which is what a click means and is exactly not idempotent, hence POST rather than PUT. **Do not retry a bare toggle**: a timeout does not say whether the write landed, and re-sending the flip undoes it. Send `{"emoji": "👍", "on": true}` or `on: false` instead, which names the state you want and is safe to repeat; `on: true` on a reaction you already have does not restamp it, so the pill keeps its place in a row ordered by first appearance. Returns 202 with which way it went and your recomputed quick row — but **treat the event stream as authoritative, not this body**: the entry\'s new reaction set reaches every reader, this one included, over `GET /api/rooms/{id}/events` as a `reaction` frame carrying the WHOLE current set, while this body says only what YOUR call did and somebody else may have reacted in between. **A reaction is costless by design**: it takes no turn, writes no entry, sends no notice, starts no cascade and does not move the room in the activity order. When it lands on an agent-authored entry the agent is told on its next turn, in its room context, as an acknowledgment it never replies to. **An agent may react too** — ADR 260814-195522 reverses etiquette E16b, so what bounds a machine here is an hourly ceiling per room (`REACTION_RATE_LIMITED`, 429) rather than what kind of author it is, and the pill it leaves carries the AGENT\'s id. A caller presenting an `X-DorkOS-Agent` token this machine cannot verify is refused with 401: a revoked agent has no allowance to spend.',
  request: {
    params: RoomEntryParams,
    body: { content: { 'application/json': { schema: ToggleReactionRequestSchema } } },
  },
  responses: {
    202: {
      description: "Accepted; the entry's new reaction set rides the room SSE stream",
      content: { 'application/json': { schema: ToggleReactionResponseSchema } },
    },
    400: {
      description: 'Validation error, including anything that is not a single emoji',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: roomAgentUnverified,
    404: {
      description: 'No such room, not a member of it, or no such entry in it',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'The room is archived',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    429: {
      description:
        'This agent has spent its hourly reaction allowance in this room ' +
        '(`REACTION_RATE_LIMITED`). People are never counted',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/rooms/{id}/members',
  tags: ['Rooms'],
  summary: 'Add a member to a room',
  description:
    'Add by `authorId`, or by `agentPath` to mint an agent author on first use. `responseMode` is seeded from the room kind when omitted. Operator-only: an agent that could widen a room-mate addressing could drive replies nobody asked for.',
  request: {
    params: RoomIdParams,
    body: { content: { 'application/json': { schema: AddRoomMemberRequestSchema } } },
  },
  responses: {
    201: {
      description: 'The stored membership with its author resolved',
      content: { 'application/json': { schema: RoomRosterEntrySchema } },
    },
    400: roomValidationError,
    403: roomOperatorOnly,
    404: {
      description: 'No such room, no such author, or no agent registered at that path',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/rooms/{id}/members/{authorId}',
  tags: ['Rooms'],
  summary: "Change a member's per-room response mode",
  description:
    'Operator-only. `responseMode` decides when an agent answers without being addressed, so an agent able to turn it up on a room-mate could manufacture a conversation.',
  request: {
    params: RoomMemberParams,
    body: { content: { 'application/json': { schema: UpdateMembershipRequestSchema } } },
  },
  responses: {
    200: {
      description: 'The updated membership',
      content: { 'application/json': { schema: RoomRosterEntrySchema } },
    },
    400: roomValidationError,
    403: roomOperatorOnly,
    404: {
      description: 'No such room, or not a member of it',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/rooms/{id}/members/{authorId}',
  tags: ['Rooms'],
  summary: 'Remove a member from a room',
  description: "Operator-only. Also drops that member's per-room session binding.",
  request: { params: RoomMemberParams },
  responses: {
    204: { description: 'Member removed' },
    403: roomOperatorOnly,
    404: {
      description: 'No such room, or not a member of it',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/rooms/authors/{authorId}/handle',
  tags: ['Rooms'],
  summary: "Set or clear an author's handle",
  description:
    'A handle is what somebody types after an `@` to reach exactly one author: lowercase, 2–32 characters of `[a-z0-9._-]`, starting and ending alphanumeric, and unique across this install (case-folded). The server normalizes what it is given, so a client that skipped its own check cannot store something the grammar forbids, and an empty string clears the handle. **Human-initiated only** — any caller presenting `X-DorkOS-Agent` is refused, 403 when the token resolves to a live agent and 401 when it does not. There is no MCP tool and no capability for this: an agent able to rename itself in a loop would grow the tombstone table a row at a time forever, and removing the mechanism beats throttling it. A released handle stays reserved to the author who gave it up; they may take it back, and nobody else may take it at all.',
  request: {
    params: z.object({ authorId: z.string().min(1) }),
    body: { content: { 'application/json': { schema: SetAuthorHandleRequestSchema } } },
  },
  responses: {
    200: {
      description: 'The author, with its handle as stored',
      content: { 'application/json': { schema: AuthorRefSchema } },
    },
    400: {
      description: 'The handle fails the grammar (`INVALID_HANDLE`), or the body is malformed',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: roomAgentUnverified,
    403: {
      description: 'An agent caller tried to change a handle (`OPERATOR_ONLY`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'No author carries that id (`MEMBER_NOT_FOUND`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description:
        'The handle is live on another author (`HANDLE_TAKEN`), or reserved to one — a handle they released, or one of the seeded broadcast words `everyone`/`here`/`channel` (`HANDLE_RESERVED`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/rooms/{id}/threads',
  tags: ['Rooms'],
  summary: 'Reply inside a thread',
  description:
    'A thread is a relation between entries in this room, not a room of its own, so there is nothing to create first: this posts the first reply and every later one. The reply keeps the room roster, the room read cursor and the room budget, and answers to the same rules any post does — the caller must be a member, and an archived room refuses. One level only: a reply whose root is itself a reply is refused with 400 (`NESTED_THREAD`). Trigger-only, like `POST /api/rooms/{id}/entries`: 202 with the entry identity, while the entry itself rides the room event stream to every reader.',
  request: {
    params: RoomIdParams,
    body: { content: { 'application/json': { schema: PostThreadReplyRequestSchema } } },
  },
  responses: {
    202: {
      description: 'Accepted; the entry reaches readers over the room event stream',
      content: { 'application/json': { schema: PostToRoomResponseSchema } },
    },
    400: {
      description: 'Validation error, or the root entry is itself a reply',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'No such room, not a member of it, or no such entry in it',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    409: {
      description: 'The room is archived',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/rooms/{id}/halt',
  tags: ['Rooms'],
  summary: 'Stop every turn running in a room',
  description:
    'A control action, not a message. It interrupts every in-flight agent turn in the room, drops the working indicators, and writes one `halted` notice everyone in the room can see. Stopping is NEVER inferred from message text: a person who sends the word "stop" as a message has sent a message, and the agents answer it like any other. Takes no body. Only a person may call it — an agent stopping its room-mates would be arbitration this domain has declined — so a live agent is refused 403 and a caller whose agent token does not verify is refused 401. Allowed on an archived room, unlike every other write here: archiving stops a room gaining messages, and a turn that was already running is still running.',
  request: { params: RoomIdParams },
  responses: {
    200: {
      description: 'How many in-flight turns were interrupted; 0 when the room was idle',
      content: { 'application/json': { schema: HaltRoomResponseSchema } },
    },
    401: roomAgentUnverified,
    403: {
      description: 'The caller is not a person; agents do not stop each other',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'No such room, or not a member of it',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/rooms/{id}/events',
  tags: ['Rooms'],
  summary: 'Durable room event stream (SSE, or WebSocket at the same path)',
  description:
    "Snapshot on a cold connect, gap-free replay from `Last-Event-ID`, then live. The same path also answers a WebSocket upgrade, which is what the cockpit uses (ADR 260805-041016) — identical contract, each message a JSON text frame, resuming from `?resume=`, with refusals as close code `4000 + status`. Event ids are `<roomId>-<epoch>-<seq>`; a cursor from another room or another server process falls back to a cold connect. The `snapshot` frame carries `RoomSnapshot`; every later frame is a `RoomEvent` — a durable `entry`, an ephemeral `signal` that is never replayed, or a `reaction`. A `reaction` frame is durable state and still carries no `id:` line, because the cursor is the highest ENTRY a reader holds and a second number in one header is a cursor clients get wrong: instead each frame carries an entry's WHOLE current reaction set, so one missed frame self-heals on the next. A resume emits one of these for EVERY entry in the trailing window after the replay, empty sets included — that is what corrects a reaction somebody took back while this reader was disconnected, which nothing else on the wire could say. Every entry on every path — the snapshot, the replay, a live `entry` frame — arrives with its own `reactions` attached.",
  request: {
    params: RoomIdParams,
    query: z.object({
      after: z.coerce
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Resume cursor; ignored past the end of the log.'),
      resume: z
        .string()
        .optional()
        .describe(
          'Resume token `<roomId>-<epoch>-<seq>`. Takes precedence over `after`; a token from another room or another server process falls back to a cold connect.'
        ),
    }),
  },
  responses: {
    200: {
      description:
        'SSE stream: a RoomSnapshot frame on a cold connect, then RoomEvent frames. A ' +
        'WebSocket upgrade of the same path answers `101` with the identical sequence.',
      content: {
        'text/event-stream': { schema: z.union([RoomSnapshotSchema, RoomEventSchema]) },
      },
    },
    404: roomNotFound,
  },
});

// --- Read state (spec `team-room-home` §D4, ADR 260808-140956) ---

registry.registerPath({
  method: 'put',
  path: '/api/read-cursors/{kind}/{id}',
  tags: ['Read state'],
  summary: "Advance the caller's read cursor in one thread",
  description:
    'The one write path onto read state, for every kind of thread there is: a room, an agent ' +
    'session, or the inbox. Monotonic — a value at or below the stored one is ignored, so a stale ' +
    'client on a second device cannot un-read a thread for the first one. The response is always ' +
    'the cursor as it now stands, which is the higher of the stored value and the requested one, ' +
    'so a refused write answers with what still holds rather than with an error. **Every write ' +
    'that actually moves the cursor broadcasts `read_cursor` on `GET /api/events`**, carrying the ' +
    'user, the kind, the thread and the new position; a write that changes nothing broadcasts ' +
    "nothing. The cursor written is always the caller's own — there is no way to name a user in " +
    "this request, and therefore no way to read or move anybody else's read state. **Only people " +
    'have read state here** — a caller the server resolves as an agent (one presenting a valid ' +
    '`X-DorkOS-Agent`) is refused with 403 `PEOPLE_ONLY`, and one whose token does not verify is ' +
    'refused with 401, because what an agent has been shown is ' +
    'the room-MEMBERSHIP cursor and not this one — advanced by the ambient participation loop as ' +
    'entries are delivered to it, and reachable through no route at all. **A `room` cursor is ' +
    'written through the rooms domain**, so the caller must be able to see the room (404 ' +
    '`ROOM_NOT_FOUND` / `MEMBER_NOT_FOUND` otherwise), and the broadcast carries the unread count ' +
    'the room list redraws from. A `session` or `inbox` cursor names a thread this server cannot ' +
    'check and is stored as given.',
  request: {
    params: ReadCursorParamsSchema,
    body: {
      content: { 'application/json': { schema: SetReadCursorPositionRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The cursor as it now stands',
      content: { 'application/json': { schema: ReadCursorSchema } },
    },
    400: {
      description:
        'Unknown `kind`, empty `id`, missing body, or a `lastReadSeq` that is not a non-negative integer',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: roomAgentUnverified,
    403: {
      description: 'The caller resolved to an agent, which has no read state here (`PEOPLE_ONLY`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description:
        'Only for `kind: room` — no such room, or the caller is not a member of it. A `session` ' +
        'or `inbox` thread is never checked for existence, so those kinds cannot answer 404',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/read-cursors/{kind}/{id}',
  tags: ['Read state'],
  summary: "Read the caller's own position in one thread",
  description:
    'Where this person left off in one thread — the read half of the PUT, and the way a screen ' +
    'that has just opened knows where to draw the unread rule before any event arrives. A thread ' +
    'the caller has never read answers `{ "cursor": null }` with a 200, because never-read is ' +
    'the state every thread starts in rather than a missing resource; `null` is also distinct ' +
    'from a stored `0`, which is a thread read up to its own beginning. As with the write, the ' +
    "cursor is always the caller's own — there is no way to name a user — and an agent caller is " +
    'refused with 403 `PEOPLE_ONLY`, or with 401 when its token does not verify.',
  request: { params: ReadCursorParamsSchema },
  responses: {
    200: {
      description: "The caller's cursor, or null when they have never read this thread",
      content: { 'application/json': { schema: ReadCursorResponseSchema } },
    },
    400: {
      description: 'Unknown `kind` or empty `id`',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: roomAgentUnverified,
    403: {
      description: 'The caller resolved to an agent, which has no read state here (`PEOPLE_ONLY`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// --- Team (spec `identity-consistency` §W2.2, ADR 260806-222535) ---

registry.registerPath({
  method: 'get',
  path: '/api/team',
  tags: ['Team'],
  summary: 'List every identity on this install',
  description:
    'One read-only aggregation over the `authors` registry (people) and the mesh cache (agents). ' +
    'It writes nothing and mints nothing: every id it returns already existed, which is why there ' +
    'is no POST here (ADR 260806-222535). Exactly one row carries `isSelf: true` — the operator ' +
    'reading it, under their real name rather than the room-scoped `You` — and `person.email` is ' +
    'carried on that row and no other. `ownerId` is derived at read time: the operator on every ' +
    'locally-registered agent, `null` on a system agent and on every person. `agent.recentlyActive` ' +
    'restates `healthStatus === "active"`, which the mesh defines as "seen within the last hour" — ' +
    'it is not a live-turn signal. Degradation follows ADR-0310, and covers EVERY read rather than ' +
    'just the two registries: `authors`, `agents`, `operator` (the account lookup) and `config` each ' +
    'contribute a `warnings[]` entry on failure while the rest still return, so a roster that cannot ' +
    'say your name still lists your agents and this endpoint has no 500 path through its sources. ' +
    '`warnings` is omitted entirely when every source read cleanly — never sent as `[]`.',
  responses: {
    200: {
      description: 'Roster envelope: the operator first, then people, then agents',
      content: { 'application/json': { schema: TeamRosterResponseSchema } },
    },
    500: {
      description: 'The roster itself could not be assembled (not a per-source failure)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/team/{memberId}/rooms',
  tags: ['Team'],
  summary: 'List the rooms one roster member is in',
  description:
    'Where a member can be found, for their profile (spec `profile-unification` §3.2). ' +
    '`memberId` is a ROSTER id, which is why this lives under `/api/team` rather than ' +
    '`/api/rooms`: for a person it is their `authors` row id, and for an agent — a system ' +
    'agent included — it is the mesh manifest ULID, whose author row is found by the ' +
    'generation stamp `minted_for_manifest_id`. An agent’s own author id is deliberately ' +
    'NOT accepted; the roster never hands one out. Archived rooms are left out, and rooms come ' +
    'back newest activity first. Each room carries the three fields a renderer needs to name it — ' +
    '`kind`, `slug` and `name` (the title) — rather than a pre-rendered `#general`: a channel ' +
    'reads as its slug and a direct message as its title, and the client owns that rule in one ' +
    'place. `slug` is null on a DM. A member who is in no rooms answers 200 with an empty list — ' +
    'only an id this install has never heard of is a 404, so a client can tell "nobody by that ' +
    'name" from "nowhere yet". A newly registered agent has no author row until it is first in ' +
    'a room, and is answered as the empty list rather than as unknown. ' +
    '**People only.** The path takes any member’s id, so an agent that could call it would read ' +
    'the title of every direct message the operator has — the membership scope the rooms domain ' +
    'imposes, walked around by asking about somebody else. An agent presenting `X-DorkOS-Agent` ' +
    'is refused (403 `PEOPLE_ONLY`), the same way read state is.',
  request: {
    params: z.object({ memberId: z.string().min(1) }),
  },
  responses: {
    200: {
      description: 'The member’s rooms, newest activity first',
      content: { 'application/json': { schema: MemberRoomsResponseSchema } },
    },
    403: {
      description: 'The caller is an agent — a profile is read by people (`PEOPLE_ONLY`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    404: {
      description: 'No member on this install carries that id (`MEMBER_NOT_FOUND`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    500: {
      description: 'The membership read failed (`MEMBER_ROOMS_FAILED`)',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// --- Profile (spec `identity-consistency` §W3.3, §W3.5, ADR 260806-222546) ---

registry.registerPath({
  method: 'patch',
  path: '/api/profile',
  tags: ['Profile'],
  summary: 'Set what the operator wants to be called',
  description:
    'Writes the name to the two sources the roster actually reads above the author record: the ' +
    'account record (`user.name`), when this install has an account at all, and the stored ' +
    'profile (`config.profile.displayName`), always. It deliberately does NOT write ' +
    '`authors.display_name`: on an install with login off that column is refreshed back to the ' +
    'literal "You" on the next request, and on an install with an account writing it would ' +
    'relabel every message the person has ever posted rather than label them going forward. ' +
    'Only a person may call this; an agent presenting a valid identity token is refused (403), and ' +
    'one whose token this machine cannot verify is refused (401).',
  request: {
    body: { content: { 'application/json': { schema: ProfileUpdateRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Saved. The name the roster will now show.',
      content: { 'application/json': { schema: ProfileUpdateResponseSchema } },
    },
    400: {
      description: 'The name is empty or longer than 80 characters',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: roomAgentUnverified,
    403: {
      description: 'The caller is an agent — a person’s name is theirs to set',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/profile/avatar',
  tags: ['Profile'],
  summary: "Set the operator's profile photo",
  description:
    'Multipart upload of a single image in the `avatar` field. The photo replaces whatever was ' +
    'there, in any format. Three refusals, all before anything is stored: over 2 MB (413), and ' +
    'anything whose MAGIC BYTES are not PNG, JPEG or WebP (415) — the filename and the ' +
    '`Content-Type` the client claims are not evidence, since both are written by whoever is ' +
    'uploading. SVG is therefore refused too, on purpose: it is a script vector, and a profile ' +
    'photo has no reason to be one. Nothing is re-encoded or resized. Only a person may call ' +
    'this; an agent presenting a valid identity token is refused (403), and one whose token this ' +
    'machine cannot verify is refused (401). The URL that comes back is ' +
    'written to BOTH the roster (`authors.image_url`) and the account record (`user.image`), so ' +
    'the two cannot disagree — and it is opaque: server-relative today, absolute the day a ' +
    'remote store backs it.',
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            avatar: z.string().openapi({ type: 'string', format: 'binary' }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Stored. The URL to render and to keep.',
      content: { 'application/json': { schema: ProfileAvatarResponseSchema } },
    },
    400: {
      description: 'No file was attached, or the upload could not be read',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    401: roomAgentUnverified,
    403: {
      description: 'The caller is an agent — a profile photo is the operator’s to set',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    413: {
      description: 'Larger than 2 MB, refused while still being read',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    415: {
      description: 'The bytes are not a PNG, JPEG or WebP',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/profile/avatar',
  tags: ['Profile'],
  summary: "Remove the operator's profile photo",
  description:
    'Clears the stored file and both identity records. Idempotent: deleting a photo that is ' +
    'already gone succeeds, because the caller wanted it gone either way.',
  responses: {
    204: { description: 'Gone' },
    401: roomAgentUnverified,
    403: {
      description: 'The caller is an agent',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/profile/avatar/{id}',
  tags: ['Profile'],
  summary: "Serve an identity's profile photo",
  description:
    'Streams the stored image with `X-Content-Type-Options: nosniff`, a strong `ETag` derived ' +
    'from the content, and `Cache-Control: private, max-age=0, must-revalidate`. The `?v=<hash>` ' +
    'the stored URL carries is what makes a replaced photo appear at once without turning ' +
    'caching off; a matching `If-None-Match` answers 304. The id is opaque — one that could be ' +
    'read as a path is answered 404 rather than followed.',
  request: { params: z.object({ id: z.string().openapi({ description: 'The identity id' }) }) },
  responses: {
    200: {
      description: 'The image',
      content: {
        'image/png': { schema: z.string().openapi({ type: 'string', format: 'binary' }) },
      },
    },
    304: { description: 'The caller already has this exact photo' },
    404: {
      description: 'That identity has no photo',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

// --- Registry-projected capability paths ---

// Every capability with an `http` surface auto-registers its path here, after
// all legacy hand-registered paths above so the collision guard can see them
// (spec `capability-registry`, task 2.5). Runs once at module load; the
// projection throws if a capability path shadows a hand-registered one.
registerCapabilitiesInOpenApi(composeCapabilityRegistryForDocs(), registry);

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
