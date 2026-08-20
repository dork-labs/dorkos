/**
 * Transport interface — the hexagonal architecture port that decouples the React client
 * from its backend. Two adapters exist: `HttpTransport` (standalone web, HTTP/SSE to Express)
 * and `DirectTransport` (Obsidian plugin, in-process services).
 *
 * Injected via React Context (`TransportProvider`).
 *
 * @module shared/transport
 */
import type {
  Session,
  SessionListResponse,
  RecentSessionsResponse,
  SessionDailyCountsResponse,
  UpdateSessionRequest,
  BrowseDirectoryResponse,
  CommandRegistry,
  HealthResponse,
  HistoryMessage,
  TaskItem,
  ServerConfig,
  ModelOption,
  SubagentInfo,
  FileListResponse,
  FileTreeResponse,
  FileContentResponse,
  CreateEntryResponse,
  FileMutationResponse,
  DiffBaselineResponse,
  GitStatusResponse,
  GitStatusError,
  Task,
  TaskRun,
  CancelTaskRunResponse,
  CreateTaskInput,
  UpdateTaskRequest,
  ListTaskRunsQuery,
  TaskTemplate,
  UploadResult,
  UploadProgress,
} from './types.js';
import type {
  Workspace,
  WorkspaceWithSessions,
  EnsureWorkspaceRequest,
  RemoveResult,
} from './workspace.js';
import type {
  AdapterConfig,
  AdapterStatus,
  TraceSpan,
  DeliveryMetrics,
  CatalogEntry,
  RelayConversation,
  AdapterBinding,
  CreateBindingRequest,
  UpdateBindingRequest,
  ObservedChat,
  BindingTestResult,
  UnclaimedChat,
  UnclaimedChatStatus,
  ClaimUnclaimedChatRequest,
  ClaimUnclaimedChatResponse,
} from './relay-schemas.js';
import type {
  AgentManifest,
  AgentManifestUpdate,
  AgentPathEntry,
  CreateAgentOptions,
  DiscoveryCandidate,
  DenialRecord,
  AgentHealth,
  MeshStatus,
  TopologyView,
  UpdateAccessRuleRequest,
  CrossNamespaceRule,
  TransportScanEvent,
  TransportScanOptions,
  ManagedMcpServer,
  ManagedMcpServerView,
  McpServerTransport,
} from './mesh-schemas.js';
import type { CapabilityTier } from './capabilities.js';
import type { RuntimeCapabilities, SystemRequirements } from './agent-runtime.js';
import type { UnattendedAutonomyState } from './permission-semantics.js';
import type { RuntimeCommandIntentId } from './command-intents.js';
import type {
  StoreCredentialResult,
  DelegatedLoginResult,
  OpenRouterKeyResult,
  OpenRouterOAuthStart,
  OpenRouterOAuthStatus,
  OllamaStatus,
  OllamaModelCatalog,
  OllamaPullProgress,
  OllamaPullResult,
  OllamaProvisionResult,
} from './runtime-connect.js';
import type { SessionSnapshot, SessionEvent, SessionListEvent } from './session-stream.js';
import type { PendingInteractionsResponse } from './interaction-events.js';
import type {
  UiActionRequest,
  McpAppResourceRequest,
  McpAppResourceResponse,
  DevtoolsIngest,
  WorkbenchProbeResponse,
  WorkbenchSignResponse,
  ForkShapeRequest,
  MessageDisposition,
  QueueMoveTarget,
  QueuedMessage,
} from './schemas.js';
import type { TemplateEntry } from './template-catalog.js';
import type { ClientContext } from './additional-context.js';
import type { ListActivityQuery, ListActivityResponse } from './activity-schemas.js';
import type {
  ApprovalDecisionResponse,
  PendingApprovalsResponse,
  RevokeStandingPermissionResponse,
  StandingPermissionsResponse,
} from './approval-schemas.js';
import type {
  DeletePushSubscriptionResponse,
  ListNotificationsQuery,
  ListNotificationsResponse,
  ListPushSubscriptionsResponse,
  MarkNotificationsReadResponse,
  RegisterPushSubscriptionRequest,
  RegisterPushSubscriptionResponse,
  VapidPublicKeyResponse,
} from './notification-schemas.js';
import type {
  AggregatedPackage,
  PackageFilter,
  MarketplacePackageDetail,
  InstallOptions,
  InstallResult,
  UninstallOptions,
  UninstallResult,
  UpdateOptions,
  UpdateResult,
  InstalledPackage,
  MarketplaceSource,
  AddSourceInput,
  InstalledShapeSummary,
  ApplyShapeResult,
  ForkShapeResult,
} from './marketplace-schemas.js';
import type { RoomTransport } from './transport-rooms.js';
import type { ReadCursor, ReadCursorThreadKind } from './read-cursor-schemas.js';
import type {
  MemberRoomsResponse,
  ProfileAvatarResponse,
  ProfileUpdateResponse,
  TeamRosterResponse,
} from './team-schemas.js';
import type { CloudLinkStatus, CloudLinkSummary, StartLinkResult } from './cloud-schemas.js';
import type { FeedbackListItem, FeedbackSubmission } from './telemetry-events.js';
import type {
  ConnectorAccountsResponse,
  ConnectorConnectPollResponse,
  ConnectorConnectStartResponse,
  ConnectorProviderStatus,
  ConnectorRecommendationsResponse,
  ConnectorToolkitsResponse,
  SessionConnectorAttachResult,
  SessionConnectorStatus,
  AgentConnectorAttachment,
  AgentConnectorAttachResult,
} from './connector-provider.js';

/** A single entry in the adapter list — config plus live status. */
export interface AdapterListItem {
  config: AdapterConfig;
  status: AdapterStatus;
}

/** Aggregated dead-letter group — multiple failures collapsed by source + reason. */
export interface AggregatedDeadLetter {
  /** Source identifier (adapter name or from field). */
  source: string;
  /** Rejection reason code. */
  reason: string;
  /** Number of matching dead letters in this group. */
  count: number;
  /** ISO timestamp of the earliest failure in this group. */
  firstSeen: string;
  /** ISO timestamp of the most recent failure in this group. */
  lastSeen: string;
  /** Representative envelope sample from this group. */
  sample?: unknown;
}

/** A single MCP server entry — from `.mcp.json` (config only) or live runtime status. */
export interface McpServerEntry {
  name: string;
  type: 'stdio' | 'sse' | 'http';
  /**
   * Current status reported by the owning runtime. Runtimes without MCP
   * support omit the entry entirely; see `capabilities.supportsMcp`.
   */
  status?: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  /** Error message populated when status === 'failed'. */
  error?: string;
  /**
   * Config scope — typically one of 'project' | 'user' | 'local' | 'managed'.
   * Additional runtime-specific scopes may appear; callers should treat this
   * as an open string and check `capabilities` for supported values.
   */
  scope?: string;
}

/** Response shape for the `GET /api/mcp-config` endpoint. */
export interface McpConfigResponse {
  servers: McpServerEntry[];
}

/**
 * The `202 approval_required` body a destructive capability returns when a
 * person must approve before it runs (spec `mcp-server-management` §7, spec
 * `agent-trust` §3.2). Carries the id a person decides and the one-time token
 * to present on the retry — the operator grants their own approval
 * (`grantApproval`) then retries with `approvalToken`.
 *
 * Structurally the wire contract the server's `ApprovalRequiredPayload`
 * produces; typed here so the client Transport surface can carry it without
 * importing server internals.
 */
export interface CapabilityApprovalRequired {
  /** Discriminator. Always `approval_required`. */
  status: 'approval_required';
  /** The capability that did NOT run. */
  capabilityId: string;
  /** Its human-facing title, as the operator's card shows it. */
  capabilityTitle: string;
  /** Its permission tier, from the registry. */
  tier: CapabilityTier;
  /** The approval a person will decide. Safe to show or log. */
  approvalId: string;
  /** The one-time token to present on the retry. Inert until someone grants it. */
  approvalToken: string;
  /** When the token stops being honored. ISO 8601 UTC. */
  expiresAt: string;
  /** Why the call is not running yet. */
  reason: string;
  /** One plain sentence a person can act on. */
  message: string;
  /** How to retry once approved. */
  retry: {
    /** Whether the token rides an MCP argument or an HTTP header. */
    channel: string;
    /** The exact argument or header name to put the token in. */
    field: string;
    /** Step-by-step retry instructions. */
    instructions: string;
  };
}

/** Input for {@link Transport.addAgentMcpServer}. */
export interface AddAgentMcpServerInput {
  /** ULID of the agent that will own the server. */
  agentId: string;
  /** Server name (unique per agent; alphanumeric, dashes, underscores). */
  name: string;
  /** How to reach the server (stdio/http/sse). */
  connection: McpServerTransport;
  /** Whether to enable it immediately. Defaults server-side to true on add. */
  enabled?: boolean;
}

/** Input for {@link Transport.importAgentMcpServer}. */
export interface ImportAgentMcpServerInput {
  /** ULID of the agent that will own the imported server. */
  agentId: string;
  /** The discovered server's name (its key in the project's `.mcp.json`). */
  name: string;
}

/** Input for {@link Transport.updateAgentMcpServer}. */
export interface UpdateAgentMcpServerInput {
  /** ULID of the agent that owns the server. */
  agentId: string;
  /** Name of the existing server to update. */
  name: string;
  /** New connection. Omit to leave it unchanged; changing it re-prompts approval. */
  connection?: McpServerTransport;
  /** New enabled state. Omit to leave it unchanged. */
  enabled?: boolean;
}

/**
 * Result of a destructive managed-MCP mutation ({@link Transport.addAgentMcpServer},
 * {@link Transport.updateAgentMcpServer}): either the write ran and the updated
 * list came back, or it is parked waiting on a person's approval.
 */
export type AgentMcpMutationResult =
  | { status: 'ok'; servers: ManagedMcpServer[] }
  | { status: 'approval_required'; approval: CapabilityApprovalRequired };

/** Result of probing a managed MCP server ({@link Transport.testAgentMcpServer}). */
export interface AgentMcpTestResult {
  /** Whether the server connected and listed its tools. */
  ok: boolean;
  /** How many tools it exposes, when reachable. */
  toolCount?: number;
  /** The failure reason, when unreachable. */
  error?: string;
  /**
   * True when the probe failed specifically because the server demands OAuth
   * sign-in (a 401 / unauthorized response), so the client can render
   * "Needs sign-in" and offer the sign-in action rather than the raw error
   * (DOR-942). Absent for reachable servers and for non-auth failures.
   */
  needsAuth?: boolean;
}

/**
 * Result of starting an OAuth sign-in for a managed MCP server (the `mcp.signin`
 * capability, DOR-943). The client shows {@link disclosure} verbatim, then opens
 * {@link authorizeUrl} in a new tab and polls {@link Transport.pollMcpSignin}
 * with {@link flowId}. When a live token already existed, {@link alreadyConnected}
 * is true and {@link authorizeUrl} is absent — no browser step is needed.
 */
export interface StartMcpSigninResult {
  /** The sign-in flow id to pass to {@link Transport.pollMcpSignin}. */
  flowId: string;
  /** The sign-in link to open in a new tab; absent when {@link alreadyConnected}. */
  authorizeUrl?: string;
  /** True when a live token already existed, so no browser step is needed. */
  alreadyConnected: boolean;
  /** The custody disclosure to show verbatim before opening the link. */
  disclosure: string;
  /** Ready-to-render markdown carrying the link and disclosure (agent-facing surfaces). */
  message: string;
}

/**
 * Why a managed-MCP sign-in could not even be STARTED (DOR-982) — the `code` on
 * the error payload `mcp.signin` rejects with, so every surface can say the same
 * plain sentence instead of relaying an OAuth stack trace.
 *
 * - `SIGNIN_NO_APP_REGISTRATION` — the provider will not let DorkOS register
 *   itself automatically. This is the one a person can fix: they can paste app
 *   credentials from the provider's developer settings
 *   ({@link Transport.setMcpClientCredentials}) and sign in again.
 * - `SIGNIN_NO_SIGNIN_SUPPORT` — the server publishes no OAuth details DorkOS
 *   can work from, so there is no sign-in to start.
 * - `SIGNIN_UNREACHABLE` — everything else: the server could not be reached, or
 *   it answered in a way DorkOS could not use.
 *
 * The raw error is carried alongside as `detail`, for the Details disclosure —
 * it is never the headline.
 */
export const MCP_SIGNIN_FAILURE_CODES = [
  'SIGNIN_NO_APP_REGISTRATION',
  'SIGNIN_NO_SIGNIN_SUPPORT',
  'SIGNIN_UNREACHABLE',
] as const;

/** See {@link MCP_SIGNIN_FAILURE_CODES}. */
export type McpSigninFailureCode = (typeof MCP_SIGNIN_FAILURE_CODES)[number];

/**
 * The app credentials an operator got from a provider that does not support
 * automatic client registration (DOR-982).
 *
 * Both values are secrets in the same sense a token is: they are stored
 * encrypted on this computer, never written to the manifest, never logged, and
 * never handed back out — no read side exists for them at all.
 */
export interface McpClientCredentials {
  /** The client id (sometimes "app id") the provider issued. */
  clientId: string;
  /** The client secret, when the provider issued one. Many public clients have none. */
  clientSecret?: string;
}

/** The pollable status of a managed-MCP sign-in flow (the `mcp.poll_signin` capability). */
export interface McpSigninPollResult {
  /** Whether the sign-in is still waiting, finished, or failed. */
  status: 'pending' | 'connected' | 'failed';
  /** The failure reason, when {@link status} is `failed`. */
  error?: string;
  /**
   * How many tools the server exposes, counted right after the sign-in landed
   * (DOR-1003) — the payoff line, "Connected — 12 tools."
   *
   * Present only when {@link status} is `connected` AND the server answered the
   * follow-up probe. Absent never means zero, so read it defensively: a
   * connection is reported whether or not the count could be taken.
   */
  toolCount?: number;
}

/** A lifecycle event recorded for an adapter instance. */
export interface AdapterEvent {
  id: string;
  subject: string;
  status: string;
  sentAt: string;
  metadata: string | null;
}

/**
 * Minimal file interface for upload — matches the browser File API.
 *
 * Using a custom interface (rather than the DOM `File` type) keeps the shared
 * package free of DOM lib dependencies so it can be used in Node.js contexts.
 */
export interface UploadFile {
  /** Original filename as provided by the user. */
  name: string;
  /** File size in bytes. */
  size: number;
  /** MIME type of the file. */
  type: string;
  /** Read the file contents as an ArrayBuffer. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Claude-specific capability-gated sub-transport.
 *
 * Obtained via `transport.asClaudePluginTransport(sessionId)` — non-null only
 * when the resolved runtime's `capabilities.supportsPlugins` is true. Callers
 * must gate access behind the capability check rather than calling the
 * universal Transport surface directly.
 */
export interface ClaudePluginTransport {
  /**
   * Trigger a plugin reload on the Claude-managed plugin set for the session
   * this sub-transport was obtained for. Only available when the resolved
   * runtime's `capabilities.supportsPlugins` is true.
   */
  reloadPlugins(): Promise<import('./types.js').ReloadPluginsResult>;
}

/**
 * Result of {@link Transport.writeFile}. A conflict is normal control flow (the
 * file changed under an optimistic-concurrency write), not an exception, so it
 * is returned rather than thrown — the caller decides whether to reload or
 * force-overwrite. Genuine failures (network, permissions, missing file) still
 * throw.
 */
export type WriteFileResult =
  | { ok: true; hash: string }
  | { ok: false; conflict: { currentHash: string; currentContent: string } };

/** A single progress frame emitted while a runtime binary is being provisioned on demand. */
export interface RuntimeProvisionProgress {
  /** Lifecycle stage of the install. */
  stage: 'starting' | 'installing' | 'done' | 'error';
  /** Human-readable progress line (installer output or a status message). */
  message: string;
}

/**
 * Terminal result of an on-demand runtime provisioning action (ADR-0317).
 *
 * On success the binary is resolvable and the runtime flips to Ready on the next
 * requirements probe; on failure the partial install is cleaned up and `error`
 * carries an honest message (never a raw stack) for the Connect surface.
 */
export interface RuntimeProvisionResult {
  /** True when the install completed and the binary is resolvable. */
  ok: boolean;
  /** Absolute path to the provisioned binary, when `ok`. */
  binaryPath?: string;
  /** Honest failure message when not `ok`. */
  error?: string;
}

/**
 * A live attachment to a server-side PTY (spec right-panel-workbench, Chunk E;
 * ADR 260708-185521). `openTerminal` returns one of these; the raw byte stream
 * flows out via {@link TerminalHandle.output}, while input and resize flow back
 * through {@link Transport.writeTerminal} / {@link Transport.resizeTerminal},
 * which correlate to this attachment by {@link TerminalHandle.id}.
 */
export interface TerminalHandle {
  /** Server-assigned terminal-session id (for control routing + teardown). */
  readonly id: string;
  /**
   * Raw PTY output byte chunks. The async iterable ends when the shell exits,
   * the socket closes, or the `signal` passed to `openTerminal` aborts.
   *
   * Single-shot / single-consumer: iterate it exactly once (the terminal panel
   * pipes it straight into xterm). A second iterator would compete for the same
   * frames, not replay them.
   */
  readonly output: AsyncIterable<Uint8Array>;
  /**
   * Why the socket closed, readable once {@link output} has ended: the WebSocket
   * close `code` and `reason`. `undefined` when the stream ended for another
   * reason (an abort, or a transport that surfaces no close metadata). A `code`
   * of `TERMINAL_CLOSE_SUPERSEDED` (see `@dorkos/shared/terminal-schemas`) means
   * the server replaced this attachment with a newer one — a takeover — which
   * the panel treats differently from the shell exiting.
   */
  readonly closeInfo?: { code: number; reason: string };
}

/**
 * An untrusted cockpit crash report relayed to the server (DOR-318). Carries
 * only the three raw `Error` strings — the server rebuilds and scrubs them, so
 * the client never scrubs and the server never trusts these values. Everything
 * is optional because a given crash may expose only some of them.
 */
export interface ClientErrorReport {
  /** Error constructor name (e.g. `TypeError`). */
  name?: string;
  /** Raw error message — dropped server-side, never sent onward. */
  message?: string;
  /** Raw `Error.stack` — scrubbed server-side to repo-relative frames. */
  stack?: string;
}

export interface Transport extends RoomTransport {
  /** Optional client identifier for SSE presence tracking. */
  readonly clientId?: string;
  /**
   * Whether this transport can attach an embedded terminal (a server-side PTY
   * over a WebSocket byte channel). `true` for the HTTP transport, `false` for
   * the in-process Obsidian transport — the terminal is a web-only surface, so
   * the terminal tab is gated on this flag rather than attempted-and-failed.
   */
  readonly supportsTerminal: boolean;
  /**
   * List sessions across all registered runtimes, optionally scoped to a
   * working directory. Returns the aggregation envelope (ADR-0310): `sessions`
   * merged and sorted by `updatedAt` descending, plus optional per-runtime
   * `warnings` when a backend failed or timed out (partial results, never a
   * failed request).
   */
  listSessions(cwd?: string): Promise<SessionListResponse>;
  /**
   * List the most-recent sessions across ALL registered agents (DOR-329),
   * backing the sidebar's cross-agent "Recent" section. Returns the merged,
   * `updatedAt`-descending sessions trimmed to `limit`, plus `agentActivity` (a
   * per-agent `projectPath` → latest-session-`updatedAt` map that drives the
   * per-group "Recent activity" sort) and optional per-runtime `warnings`
   * (ADR-0310 degradation). Embedded mode has no multi-agent roster and returns
   * an empty envelope.
   *
   * @param limit - Maximum sessions to return (1-50, default 10).
   */
  listRecentSessions(limit?: number): Promise<RecentSessionsResponse>;
  /**
   * Count the sessions started per day across ALL registered agents
   * (DOR-1039), backing the Activity tab's week line. Returns `dailyCounts`
   * with one entry per day, oldest first, plus per-runtime `warnings`
   * (ADR-0310) — a warning means the counts are a floor, not a total.
   *
   * Embedded mode has no multi-agent roster and returns an empty
   * `dailyCounts`, which callers must read as "no answer", not "no runs".
   *
   * @param days - Window width in days ending today (1-31, default 7).
   */
  getSessionDailyCounts(days?: number): Promise<SessionDailyCountsResponse>;
  /** Get metadata for a single session by ID. */
  getSession(id: string, cwd?: string): Promise<Session>;
  /**
   * Resolve the runtime type string (e.g. `'claude-code'`, `'test-mode'`) that
   * owns the given session.
   *
   * Clients use this to gate UI off the active session's capabilities rather
   * than the server-default. Legacy sessions with no persisted runtime row
   * resolve to `'claude-code'` (infer-on-access) on the server side.
   *
   * @param sessionId - Session identifier
   */
  getSessionRuntimeType(sessionId: string): Promise<string>;
  /** Update session settings (permission mode, model). */
  updateSession(id: string, opts: UpdateSessionRequest, cwd?: string): Promise<Session>;
  /** Fork a session, creating a new independent copy. */
  forkSession(
    id: string,
    opts?: { upToMessageId?: string; title?: string },
    cwd?: string
  ): Promise<Session>;
  /** Fetch message history for a session. */
  getMessages(sessionId: string, cwd?: string): Promise<{ messages: HistoryMessage[] }>;
  /**
   * Fetch the authoritative current state of a session for hydration: completed
   * messages, the in-progress turn's events, status projection, pending
   * interactions, and the snapshot cursor (highest seq reflected). Subscribe
   * with this cursor to replay only events not yet seen.
   *
   * @param sessionId - Target session ID
   * @param cwd - Optional working directory override
   */
  getSessionSnapshot(sessionId: string, cwd?: string): Promise<SessionSnapshot>;
  /**
   * Subscribe to a session's normalized, monotonically-seq'd event stream.
   *
   * HTTP maps this to `GET /api/sessions/:id/events` (SSE); Direct/Obsidian maps
   * it to in-process async iteration. Pass `sinceCursor` to resume after a gap,
   * receiving only events with `seq` greater than the cursor.
   *
   * @param sessionId - Target session ID
   * @param sinceCursor - Resume point; emit only events past this cursor
   * @param cwd - Optional working directory override
   * @param signal - Aborts the stream deterministically. Mirrors
   *   `AgentRuntime.subscribeSession`: a bare `iterator.return()` cannot
   *   interrupt a generator parked on an un-settleable wait, so consumers that
   *   re-target or tear down (e.g. session switch) should abort via this signal.
   */
  subscribeSession(
    sessionId: string,
    sinceCursor?: number,
    cwd?: string,
    signal?: AbortSignal
  ): AsyncIterable<SessionEvent>;
  /**
   * Subscribe to the global session-list stream — discovery + liveness across
   * all observable sessions, feeding the sidebar and fleet-wide status view.
   *
   * HTTP maps this to `GET /api/events` (SSE); Direct/Obsidian maps it to
   * in-process async iteration.
   */
  subscribeSessionList(): AsyncIterable<SessionListEvent>;
  /**
   * Trigger a turn for a session and resolve to the canonical session id.
   *
   * POSTs to `/sessions/:id/messages` (trigger-only, `202`) and parses the
   * `{ sessionId }` body — the SDK-canonical id the server resolved for this
   * turn. The turn itself is delivered out-of-band over the durable `/events`
   * stream (snapshot → replay → live), NOT in this response. When the returned
   * `sessionId` differs from `sessionId`, the caller re-targets the durable
   * stream and rewrites the URL to the canonical id (create-on-first-message).
   *
   * **A busy session never refuses.** The server owns the queue, so a message
   * sent into a running turn is accepted and waits its turn — the `202` says so
   * and the queue itself arrives on the session's event stream. There is no
   * `409 SESSION_LOCKED` on this path any more (spec
   * `persistent-session-runtime` §3.3).
   *
   * @param sessionId - Target session id (a client UUID for a brand-new session)
   * @param content - User message text
   * @param cwd - Optional working directory override
   * @param options - Optional additional parameters (clientMessageId for server-echo ID, context for neutral client signals: uiState, queued, runtime as the first-turn runtime hint resolved hint > agent manifest > default and persisted first-write-wins per ADR-0255, seedContext for background the agent reads and the person never sees — see `SeedContextData`, disposition for what to do when the session is already working — absent means `queue`)
   */
  postMessage(
    sessionId: string,
    content: string,
    cwd?: string,
    options?: {
      clientMessageId?: string;
      context?: ClientContext;
      runtime?: string;
      seedContext?: string;
      disposition?: MessageDisposition;
    }
  ): Promise<{ sessionId: string }>;
  /**
   * Change a waiting message's words, its place in the queue, or both.
   *
   * `PATCH /sessions/:id/queue/:messageId`. The queue belongs to the SESSION,
   * so any window may edit any message on it — that is the point of the queue
   * living on the server. A move names another message to land before or after
   * rather than an index, because an index means something different to every
   * window the moment anyone else edits the queue.
   *
   * Rejects with a `QUEUED_MESSAGE_NOT_FOUND` error when the message is no
   * longer waiting: it already started running, or another window removed it.
   * Callers treat that as "the queue moved on", never as a failure to report.
   *
   * @param sessionId - The session whose queue holds the message.
   * @param messageId - The server-minted id of the waiting message.
   * @param edit - New words, a move, or both. At least one is required.
   */
  updateQueuedMessage(
    sessionId: string,
    messageId: string,
    edit: { content?: string; move?: QueueMoveTarget }
  ): Promise<{ message: QueuedMessage; queue: QueuedMessage[] }>;
  /**
   * Take a waiting message off the queue, so it never runs.
   *
   * `DELETE /sessions/:id/queue/:messageId`. Rejects with
   * `QUEUED_MESSAGE_NOT_FOUND` when it is already gone — see
   * {@link updateQueuedMessage}.
   *
   * @param sessionId - The session whose queue holds the message.
   * @param messageId - The server-minted id of the waiting message.
   */
  removeQueuedMessage(sessionId: string, messageId: string): Promise<{ queue: QueuedMessage[] }>;
  /**
   * Trigger a RUNTIME-fulfilled command intent (currently `compact`) for a
   * session and resolve to the canonical session id.
   *
   * The single client path all four surfaces share to fulfill a runtime intent:
   * `HttpTransport` POSTs `/sessions/:id/command-intents/:intent` (trigger-only,
   * `202`), `DirectTransport` calls the same server service in-process. The
   * outcome — a compaction — is delivered out-of-band over the durable `/events`
   * stream (e.g. a `compact_boundary`), NOT in this response, exactly like
   * {@link postMessage}. Callers must first gate on the active runtime's
   * `capabilities.commandIntents[intent].supported`; an unsupported intent is an
   * honest error, never sent as text.
   *
   * @param sessionId - Target session id.
   * @param intent - The runtime-fulfilled intent id (e.g. `'compact'`).
   * @param instructions - Trailing instructions the user typed after the intent
   *   token (e.g. `/compact focus on the API changes`). Forwarded to runtimes
   *   whose native mechanism accepts guidance (claude-code); ignored by those
   *   whose mechanism takes none (opencode, test-mode).
   */
  runCommandIntent(
    sessionId: string,
    intent: RuntimeCommandIntentId,
    instructions?: string
  ): Promise<{ sessionId: string }>;
  /**
   * Dispatch a generative-UI widget `agent`-kind action back to the session.
   *
   * Backs the widget interactivity return channel (spec gen-ui-tier1 §3): a click
   * on an `agent` action POSTs `/sessions/:id/ui-action`, which injects a
   * structured `<ui_action>` block as the next user turn (trigger-only, `202`,
   * modeled on {@link postMessage}). Like `postMessage`, the turn is delivered
   * out-of-band over the durable `/events` stream and this resolves to the
   * canonical session id. Throws a typed `SESSION_LOCKED` error on `409` when the
   * session is already running a turn — the caller surfaces it (e.g. an error
   * toast) and lets the user retry.
   *
   * @param sessionId - Target session id (the session that rendered the widget)
   * @param action - The action id, optional payload (form values pre-merged),
   *   optional widget id/title, and optional cwd override
   */
  sendUiAction(sessionId: string, action: UiActionRequest): Promise<{ sessionId: string }>;
  /**
   * Read a `ui://` MCP App resource (SEP-1865) for rendering in a sandboxed
   * frame. The server opens its own short-lived MCP client and returns the
   * resource body plus its sandbox metadata (mime, CSP, declared permissions).
   * The MCP connection config stays server-side (ADR `260708-141143`).
   *
   * @param sessionId - Session whose MCP server owns the resource.
   * @param request - The `serverName` and `ui://` `uri` to read.
   */
  fetchMcpAppResource(
    sessionId: string,
    request: McpAppResourceRequest
  ): Promise<McpAppResourceResponse>;
  /**
   * Every prompt across the fleet that is waiting on a person, with
   * server-authoritative time left.
   *
   * The seed for the live stream: a window that opens after a prompt was raised
   * reads it here, then keeps it current from `interaction_pending` and
   * `interaction_resolved`. Answering still goes through the six methods below —
   * only listing is new. See `GET /api/sessions/pending-interactions`.
   */
  listPendingInteractions(): Promise<PendingInteractionsResponse>;
  /** Approve a pending tool call that requires user confirmation. */
  approveTool(
    sessionId: string,
    toolCallId: string,
    alwaysAllow?: boolean
  ): Promise<{ ok: boolean }>;
  /**
   * Deny a pending tool call that requires user confirmation.
   *
   * @param sessionId - Session holding the pending request.
   * @param toolCallId - The tool call being refused.
   * @param reason - Why, in the person's own words. Delivered to the agent so
   *   it can adjust instead of retrying; omitted when nobody said anything.
   */
  denyTool(sessionId: string, toolCallId: string, reason?: string): Promise<{ ok: boolean }>;
  /** Approve multiple pending tool calls at once. */
  batchApprove(
    sessionId: string,
    toolCallIds: string[]
  ): Promise<{ results: { toolCallId: string; ok: boolean }[] }>;
  /** Deny multiple pending tool calls at once. */
  batchDeny(
    sessionId: string,
    toolCallIds: string[]
  ): Promise<{ results: { toolCallId: string; ok: boolean }[] }>;
  /**
   * Submit answers for a structured-question prompt.
   *
   * `answers` is the canonical, runtime-neutral format: keyed by question index
   * (`"0"`, `"1"`, …), each value the answer as a display string with multi-select
   * selections joined by `", "`. The active runtime translates it for its backend.
   */
  submitAnswers(
    sessionId: string,
    toolCallId: string,
    answers: Record<string, string>
  ): Promise<{ ok: boolean }>;
  /** Submit a response to an MCP elicitation prompt. */
  submitElicitation(
    sessionId: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ): Promise<{ ok: boolean }>;
  /**
   * Stop a running background task.
   *
   * @param sessionId - The parent session containing the task
   * @param taskId - The background task to stop
   * @returns Result indicating success or failure
   */
  stopTask(sessionId: string, taskId: string): Promise<{ success: boolean; taskId: string }>;
  /**
   * Interrupt the active query for a session, and empty its queue.
   *
   * Stop means stop everything queued (spec `persistent-session-runtime` §3.5).
   * The server clears the session's queue and returns the removed messages in
   * `cancelledQueued`, head first, so the caller can hand the words back to the
   * composer rather than lose them — nothing a person typed is destroyed by a
   * Stop. `ok` is the best-effort interrupt result and callers should not block
   * on it; the server attempts a graceful SDK interrupt, falling back to a
   * forceful close if needed. A surface with no queue returns an empty array.
   *
   * @param sessionId - The session whose query should be interrupted
   */
  interruptSession(sessionId: string): Promise<{ ok: boolean; cancelledQueued: QueuedMessage[] }>;
  /** Get the current task list for a session. */
  getTasks(sessionId: string, cwd?: string): Promise<{ tasks: TaskItem[] }>;
  /** Browse server filesystem directories for working directory selection. */
  browseDirectory(dirPath?: string, showHidden?: boolean): Promise<BrowseDirectoryResponse>;
  /** Get the server's default working directory. */
  getDefaultCwd(): Promise<{ path: string }>;
  /**
   * List available slash commands from the resolved runtime.
   *
   * @param refresh - Force a rescan of the command filesystem cache.
   * @param cwd - Working directory scope (passed to the runtime).
   * @param opts - Optional context. `runtime` explicitly selects a runtime by
   *   type and takes precedence — the not-yet-started-session path where no
   *   metadata row exists yet, so `sessionId` would wrongly infer the default
   *   (showing Claude's commands for a fresh Codex session). `sessionId`
   *   otherwise scopes the call to the runtime that owns the session. Omit both
   *   for cold-discovery (onboarding, first-run).
   */
  getCommands(
    refresh?: boolean,
    cwd?: string,
    opts?: { sessionId?: string; runtime?: string }
  ): Promise<CommandRegistry>;
  /** List files in a directory for the file browser. */
  listFiles(cwd: string): Promise<FileListResponse>;
  /**
   * Write edited content back to an existing file in a session's working
   * directory — backs the editable markdown canvas. The path is resolved within
   * and confined to `cwd`; the file must already exist (this never creates
   * files).
   *
   * The write can be made conditional (optimistic concurrency) by passing
   * `options.expectedHash` (a SHA-256 the client already holds) or, on a first
   * save when it has no hash, `options.expectedContent` (the baseline the server
   * hashes for it — so the client needs no `crypto.subtle`). If the on-disk
   * content no longer matches, the call resolves to `{ ok: false, conflict }`
   * carrying the current bytes. Pass neither to force an unconditional overwrite.
   *
   * @param cwd - Session working directory the path is resolved within.
   * @param filePath - File path, absolute or relative to `cwd`.
   * @param content - Full new file content.
   * @param options - `expectedHash` or `expectedContent` enable the conflict check.
   */
  writeFile(
    cwd: string,
    filePath: string,
    content: string,
    options?: { expectedHash?: string; expectedContent?: string }
  ): Promise<WriteFileResult>;
  /**
   * Build a same-origin URL that streams a local media file (image or PDF) from
   * a session's working directory, for use as an `<img>`/`<object>` source in the
   * canvas. The path is resolved within and confined to `cwd` server-side, and
   * only image and PDF content types are served. Returns `null` when the
   * transport cannot serve local files over a URL (e.g. the in-process Obsidian
   * transport) so callers fall back to an "unavailable here" state.
   *
   * @param cwd - Session working directory the path is resolved within.
   * @param filePath - File path, absolute or relative to `cwd`.
   */
  mediaUrl(cwd: string, filePath: string): string | null;

  // --- Workbench embedded browser (web-only; DOR-216, ADR 260708-185519) ---

  /**
   * Mint a short-lived signed URL that statically serves a local HTML file (and
   * its relative assets) from a session's working directory, for the embedded
   * browser to load in an opaque-origin sandbox. The token — not the API's
   * cookie/header auth — authorizes the request, so a sandboxed (no
   * `allow-same-origin`) frame that carries no credentials can still fetch the
   * page, yet the page can never call `/api/*` as the user. The path is confined
   * to `cwd` server-side; a `..`/symlink escape is rejected.
   *
   * Returns `null` when the transport cannot serve local files over a URL (the
   * in-process Obsidian transport), so the browser falls back to an
   * "unavailable here" state.
   *
   * @param cwd - Session working directory the served files are confined to.
   * @param filePath - Initial file to open, relative to `cwd` (defaults to `index.html`).
   */
  createServeUrl(cwd: string, filePath?: string): Promise<string | null>;
  /**
   * Ask for an origin the embedded browser can frame a localhost dev server on.
   *
   * The server opens (or reuses) a preview listener in front of that port and
   * answers with a bootstrap URL: a real origin of its own, on the same host the
   * caller reached DorkOS at, so root-absolute assets, client-side routers and
   * live-reload sockets all resolve the way they do in a browser tab. The
   * listener strips the framing guards, injects the DevTools shim, and is pinned
   * to loopback upstream — no arbitrary-host SSRF.
   *
   * The response's `url` is `null` when no origin can be offered, with
   * `unavailable` saying why, so the browser can explain it. The whole response
   * is `null` on the in-process Obsidian transport (web-only surface).
   *
   * @param port - Localhost port of the dev server to preview (1–65535).
   */
  createProxyUrl(port: number): Promise<WorkbenchSignResponse | null>;
  /**
   * Ask whether anything is listening on a loopback port, so the embedded
   * browser can say "nothing is running there" instead of framing a dead port
   * and showing a blank page.
   *
   * The server opens a short TCP connection to the loopback address and closes
   * it again — it never sends or forwards a request, and the port is the only
   * input (the host is pinned to loopback server-side, so there is no way to
   * point this at another machine).
   *
   * Returns `null` when the transport has no server to ask (the in-process
   * Obsidian transport); the caller treats that as "unknown" and carries on.
   *
   * @param port - Loopback port to check (1–65535).
   */
  probeLoopbackPort(port: number): Promise<WorkbenchProbeResponse | null>;
  /**
   * Relay a DevTools capture batch from the embedded browser preview to the
   * server's per-session buffer (DOR-213), via `POST /sessions/:id/devtools/ingest`.
   *
   * The injected in-page shim posts captures to the client (`window.parent`),
   * never to `/api/*`; this client — same-origin and authenticated — is the
   * credentialed party that forwards them here. Best-effort and fire-and-forget:
   * a preview that can't be reached simply produces no capture. `DirectTransport`
   * no-ops (the embedded browser is web-only already).
   *
   * @param sessionId - The session whose preview produced the batch.
   * @param batch - The validated console/network (and navigation) capture batch.
   */
  ingestDevtoolsCapture(sessionId: string, batch: DevtoolsIngest): Promise<void>;

  // --- Workbench file service (explorer + viewers; DOR-217) ---

  /**
   * List one directory level of a session's working directory for the file
   * explorer tree. Lazy by default (`depth` 1 = immediate children only), rooted
   * at `path` (relative to `cwd`, defaults to the root). `showHidden` reveals
   * dotfiles and `.gitignore`d entries, which are filtered out by default. Every
   * returned `path` is relative to `cwd` so it can be re-requested or opened.
   *
   * The path is resolved within and confined to `cwd` server-side; a `..` or
   * symlink escape is rejected.
   *
   * @param cwd - Session working directory the listing is rooted at.
   * @param options - `path` (subdirectory to list), `depth` (recursion bound),
   *   and `showHidden` (include dotfiles + gitignored entries).
   */
  readFileTree(
    cwd: string,
    options?: { path?: string; depth?: number; showHidden?: boolean }
  ): Promise<FileTreeResponse>;
  /**
   * Read a UTF-8 text file's content plus its SHA-256 fingerprint, confined to
   * `cwd`. Distinct from {@link mediaUrl} (media bytes): the server rejects
   * binary files and content over its size cap. The returned `hash` seeds the
   * optimistic-concurrency check on a later {@link writeFile}.
   *
   * @param cwd - Session working directory the path is resolved within.
   * @param filePath - File path, absolute or relative to `cwd`.
   */
  readFileContent(cwd: string, filePath: string): Promise<FileContentResponse>;

  // --- Workbench diff review (per-hunk agent-edit review; DOR-212) ---

  /**
   * Resolve the pre-edit baseline for a file plus its current disk content, for
   * the text-diff review surface. The base is the session's pre-edit snapshot of
   * `filePath` (captured at the runtime's pre-tool boundary), falling back to
   * reconstruct-from-tool-input → git `HEAD` → empty when no snapshot exists.
   * `mode: 'head'` forces the git-HEAD compare (the secondary user-toggled mode).
   *
   * The returned `currentHash` is the optimistic-concurrency token a later reject
   * write (`writeFile` with `expectedHash`) passes, so a file that changed under
   * the diff yields a conflict rather than a blind clobber. Under the in-process
   * transport this works from the in-process baseline store (git via
   * `child_process`), so text diff is available in Obsidian.
   *
   * @param cwd - Session working directory the path is resolved within.
   * @param filePath - File path, absolute or relative to `cwd`.
   * @param sessionId - Session whose pre-edit snapshot to diff against.
   * @param mode - `'session'` (default, snapshot base) or `'head'` (git-HEAD compare).
   */
  readDiffBaseline(
    cwd: string,
    filePath: string,
    sessionId: string,
    mode?: 'session' | 'head'
  ): Promise<DiffBaselineResponse>;
  /**
   * Advance a file's diff baseline to its current disk content (finish-review),
   * so subsequent agent edits diff from the just-reviewed state. A no-op when no
   * baseline exists for the pair.
   *
   * @param cwd - Session working directory the path is resolved within.
   * @param filePath - File path, absolute or relative to `cwd`.
   * @param sessionId - Session whose baseline to advance.
   */
  advanceDiffBaseline(cwd: string, filePath: string, sessionId: string): Promise<void>;
  /**
   * Build a same-origin URL that streams a file's BASELINE image bytes — its
   * pre-edit snapshot for this session, or its git-HEAD content when no
   * snapshot exists — for the image-diff surface's "before" layer (DOR-212
   * Chunk B). Current bytes come from {@link mediaUrl}. The path is resolved
   * within and confined to `cwd` server-side, and only media content types are
   * served (the raw-file allowlist); the URL 404s when no baseline exists,
   * which the viewer reads as "this image is new".
   *
   * Returns `null` when the transport cannot serve bytes over a URL (the
   * in-process Obsidian transport) — image diff is a web-only surface,
   * mirroring the shipped {@link mediaUrl} gap.
   *
   * @param cwd - Session working directory the path is resolved within.
   * @param filePath - File path, absolute or relative to `cwd`.
   * @param sessionId - Session whose pre-edit snapshot to serve.
   */
  diffBaselineMediaUrl(cwd: string, filePath: string, sessionId: string): string | null;
  /**
   * Restore a file's baseline bytes to disk, whole-file — the image diff's
   * "reject" (DOR-212 Chunk B). Binary-safe, unlike the text-oriented
   * {@link writeFile}: the server writes the snapshot's own bytes (git-HEAD
   * fallback), atomically, so no bytes travel from the client. Throws with
   * `code: 'NO_BASELINE'` (404) when no restorable baseline exists — a file
   * the agent created this session has no previous version, and the revert
   * never deletes files. Content-independent and idempotent: it restores the
   * same pre-session bytes regardless of what is on disk now, so the caller
   * confirm-gates the action instead of hash-gating the write.
   *
   * Web-only alongside {@link diffBaselineMediaUrl}: the in-process transport
   * throws `'unsupported'` (the image-diff surface is gated off before this
   * can be reached).
   *
   * @param cwd - Session working directory the path is resolved within.
   * @param filePath - File path, absolute or relative to `cwd`.
   * @param sessionId - Session whose baseline to restore.
   */
  revertDiffBaseline(cwd: string, filePath: string, sessionId: string): Promise<void>;
  /**
   * Create a new file or directory within `cwd`. Rejects (409, thrown with
   * `code: 'CONFLICT'`) when the target already exists. `content` seeds a new
   * file's bytes (ignored for `type: 'dir'`). The write is atomic for files.
   *
   * @param cwd - Session working directory the path is resolved within.
   * @param filePath - Target path, absolute or relative to `cwd`.
   * @param type - `'file'` or `'dir'`.
   * @param content - Optional initial content for a new file.
   */
  createEntry(
    cwd: string,
    filePath: string,
    type: 'file' | 'dir',
    content?: string
  ): Promise<CreateEntryResponse>;
  /**
   * Delete a file or directory within `cwd`. A non-empty directory requires
   * `recursive: true`. Refuses to delete the `cwd` root itself.
   *
   * @param cwd - Session working directory the path is resolved within.
   * @param filePath - Target path, absolute or relative to `cwd`.
   * @param options - `recursive` permits removing a non-empty directory.
   */
  deleteEntry(
    cwd: string,
    filePath: string,
    options?: { recursive?: boolean }
  ): Promise<FileMutationResponse>;
  /**
   * Move or rename an entry within `cwd`. Both `from` and `to` are confined to
   * `cwd`; rejects (409, thrown with `code: 'CONFLICT'`) when `to` already
   * exists.
   *
   * @param cwd - Session working directory both paths are resolved within.
   * @param from - Source path, absolute or relative to `cwd`.
   * @param to - Destination path, absolute or relative to `cwd`.
   */
  renameEntry(cwd: string, from: string, to: string): Promise<FileMutationResponse>;
  /**
   * Copy an entry within `cwd`, recursively for directories. Both `from` and
   * `to` are confined to `cwd`; rejects when `from` is missing (thrown with
   * `code: 'NOT_FOUND'`), when `to` already exists (`code: 'CONFLICT'`), or
   * when a directory would be copied into its own subtree
   * (`code: 'COPY_INTO_SELF'`).
   *
   * @param cwd - Session working directory both paths are resolved within.
   * @param from - Source path, absolute or relative to `cwd`.
   * @param to - Destination path, absolute or relative to `cwd`.
   */
  copyEntry(cwd: string, from: string, to: string): Promise<FileMutationResponse>;
  /**
   * Whether {@link revealEntry} can actually open a file manager. False for the
   * in-process Obsidian transport, which has no way to drive the desktop shell
   * — surfaces hide the "Reveal in Finder" action rather than offering one that
   * fails, the same posture as {@link Transport.supportsTerminal}.
   */
  readonly supportsReveal: boolean;
  /**
   * Show an entry in the operating system's file manager, on the machine the
   * server runs on. Reads and writes nothing; the path is confined to `cwd`.
   * Rejects with `code: 'NOT_FOUND'` when the entry is gone.
   *
   * Gate calls on {@link Transport.supportsReveal} — a transport that cannot do
   * this rejects with `'unsupported'`.
   *
   * @param cwd - Session working directory the path is resolved within.
   * @param filePath - Target path, absolute or relative to `cwd`.
   */
  revealEntry(cwd: string, filePath: string): Promise<void>;

  /** Get git status (branch, changes) for a working directory. */
  getGitStatus(cwd?: string): Promise<GitStatusResponse | GitStatusError>;

  // --- Embedded terminal (web-only; ADR 260708-185521) ---

  /**
   * Attach an embedded terminal: spawn a server-side PTY in `cwd` (confined to
   * the directory boundary) and open a bidirectional byte channel to it. The
   * returned {@link TerminalHandle} exposes the raw output stream; feed input
   * back with {@link writeTerminal} and viewport changes with
   * {@link resizeTerminal}.
   *
   * Modeled on {@link subscribeSession}'s `AsyncIterable` + `AbortSignal` shape:
   * abort `signal` to tear the attachment down deterministically (the server
   * kills the PTY on idle/exit regardless).
   *
   * `DirectTransport` throws `'unsupported'` — gate calls on
   * {@link Transport.supportsTerminal}.
   *
   * @param cwd - Working directory to spawn the shell in (boundary-confined).
   * @param signal - Aborts the attachment and closes the underlying socket.
   */
  openTerminal(cwd: string, signal?: AbortSignal): Promise<TerminalHandle>;
  /**
   * Re-attach to an existing server-side PTY by id — the page-refresh recovery
   * path (DOR-225). Opens a fresh byte channel to a terminal created earlier by
   * {@link openTerminal}; the server replays the output it buffered while
   * detached, so the shell session survives a reload instead of being orphaned
   * and silently replaced.
   *
   * Rejects when the id is unknown — the PTY exited, was torn down, or lapsed
   * past its idle grace window (`workbench.terminalGraceTtlMinutes`). Callers
   * treat a rejection as "gone" and fall back to {@link openTerminal} to spawn a
   * fresh shell, seamlessly and with no user-visible error.
   *
   * `DirectTransport` throws `'unsupported'` — gate calls on
   * {@link Transport.supportsTerminal}.
   *
   * @param id - A terminal id returned by a prior {@link openTerminal}.
   * @param signal - Aborts the attachment and closes the underlying socket.
   */
  attachTerminal(id: string, signal?: AbortSignal): Promise<TerminalHandle>;
  /**
   * Explicitly tear down a terminal by id — destroy the server-side PTY, not
   * just detach from it. This is the user-initiated close (a tab's × button,
   * DOR-226), distinct from an unmount/refresh, which only detaches so the shell
   * stays re-attachable across a reload (DOR-225). Idempotent and best-effort:
   * a closed/already-gone PTY resolves cleanly.
   *
   * `DirectTransport` throws `'unsupported'` — gate calls on
   * {@link Transport.supportsTerminal}.
   *
   * @param id - A terminal id returned by a prior {@link openTerminal}.
   */
  closeTerminal(id: string): Promise<void>;
  /**
   * Write user input (keystrokes / paste) to a terminal's PTY stdin.
   *
   * @param handle - The attachment returned by {@link openTerminal}.
   * @param data - UTF-8 input to forward to the shell.
   */
  writeTerminal(handle: TerminalHandle, data: string): void;
  /**
   * Resize a terminal's PTY viewport (forwarded as a `TIOCSWINSZ`).
   *
   * @param handle - The attachment returned by {@link openTerminal}.
   * @param size - New viewport dimensions in character cells.
   */
  resizeTerminal(handle: TerminalHandle, size: { cols: number; rows: number }): void;

  // --- Workspaces (server-managed isolated checkouts; DOR-84) ---
  /** List workspaces (optionally one project), each with its attached sessions. */
  listWorkspaces(projectKey?: string): Promise<WorkspaceWithSessions[]>;
  /** Resolve an absolute path (e.g. a session cwd) to its containing workspace, or null. */
  resolveWorkspace(absPath: string): Promise<Workspace | null>;
  /** Provision-or-reuse the workspace for a unit of work. */
  ensureWorkspace(req: EnsureWorkspaceRequest): Promise<Workspace>;
  /** Pin or unpin a workspace (pinned workspaces are exempt from cleanup). */
  pinWorkspace(id: string, pinned: boolean): Promise<Workspace>;
  /** Remove a workspace; refuses a dirty one unless `force`. */
  removeWorkspace(id: string, force?: boolean): Promise<RemoveResult>;

  /** Server health check. */
  health(): Promise<HealthResponse>;
  /** Get server configuration (version, tunnel status, paths). */
  getConfig(): Promise<ServerConfig>;
  /** Partially update the persisted user config. */
  updateConfig(patch: Record<string, unknown>): Promise<void>;
  /**
   * Regenerate the per-instance local MCP token (DOR-278) and return the new
   * value. Only meaningful in login-off mode with no `MCP_API_KEY` override —
   * the server 409s otherwise. Rotating invalidates every previously configured
   * MCP client until it re-pastes the new token as its `Authorization: Bearer`
   * header.
   */
  rotateMcpLocalToken(): Promise<{ localToken: string }>;
  /**
   * Fetch the per-instance local MCP token on demand (DOR-278). The token never
   * rides `getConfig()` — it is revealed only through this POST-backed call so
   * it stays out of GET caches and logs, and the settings tab fetches it only
   * when the user asks. Only meaningful in login-off mode with no `MCP_API_KEY`
   * override — the server 409s otherwise.
   */
  revealMcpLocalToken(): Promise<{ localToken: string }>;
  /**
   * Relay a caught cockpit crash to the server's `POST /api/errors` intake
   * (DOR-318). Fire-and-forget and best-effort: it must never throw or surface
   * to the user. The server rebuilds and scrubs the report and only sends it
   * onward when error reporting is opted in — the client neither scrubs nor
   * gates. `DirectTransport` (Obsidian, in-process) no-ops: crash reporting is a
   * web-cockpit surface.
   *
   * @param report - The untrusted `{ name, message, stack }` from the caught error.
   */
  reportError(report: ClientErrorReport): Promise<void>;
  /**
   * List models available for the resolved runtime.
   *
   * Individual entries' fields are runtime-specific; callers should not depend
   * on runtime-only fields beyond the base `ModelOption` shape.
   *
   * @param opts - Optional context. `runtime` explicitly selects a runtime by
   *   type and takes precedence — the not-yet-started-session path where no
   *   metadata row exists yet, so `sessionId` would wrongly infer the default.
   *   `sessionId` otherwise scopes the call to the runtime that owns the
   *   session. Omit both for cold-discovery (onboarding, first-run).
   */
  getModels(opts?: { sessionId?: string; runtime?: string }): Promise<ModelOption[]>;
  /**
   * List available subagents reported by the resolved runtime.
   *
   * @param opts - Optional context; `sessionId` scopes the call to the runtime
   *   that owns the session. Omit for cold-discovery (onboarding, first-run).
   */
  getSubagents(opts?: { sessionId?: string }): Promise<SubagentInfo[]>;
  /**
   * Get capabilities for all registered runtimes.
   *
   * @returns A map of runtime type → capabilities, plus the default runtime type.
   */
  getCapabilities(): Promise<{
    capabilities: Record<string, RuntimeCapabilities>;
    defaultRuntime: string;
  }>;
  /** Check system requirements (external dependencies) for all registered runtimes. */
  checkRequirements(): Promise<SystemRequirements>;
  /**
   * Provision a runtime's CLI binary on demand (opt-in install, ADR-0317).
   *
   * Installs the runtime's package into a DorkOS-owned location and resolves to
   * the terminal result; when `onProgress` is supplied, streamed install progress
   * is delivered to it. Loopback-only server action. On failure the partial
   * install is cleaned up and the result carries an honest error.
   *
   * Not every runtime can be provisioned in one click — a runtime whose server
   * does not expose a provision endpoint rejects (e.g. HTTP 404), which the
   * caller degrades into the manual install hint rather than a dead end.
   *
   * @param runtimeType - Runtime type to install, e.g. `'opencode'` or `'codex'`.
   * @param onProgress - Optional callback for streamed install progress frames.
   */
  provisionRuntime(
    runtimeType: string,
    onProgress?: (progress: RuntimeProvisionProgress) => void
  ): Promise<RuntimeProvisionResult>;

  // --- Runtime Connect (terminal-free auth; ADR-0318, T1) ---

  /**
   * Store a runtime's native API key (paste-key path). The secret is encrypted
   * at rest and only its REFERENCE is persisted in config — the response returns
   * the reference, never the secret. Loopback-only server action.
   *
   * @param type - Runtime type (`'claude-code'` | `'codex'`).
   * @param secret - The raw API key. Sent once; never returned or logged.
   */
  storeRuntimeCredential(type: string, secret: string): Promise<StoreCredentialResult>;
  /**
   * Store an OpenCode Direct-provider's API key by reference and select it as
   * OpenCode's provider, recording an optional OpenAI-compatible base URL. The
   * secret is encrypted at rest and only its REFERENCE is persisted; the response
   * returns the reference, never the secret. Loopback-only server action.
   *
   * @param providerId - OpenAI-compatible provider id (e.g. `openai`).
   * @param secret - The raw provider API key. Sent once; never returned or logged.
   * @param baseURL - Optional base URL override; `null` clears a stored override.
   */
  storeProviderCredential(
    providerId: string,
    secret: string,
    baseURL?: string | null
  ): Promise<StoreCredentialResult>;
  /**
   * Delegate a vendor CLI login (`claude auth login` / `codex login`), spawned
   * terminal-free, resolving once the CLI reports a completed login. Bounded by a
   * server-side timeout so a never-completed login resolves to `{ ok: false }`
   * rather than blocking. Loopback-only server action.
   *
   * @param type - Runtime type (`'claude-code'` | `'codex'`).
   */
  delegateRuntimeLogin(type: string): Promise<DelegatedLoginResult>;
  /**
   * Validate and store an OpenRouter API key (Gateway paste-key path). The key is
   * validated against OpenRouter before being stored as a reference; the response
   * never echoes it. Loopback-only server action.
   *
   * @param key - The raw OpenRouter API key. Sent once; never returned or logged.
   */
  storeOpenRouterKey(key: string): Promise<OpenRouterKeyResult>;
  /**
   * Begin the OpenRouter OAuth-PKCE flow. Returns the authorize URL for the
   * client to open in a browser plus the flow `state` to poll; the `code_verifier`
   * stays server-side. Loopback-only server action.
   */
  startOpenRouterOAuth(): Promise<OpenRouterOAuthStart>;
  /**
   * Poll the status of an in-flight OpenRouter OAuth-PKCE flow. Resolves to
   * `connected` once the loopback callback exchanged the code for a scoped key.
   *
   * @param state - The flow id returned by {@link startOpenRouterOAuth}.
   */
  getOpenRouterOAuthStatus(state: string): Promise<OpenRouterOAuthStatus>;
  /**
   * Detect a local Ollama with zero auth: whether it is running and which coding
   * models are pulled. Bounded probe — an absent/hung Ollama degrades fast.
   */
  detectOllama(): Promise<OllamaStatus>;
  /**
   * Fetch the curated coding-model catalog for the local model shelf, each entry
   * assessed against this machine's hardware with an honest fit verdict
   * (`runs-well | may-be-slow | too-large`). A static estimate, never a benchmark.
   * Loopback-only server action.
   */
  getOllamaModelCatalog(): Promise<OllamaModelCatalog>;
  /**
   * Trigger a single Ollama pull and stream download progress. Accepts any
   * syntactically valid Ollama tag — curated or not — so a person can pull any
   * model by name, not only the curated shelf. Resolves to the terminal result;
   * when `onProgress` is supplied, streamed progress frames are delivered to it.
   * DorkOS only triggers the pull — it never owns or manages Ollama. Loopback-only
   * server action.
   *
   * @param model - Any valid Ollama model tag to pull (e.g. `qwen2.5-coder:32b`).
   * @param onProgress - Optional callback for streamed download-progress frames.
   */
  pullOllamaModel(
    model: string,
    onProgress?: (progress: OllamaPullProgress) => void
  ): Promise<OllamaPullResult>;
  /**
   * Install Ollama on demand and stream install progress (spec §13). A guided,
   * password-free install: macOS via Homebrew, Windows via winget. Resolves to the
   * terminal {@link OllamaProvisionResult}, whose `installMethod` reports which
   * path ran and whose `status` re-probe tells the caller whether Ollama is
   * already running. When no one-click path exists (`installMethod: 'manual'`) the
   * result carries `ok: false` and the client shows the copyable command instead —
   * DorkOS never installs with elevated privileges. Loopback-only server action.
   *
   * @param onProgress - Optional callback for streamed install progress frames.
   */
  provisionOllama(
    onProgress?: (progress: RuntimeProvisionProgress) => void
  ): Promise<OllamaProvisionResult>;
  /**
   * Every live binding and scheduled task currently set to run an agent without
   * asking anyone — the one read behind the standing unattended-autonomy banner.
   *
   * Cheap by construction — two small filters and one synchronous SELECT, no
   * awaiting anything — so an app-wide banner can hold the answer for the life
   * of the page instead of asking per route.
   */
  getUnattendedAutonomy(): Promise<UnattendedAutonomyState>;
  /** Start the ngrok tunnel and return the public URL. */
  startTunnel(): Promise<{ url: string }>;
  /** Stop the ngrok tunnel. */
  stopTunnel(): Promise<void>;

  // --- Tasks ---

  /** List all Tasks. */
  listTasks(): Promise<Task[]>;
  /** Create a new Task. */
  createTask(opts: CreateTaskInput): Promise<Task>;
  /** Update an existing Task. */
  updateTask(id: string, opts: UpdateTaskRequest): Promise<Task>;
  /** Delete a Task. */
  deleteTask(id: string): Promise<{ success: boolean }>;
  /** Trigger a manual run of a Task. */
  triggerTask(id: string): Promise<{ runId: string }>;
  /** List Task runs with optional filters. */
  listTaskRuns(opts?: Partial<ListTaskRunsQuery>): Promise<TaskRun[]>;
  /** Get a specific Task run. */
  getTaskRun(id: string): Promise<TaskRun>;
  /**
   * Ask a running Task to stop.
   *
   * Resolves only when a runner has the request or there was nothing left to
   * stop; a request nothing acknowledged REJECTS, because "we asked" and "it
   * stopped" are different facts and the second is the one people act on.
   */
  cancelTaskRun(id: string): Promise<CancelTaskRunResponse>;
  /** Fetch available Task templates for onboarding. */
  getTaskTemplates(): Promise<TaskTemplate[]>;

  // --- Relay Message Bus ---

  /** List relay messages with optional filters. */
  listRelayMessages(filters?: {
    subject?: string;
    status?: string;
    from?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ messages: unknown[]; nextCursor?: string }>;
  /** Get a single relay message by ID. */
  getRelayMessage(id: string): Promise<unknown>;
  /** Send a relay message. */
  sendRelayMessage(opts: {
    subject: string;
    payload: unknown;
    from: string;
    replyTo?: string;
  }): Promise<{ messageId: string; deliveredTo: number }>;
  /** List relay endpoints. */
  listRelayEndpoints(): Promise<unknown[]>;
  /** Register a relay endpoint. */
  registerRelayEndpoint(subject: string): Promise<unknown>;
  /** Unregister a relay endpoint. */
  unregisterRelayEndpoint(subject: string): Promise<{ success: boolean }>;
  /** Read inbox for a relay endpoint. */
  readRelayInbox(
    subject: string,
    opts?: { status?: string; cursor?: string; limit?: number }
  ): Promise<{ messages: unknown[]; nextCursor?: string }>;
  /** Get relay system metrics. */
  getRelayMetrics(): Promise<unknown>;
  /** List dead-letter messages with optional filters. */
  listRelayDeadLetters(filters?: { endpointHash?: string }): Promise<unknown[]>;
  /** List aggregated dead-letter groups (collapsed by source + reason). */
  listAggregatedDeadLetters(): Promise<{ groups: AggregatedDeadLetter[] }>;
  /** Dismiss all dead letters matching a source + reason pair. */
  dismissDeadLetterGroup(source: string, reason: string): Promise<{ dismissed: number }>;
  /** List relay conversations (grouped request/response exchanges with human labels). */
  listRelayConversations(): Promise<{ conversations: RelayConversation[] }>;

  // --- Relay Convergence ---

  /** Send a message via Relay, returns receipt. Only available when Relay enabled. */
  sendMessageRelay(
    sessionId: string,
    content: string,
    options?: { clientId?: string; correlationId?: string; cwd?: string }
  ): Promise<{ messageId: string; traceId: string }>;
  /** Get full trace for a message. */
  getRelayTrace(messageId: string): Promise<{ traceId: string; spans: TraceSpan[] }>;
  /** Get aggregate delivery metrics. */
  getRelayDeliveryMetrics(): Promise<DeliveryMetrics>;

  // --- Relay Adapters ---

  /** List all relay adapters with their live status. */
  listRelayAdapters(): Promise<AdapterListItem[]>;
  /** Enable or disable a relay adapter by ID. */
  toggleRelayAdapter(id: string, enabled: boolean): Promise<{ ok: boolean }>;
  /** Retrieve the adapter catalog with available types and configured instances. */
  getAdapterCatalog(): Promise<CatalogEntry[]>;
  /** Add a new relay adapter instance. */
  addRelayAdapter(
    type: string,
    id: string,
    config: Record<string, unknown>
  ): Promise<{ ok: boolean }>;
  /** Remove a relay adapter by ID. */
  removeRelayAdapter(id: string): Promise<{ ok: boolean }>;
  /** Update the config for an existing relay adapter. */
  updateRelayAdapterConfig(id: string, config: Record<string, unknown>): Promise<{ ok: boolean }>;
  /** Test connectivity for an adapter type and config without registering it. */
  testRelayAdapterConnection(
    type: string,
    config: Record<string, unknown>
  ): Promise<{ ok: boolean; error?: string; botUsername?: string }>;
  /** Fetch adapter lifecycle events by adapter instance ID. */
  getAdapterEvents(adapterId: string, limit?: number): Promise<{ events: AdapterEvent[] }>;
  /** Get observed chats for an adapter (for chatId picker). */
  getObservedChats(adapterId: string): Promise<ObservedChat[]>;

  // --- Relay Bindings ---

  /** List all adapter-agent bindings. */
  getBindings(): Promise<AdapterBinding[]>;
  /** Create a new adapter-agent binding. */
  createBinding(input: CreateBindingRequest): Promise<AdapterBinding>;
  /** Delete an adapter-agent binding by ID. */
  deleteBinding(id: string): Promise<void>;
  /** Update an existing binding's mutable fields. */
  updateBinding(id: string, updates: UpdateBindingRequest): Promise<AdapterBinding>;
  /**
   * Re-point an existing binding at a different agent, keeping its id. The
   * answer to a `CHAT_ALREADY_BOUND` rejection: one chat reaches one agent, so
   * moving the binding that already owns the chat is the only way to change
   * who answers it (connection-scoping spec §Part 2).
   *
   * @param id - The binding to re-point.
   * @param agentId - The agent that should answer from now on.
   */
  moveBinding(id: string, agentId: string): Promise<AdapterBinding>;
  /**
   * Send a synthetic test probe through a binding. The server short-circuits
   * before invoking the agent; no real messages are delivered to any platform.
   *
   * @param bindingId - The binding to test
   */
  testBinding(bindingId: string): Promise<BindingTestResult>;

  // --- Mesh Agent Discovery ---

  /** List registered agents with their project paths (lightweight, for onboarding). */
  listMeshAgentPaths(): Promise<{ agents: AgentPathEntry[] }>;
  /** Discover agent candidates by scanning filesystem roots. */
  discoverMeshAgents(
    roots: string[],
    maxDepth?: number
  ): Promise<{ candidates: DiscoveryCandidate[] }>;
  /** List registered mesh agents with optional filters. */
  listMeshAgents(filters?: {
    runtime?: string;
    capability?: string;
  }): Promise<{ agents: AgentManifest[] }>;
  /** Get a single mesh agent by ID. */
  getMeshAgent(id: string): Promise<AgentManifest>;
  /**
   * Register a discovered agent into the mesh registry.
   *
   * @param path - The agent's project directory
   * @param overrides - Manifest field overrides (name + runtime required)
   * @param approver - Identifier of the approving entity
   * @param scanRoot - Scan root the agent was found under; drives ADR-0032
   *   namespace derivation. Omit to use the server default (homedir-relative).
   */
  registerMeshAgent(
    path: string,
    overrides?: Partial<AgentManifest>,
    approver?: string,
    scanRoot?: string
  ): Promise<AgentManifest>;
  /** Update an existing mesh agent's metadata. */
  updateMeshAgent(id: string, updates: Partial<AgentManifest>): Promise<AgentManifest>;
  /** Unregister a mesh agent by ID. */
  unregisterMeshAgent(id: string): Promise<{ success: boolean }>;
  /** Delete an agent and its `.dork` directory by ID. */
  deleteAgentData(id: string): Promise<{ success: boolean; deletedPath: string }>;
  /** Deny a discovered agent path, preventing future registration. */
  denyMeshAgent(path: string, reason?: string, denier?: string): Promise<{ success: boolean }>;
  /** List all denied agent paths. */
  listDeniedMeshAgents(): Promise<{ denied: DenialRecord[] }>;
  /** Clear a denial record for a previously denied path. */
  clearMeshDenial(path: string): Promise<{ success: boolean }>;

  // --- Mesh Observability ---

  /** Get aggregate mesh health status. */
  getMeshStatus(): Promise<MeshStatus>;
  /** Get health details for a single agent. */
  getMeshAgentHealth(id: string): Promise<AgentHealth>;
  /** Send a heartbeat for an agent to update its last-seen timestamp. */
  sendMeshHeartbeat(id: string, event?: string): Promise<{ success: boolean }>;

  // --- Mesh Topology ---

  /** Get the mesh topology view, optionally scoped to a namespace. */
  getMeshTopology(namespace?: string): Promise<TopologyView>;
  /** Create or update a cross-namespace access rule. */
  updateMeshAccessRule(body: UpdateAccessRuleRequest): Promise<CrossNamespaceRule>;
  /** Get reachable agents for a specific agent. */
  getMeshAgentAccess(agentId: string): Promise<{ agents: AgentManifest[] }>;

  // --- Agent Identity (always available, no feature flag) ---

  /** Get the agent manifest for a working directory. Returns null if no agent registered. */
  getAgentByPath(path: string): Promise<AgentManifest | null>;
  /** Batch resolve agents for multiple paths. Returns a map of path -> manifest|null. */
  resolveAgents(paths: string[]): Promise<Record<string, AgentManifest | null>>;
  /** Update an agent's fields by path. Returns the updated manifest. */
  updateAgentByPath(path: string, updates: AgentManifestUpdate): Promise<AgentManifest>;
  /** Create a new agent: mkdir + scaffold files + register. Returns the created manifest and resolved path. */
  createAgent(opts: CreateAgentOptions): Promise<AgentManifest & { _path: string }>;

  // --- Discovery ---

  /**
   * Stream discovery scan results progressively via SSE.
   *
   * @param options - Scan roots, depth, and timeout options
   * @param onEvent - Callback invoked for each streamed scan event
   * @param signal - Optional AbortSignal to cancel the scan
   */
  scan(
    options: TransportScanOptions,
    onEvent: (event: TransportScanEvent) => void,
    signal?: AbortSignal
  ): Promise<void>;

  // --- File Uploads ---

  /**
   * Upload files to the session's working directory for agent access.
   *
   * Files are stored in `{cwd}/.dork/.temp/uploads/` with sanitized filenames.
   * The returned `savedPath` values can be injected into message text so the
   * resolved runtime reads them with its existing filesystem tools.
   *
   * Implementations MUST fail rather than hang: an upload that goes silent is
   * rejected, and an aborted `signal` cancels the request itself, not merely the
   * caller's view of it. A composer whose upload can neither finish nor be
   * stopped is a composer nobody can type in (DOR-494).
   *
   * @param files - Files to upload (browser File objects or UploadFile-compatible objects)
   * @param cwd - Working directory where files will be stored
   * @param onProgress - Optional callback for upload progress (useful for remote/tunnel uploads)
   * @param signal - Optional AbortSignal to cancel the upload in flight
   */
  uploadFiles(
    files: UploadFile[],
    cwd: string,
    onProgress?: (progress: UploadProgress) => void,
    signal?: AbortSignal
  ): Promise<UploadResult[]>;

  // --- Directory Operations ---

  /** Create a new directory within the boundary. Used by DirectoryPicker "New Folder". */
  createDirectory(parentPath: string, folderName: string): Promise<{ path: string }>;

  // --- Admin Operations ---

  /**
   * List the MCP servers visible to a runtime for a project directory.
   *
   * Resolves the runtime (explicit `opts.runtime`, else the server default) and
   * returns ITS servers: the runtime's live `getMcpStatus`, or — for the
   * `claude-code` runtime only — a fallback read of `<projectPath>/.mcp.json`.
   * A non-Claude runtime with no live status returns an empty list rather than
   * reading that Claude-format file (an honest "no MCP servers").
   *
   * @param projectPath - Absolute project directory to resolve MCP config for.
   * @param opts - Optional context; `runtime` selects a specific runtime by type
   *   (e.g. a Codex session must not inherit a Claude session's cwd cache).
   */
  getMcpConfig(projectPath: string, opts?: { runtime?: string }): Promise<McpConfigResponse>;

  // --- Managed MCP servers (per-agent; DOR-891, spec `mcp-server-management`) ---

  /**
   * List an agent's DorkOS-managed MCP servers (the `mcp.list` capability).
   *
   * Each entry is the stored config plus a derived `authStatus` saying whether a
   * remote server has a live DorkOS-held sign-in — available immediately, with
   * no agent turn required. Join with {@link getMcpConfig} live status by `name`
   * for the runtime's connection state and tool count.
   *
   * @param agentId - ULID of the agent whose managed servers to read.
   */
  listAgentMcpServers(agentId: string): Promise<ManagedMcpServerView[]>;

  /**
   * Add a managed MCP server to an agent (the destructive `mcp.add` capability).
   *
   * Destructive: the first call returns `{ status: 'approval_required' }` with
   * the command/args/url a person must confirm. Grant it with
   * {@link grantApproval} and call again with the returned `approvalToken` in
   * `opts` to complete the write.
   *
   * @param input - Agent id, server name, connection, and optional enabled flag.
   * @param opts - Carries `approvalToken` on the confirming retry.
   */
  addAgentMcpServer(
    input: AddAgentMcpServerInput,
    opts?: { approvalToken?: string }
  ): Promise<AgentMcpMutationResult>;

  /**
   * Bring a discovered `.mcp.json` server under DorkOS management (the
   * destructive `mcp.import` capability). The connection is resolved server-side
   * from the name; the client never supplies it.
   *
   * Destructive: the first call returns `{ status: 'approval_required' }`; grant
   * it with {@link grantApproval} and call again with the returned `approvalToken`
   * in `opts` to complete the import.
   *
   * @param input - Agent id and the discovered server name to import.
   * @param opts - Carries `approvalToken` on the confirming retry.
   */
  importAgentMcpServer(
    input: ImportAgentMcpServerInput,
    opts?: { approvalToken?: string }
  ): Promise<AgentMcpMutationResult>;

  /**
   * Update a managed MCP server (the destructive `mcp.update` capability).
   * Changing `connection` re-prompts approval; the retry carries `approvalToken`.
   *
   * @param input - Agent id, server name, and the fields to change.
   * @param opts - Carries `approvalToken` on the confirming retry.
   */
  updateAgentMcpServer(
    input: UpdateAgentMcpServerInput,
    opts?: { approvalToken?: string }
  ): Promise<AgentMcpMutationResult>;

  /**
   * Remove a managed MCP server (the `mcp.remove` capability). Reversible by
   * re-adding, so it is not approval-gated.
   *
   * @param agentId - ULID of the owning agent.
   * @param name - Name of the server to remove.
   */
  removeAgentMcpServer(agentId: string, name: string): Promise<ManagedMcpServer[]>;

  /**
   * Enable a managed MCP server (the `mcp.enable` capability). No new command is
   * introduced — it was approved at add — so this is not approval-gated.
   *
   * @param agentId - ULID of the owning agent.
   * @param name - Name of the server to enable.
   */
  enableAgentMcpServer(agentId: string, name: string): Promise<ManagedMcpServer[]>;

  /**
   * Disable a managed MCP server (the `mcp.disable` capability), withholding it
   * from injection without removing its config.
   *
   * @param agentId - ULID of the owning agent.
   * @param name - Name of the server to disable.
   */
  disableAgentMcpServer(agentId: string, name: string): Promise<ManagedMcpServer[]>;

  /**
   * Probe an existing managed MCP server (the `mcp.test` capability): whether it
   * connects and how many tools it exposes. Safe by construction — only ever an
   * already-approved entry.
   *
   * @param agentId - ULID of the owning agent.
   * @param name - Name of the server to probe.
   */
  testAgentMcpServer(agentId: string, name: string): Promise<AgentMcpTestResult>;

  /**
   * Start an OAuth sign-in for a managed MCP server (the `mcp.signin` capability,
   * DOR-943). DorkOS owns the whole OAuth lifecycle and injects the resulting
   * token itself; the client shows the returned custody disclosure, opens the
   * `authorizeUrl` in a new tab, then polls {@link pollMcpSignin}. `act`-tier —
   * the server was already approved at add, so no second approval gate.
   *
   * @param agentId - ULID of the agent that owns the server.
   * @param name - Name of the managed (http/sse) server to sign in to.
   */
  startMcpSignin(agentId: string, name: string): Promise<StartMcpSigninResult>;

  /**
   * Check whether a managed-MCP sign-in has completed (the `mcp.poll_signin`
   * capability, DOR-943). Poll after the person opens the sign-in link; once
   * `connected`, the server's tools inject on the agent's next turn.
   *
   * @param flowId - The flow id from {@link startMcpSignin}.
   */
  pollMcpSignin(flowId: string): Promise<McpSigninPollResult>;

  /**
   * Store app credentials the operator got from a provider that will not let
   * DorkOS register itself (the `mcp.set_client` capability, DOR-982), then let
   * {@link startMcpSignin} run exactly as it always does — it picks the stored
   * client up and skips the automatic-registration step entirely.
   *
   * Replacing the client identity invalidates anything issued to the old one, so
   * this forgets the server's stored sign-in as part of saving.
   *
   * @param agentId - ULID of the agent that owns the server.
   * @param name - Name of the managed (http/sse) server the credentials are for.
   * @param credentials - The client id, and the client secret when there is one.
   */
  setMcpClientCredentials(
    agentId: string,
    name: string,
    credentials: McpClientCredentials
  ): Promise<void>;

  /**
   * Obtain a Claude-specific plugin sub-transport for a session.
   *
   * Returns a `ClaudePluginTransport` bound to `sessionId`. Callers MUST
   * pre-gate on the session runtime's `capabilities.supportsPlugins`
   * (resolve the runtime from the session row, then look it up in the static
   * capabilities map — e.g. `useCapabilitiesForRuntime(useSessionRuntime(id))`)
   * before invoking `reloadPlugins` — this method is the lazy handle, not the
   * capability gate.
   *
   * Implementations differ:
   * - `HttpTransport` cannot synchronously resolve capabilities, so it always
   *   returns a concrete handle. Invocations against non-Claude runtimes are
   *   rejected by the server route (501).
   * - `DirectTransport` has synchronous access to the embedded runtime's
   *   capabilities and returns `null` as a secondary guard when plugins are
   *   unsupported. This null-return is a defense-in-depth optimization, NOT
   *   the primary capability gate.
   *
   * Either way: callers must check `supportsPlugins` at the UI layer first.
   *
   * @param sessionId - Session whose runtime owns the sub-transport handle.
   */
  asClaudePluginTransport(sessionId: string): ClaudePluginTransport | null;

  /** Initiate a factory reset: delete all DorkOS data and restart the server. */
  resetAllData(confirm: string): Promise<{ message: string }>;
  /** Initiate a graceful server restart. */
  restartServer(): Promise<{ message: string }>;

  // --- Activity Feed ---

  /** List activity events with optional filters and cursor-based pagination. */
  listActivityEvents(query?: Partial<ListActivityQuery>): Promise<ListActivityResponse>;

  // --- Templates ---

  /** Fetch the merged template catalog (builtin + user templates). */
  getTemplates(): Promise<TemplateEntry[]>;

  // --- Default Agent ---

  /** Set the default agent by name. Updates config.agents.defaultAgent. */
  setDefaultAgent(agentName: string): Promise<void>;

  // --- Marketplace ---

  /**
   * List packages from all enabled marketplace sources, with optional filtering.
   *
   * @param filter - Optional filter by marketplace source or free-text query.
   */
  listMarketplacePackages(filter?: PackageFilter): Promise<AggregatedPackage[]>;

  /**
   * Fetch and validate a single package entry by name, returning its manifest
   * and a permission preview.
   *
   * @param name - Package name (e.g. `@org/my-plugin`). Will be URL-encoded.
   * @param marketplace - Restrict lookup to a specific marketplace source name.
   */
  getMarketplacePackage(name: string, marketplace?: string): Promise<MarketplacePackageDetail>;

  /**
   * Build a permission preview for a package without installing it.
   *
   * @param name - Package name. Will be URL-encoded.
   * @param opts - Optional install options (marketplace, source, projectPath).
   */
  previewMarketplacePackage(name: string, opts?: InstallOptions): Promise<MarketplacePackageDetail>;

  /**
   * Install a marketplace package.
   *
   * @param name - Package name. Will be URL-encoded.
   * @param opts - Install options (force, yes, marketplace, source, projectPath).
   */
  installMarketplacePackage(name: string, opts?: InstallOptions): Promise<InstallResult>;

  /**
   * Uninstall a marketplace package.
   *
   * @param name - Package name. Will be URL-encoded.
   * @param opts - Uninstall options (purge, projectPath).
   */
  uninstallMarketplacePackage(name: string, opts?: UninstallOptions): Promise<UninstallResult>;

  /**
   * Check for (and optionally apply) updates to a marketplace package.
   *
   * Advisory by default — pass `{ apply: true }` to reinstall in place.
   *
   * @param name - Package name. Will be URL-encoded.
   * @param opts - Update options (apply, projectPath).
   */
  updateMarketplacePackage(name: string, opts?: UpdateOptions): Promise<UpdateResult>;

  /**
   * List installed marketplace packages.
   *
   * Without `projectPath`: one entry per installation across ALL scopes — the
   * global roots plus every registered agent's local installs, each tagged
   * with scope and agent identity. With `projectPath`: the merged view for
   * that single project (one entry per name), used for scope-accurate
   * reinstall detection in the install dialog.
   *
   * @param projectPath - Optional agent project path for the merged view.
   */
  listInstalledPackages(projectPath?: string): Promise<InstalledPackage[]>;

  /**
   * List every installation of a single package across all scopes (global +
   * each agent), each enriched with its capability summary (`provides`:
   * command/skill counts + hooks). Used by the package detail drawer to
   * render the installations panel. Rejects with a 404 error when the package
   * is not installed anywhere.
   *
   * @param name - Installed package name.
   */
  listPackageInstallations(name: string): Promise<InstalledPackage[]>;

  /** List all configured marketplace sources. */
  listMarketplaceSources(): Promise<MarketplaceSource[]>;

  /**
   * Add a new marketplace source.
   *
   * @param input - Source name, URL, and optional enabled flag.
   */
  addMarketplaceSource(input: AddSourceInput): Promise<MarketplaceSource>;

  /**
   * Remove a configured marketplace source by name.
   *
   * @param name - Source name. Will be URL-encoded.
   */
  removeMarketplaceSource(name: string): Promise<void>;

  // --- Approvals (spec `agent-trust` §3.3) ---

  /**
   * List approvals an agent has requested and nobody has decided yet, oldest
   * first. Expired requests are excluded and no token material is returned.
   */
  listPendingApprovals(): Promise<PendingApprovalsResponse>;

  /**
   * Allow a pending approval, letting the requester spend its token once on
   * exactly the action it was granted for.
   *
   * With `standing: true` it also opens a standing permission, so DorkOS stops
   * asking about that agent doing that thing until the window closes. The two
   * travel together on purpose: a caller that asked for both and can only have
   * one is refused outright rather than quietly given the one-time yes, because
   * a silent fallback would leave a person believing they created a permission
   * that does not exist (spec `agent-approval-settings` §3.5).
   *
   * @param approvalId - The approval's id, from {@link listPendingApprovals}.
   * @param options - Set `standing` to also stop being asked about this pair.
   */
  grantApproval(
    approvalId: string,
    options?: { standing?: boolean }
  ): Promise<ApprovalDecisionResponse>;

  /**
   * Refuse a pending approval.
   *
   * @param approvalId - The approval's id, from {@link listPendingApprovals}.
   * @param reason - Optional note the requester sees instead of a bare refusal.
   */
  denyApproval(approvalId: string, reason?: string): Promise<ApprovalDecisionResponse>;

  /**
   * The standing permissions that are live right now, soonest to expire first.
   *
   * A permission a person cannot find is a dark pattern, so this is what both
   * places that list one read (spec `agent-approval-settings` §3.7).
   */
  listStandingPermissions(): Promise<StandingPermissionsResponse>;

  /**
   * End one standing permission, so DorkOS asks again next time.
   *
   * Ending one stops the next action; it does not reverse anything that already
   * ran.
   *
   * @param grantId - The permission's id, from {@link listStandingPermissions}.
   */
  revokeStandingPermission(grantId: string): Promise<RevokeStandingPermissionResponse>;

  // --- The Inbox (spec `notification-system`) ---

  /**
   * One page of the operator's notification history, newest first.
   *
   * The filters are LENSES rather than a search: the bell reads it unfiltered,
   * an agent's profile with `agentId`, a session's menu with `sessionId`. Every
   * page carries `unreadCount` for the WHOLE store regardless of the filter,
   * because that is the number the bell draws and a bell that counted only the
   * open lens would go quiet the moment somebody opened one agent.
   *
   * Paging is by `before`, the ULID id of the last row on the previous page —
   * ULIDs already sort by creation time, so two notifications raised in the same
   * millisecond can be neither skipped nor repeated.
   *
   * @param query - The lens and the cursor. Omit for the newest page of everything.
   */
  listNotifications(query?: Partial<ListNotificationsQuery>): Promise<ListNotificationsResponse>;

  /**
   * Mark one notification read.
   *
   * Read state is server-side and shared, so clearing it on the laptop clears it
   * on the phone: the server answers the new unread count and broadcasts
   * `notification_read` to every other window.
   *
   * @param id - The notification's id.
   */
  markNotificationRead(id: string): Promise<MarkNotificationsReadResponse>;

  /** Mark every unread notification read, wherever it is filed. */
  markAllNotificationsRead(): Promise<MarkNotificationsReadResponse>;

  // --- Web push (spec `notification-system` task 4.3, ADR 260819-234829) ---

  /**
   * The public half of this install's VAPID keypair, which a browser needs
   * before it can subscribe.
   *
   * Answers `{ key: null }` when this install cannot do web push at all, so a
   * client can show "not available here" instead of a button that fails.
   */
  getPushVapidPublicKey(): Promise<VapidPublicKeyResponse>;

  /**
   * Remember this browser, so a blocked agent can reach it once DorkOS is
   * closed.
   *
   * Idempotent by endpoint: re-subscribing the same browser refreshes the row
   * rather than adding a second one, which is what makes it safe to call on
   * every load.
   *
   * @param subscription - Exactly what `PushManager.subscribe()` produced.
   */
  registerPushSubscription(
    subscription: RegisterPushSubscriptionRequest
  ): Promise<RegisterPushSubscriptionResponse>;

  /** Every browser currently subscribed, for the device list in Settings. */
  listPushSubscriptions(): Promise<ListPushSubscriptionsResponse>;

  /**
   * Stop pushing to one browser.
   *
   * @param id - The subscription's id, from {@link Transport.listPushSubscriptions}.
   */
  deletePushSubscription(id: string): Promise<DeletePushSubscriptionResponse>;

  // --- Team roster (spec `identity-consistency` §W2.2, ADR 260806-222535) ---

  /**
   * Read every identity on this install — the operator first, then everyone
   * else, then the agents.
   *
   * One read-only projection over registries that already exist; it mints
   * nothing and there is no write counterpart, which is why this is a single
   * method rather than a domain. A source that could not be read contributes a
   * `warnings[]` entry and zero rows, so the caller renders a degraded roster
   * rather than an error page — the person reading the page is still on it.
   * `warnings` is omitted entirely on a clean read, never `[]`.
   */
  getTeamRoster(): Promise<TeamRosterResponse>;

  /**
   * The rooms one roster member is in — what their profile's Rooms row counts
   * and its Rooms page lists (spec `profile-unification` §3.2).
   *
   * `memberId` is a roster id from {@link getTeamRoster}, whichever kind of
   * identity it names; the server owns the translation to whatever the rooms
   * domain stores. Archived rooms are left out and the newest activity comes
   * first.
   *
   * A member who is in no rooms answers `{ rooms: [] }`. Only an id this
   * install has never heard of rejects (404), so "nowhere yet" and "nobody by
   * that name" stay distinguishable — a profile draws different words for each.
   *
   * @param memberId - The member's roster id.
   */
  listMemberRooms(memberId: string): Promise<MemberRoomsResponse>;

  // --- The operator's own profile (spec `identity-consistency` §W3.3, §W3.5) ---

  /**
   * Set what the person at the keyboard wants to be called.
   *
   * Writes the two sources the roster reads above the author record — the
   * account name and the stored profile — so nothing can end up half-renamed.
   * The author record is deliberately not one of them; `routes/profile.ts` says
   * why at length.
   *
   * @param displayName - The new name. Trimmed, 1–80 characters; the server
   *   refuses anything else rather than blanking the roster row.
   */
  updateProfile(displayName: string): Promise<ProfileUpdateResponse>;

  /**
   * Replace the operator's photo.
   *
   * PNG, JPEG or WebP, 2 MB or less, decided by the bytes rather than the
   * filename — an SVG or a mislabelled GIF is refused (`AVATAR_TYPE_UNSUPPORTED`),
   * as is anything over the cap (`AVATAR_TOO_LARGE`). Nothing is resized.
   *
   * @param file - The image bytes.
   * @param filename - What to call it in the multipart part. Cosmetic: the
   *   server reads the bytes and ignores this.
   * @returns The URL to render and to keep. Opaque — server-relative today,
   *   absolute the day a remote store backs it.
   */
  uploadProfileAvatar(file: Blob, filename: string): Promise<ProfileAvatarResponse>;

  /**
   * Remove the operator's photo, so their disc falls back to their emoji and
   * then to their initial. Idempotent.
   */
  deleteProfileAvatar(): Promise<void>;

  // --- Read state (spec `team-room-home` §D4, ADR 260808-140956) ---

  /**
   * Move the caller's read cursor forward in one thread — a room, an agent
   * session, or the inbox.
   *
   * One method for all three, because there is one table and one route behind
   * it — a room has no read-cursor method of its own, it is `threadKind:
   * 'room'`. What an AGENT has been shown is a different fact living on its
   * `room_members` row, advanced by the ambient participation loop as entries
   * are delivered to it; this cursor is what a PERSON has looked at, and neither
   * is derived from the other.
   *
   * **Monotonic, so this is safe to call on every scroll.** A position at or
   * below the stored one is ignored rather than refused, which is what stops a
   * stale second device from un-reading a thread. It also means a call that
   * changes nothing broadcasts nothing, so a caller cannot make the cursor
   * announce itself by re-sending the same number.
   *
   * @param threadKind - Which kind of thread `threadId` names.
   * @param threadId - The thread.
   * @param lastReadSeq - The position now read to. What the number counts is per
   *   kind — see `SetReadCursorPositionRequestSchema` — a room entry's `seq`, or
   *   for a session how many transcript messages the reader has seen.
   * @returns The cursor as it now stands — the higher of the stored value and
   *   the requested one.
   */
  setReadCursor(
    threadKind: ReadCursorThreadKind,
    threadId: string,
    lastReadSeq: number
  ): Promise<ReadCursor>;

  /**
   * Read the caller's own cursor in one thread, or `null` when they have never
   * read it.
   *
   * The read half of {@link setReadCursor}, and the same rule about whose state
   * this is: there is no way to name a user, so a client can only ever ask about
   * its own. A thread nobody has opened answers `null` rather than a zero
   * cursor, because "never read" draws no unread rule while "read up to 0" does.
   *
   * @param threadKind - Which kind of thread `threadId` names.
   * @param threadId - The thread.
   * @returns The caller's cursor, or `null` when they have never read this thread.
   */
  getReadCursor(threadKind: ReadCursorThreadKind, threadId: string): Promise<ReadCursor | null>;

  // --- Shapes (DOR-355) ---

  /**
   * List every installed Shape, each tagged with its active flag
   * (`ui.shapes.active`) and fork lineage.
   */
  listShapes(): Promise<InstalledShapeSummary[]>;

  /**
   * Apply an installed Shape: enable its extensions, resolve connections, stand
   * up schedules, offer its agents (never force one), and record it active. The
   * result's `applied.layout` carries the chrome the client restores without a
   * second fetch; `warnings[]` holds every per-piece degradation (spec §7).
   * Rejects only when the Shape is not installed (the one fatal case, 404).
   *
   * @param name - Installed Shape name. Will be URL-encoded.
   */
  applyShape(name: string): Promise<ApplyShapeResult>;

  /**
   * Fork an installed Shape into a new, independently-editable one stamped with
   * `lineage`. With `captureCurrent` on the *active* Shape, the new Shape also
   * records the arrangement in use: the enabled extensions the server reads for
   * itself, plus whatever chrome the caller reports in `liveLayout`. That
   * capture is a partial — every field the caller omits keeps the source Shape's
   * value, so a client never overwrites state it cannot observe.
   *
   * Rejects when the source Shape is not installed (404) or the target name is
   * invalid or taken (409); the thrown error carries the server's message.
   *
   * @param name - Installed source Shape name. Will be URL-encoded.
   * @param request - Fork options (`as`, `captureCurrent`, `liveLayout`).
   */
  forkShape(name: string, request?: ForkShapeRequest): Promise<ForkShapeResult>;

  // --- DorkOS account link (accounts-and-auth P2) ---

  /**
   * Begin device-linking this instance to a DorkOS account. Returns the codes to
   * display to the user; the outcome arrives by polling {@link getCloudLinkStatus}.
   * Rejects (HTTP 502) when the cloud is unreachable.
   */
  startCloudLink(): Promise<StartLinkResult>;
  /**
   * Read the live link-flow state machine. Polled after {@link startCloudLink}
   * while the flow transitions from `pending` to a terminal state.
   */
  getCloudLinkStatus(): Promise<CloudLinkStatus>;
  /** Unlink this instance from its DorkOS account (best-effort server-side revoke). */
  unlinkCloud(): Promise<{ ok: boolean }>;
  /** Read the settled linked/unlinked summary for the Settings panel's initial render. */
  getCloudStatus(): Promise<CloudLinkSummary>;

  // --- Feedback (user-volunteered; DOR-317, ADR 260713-143958 Phase 5) ---

  /**
   * Send a piece of feedback the user deliberately wrote and submitted — general
   * feedback, a bug report, or a feature idea. Unlike usage telemetry, this is a
   * message the person chose to send, so it bypasses the telemetry consent
   * channel and env kill switches entirely (see `@dorkos/shared/telemetry-events`
   * for the reasoning). It still rides the one owned ingest.
   *
   * `HttpTransport` POSTs `/feedback` (the server fills surface/version/id and
   * forwards to the ingest); `DirectTransport` forwards in-process. The result is
   * an honest `{ ok }` so the UI can toast truthfully — a network failure resolves
   * `{ ok: false }` rather than throwing, since best-effort delivery is not an
   * error the user must handle.
   *
   * @param submission - The user-typed `{ kind, message, contact?, route? }`.
   */
  sendFeedback(submission: FeedbackSubmission): Promise<{ ok: boolean }>;

  /**
   * List this install's own feedback submissions for the "Product
   * feedback" tracking view (feedback-pipeline Part 4, decision
   * 260803-205035) — kept newest first, scoped to this install's own
   * pseudonymous `instanceId` so no login is required.
   *
   * `HttpTransport` calls the local server's `GET /api/feedback/mine` proxy,
   * which forwards to the site (never a cross-origin request from the
   * client). `DirectTransport` (Obsidian) has no site-backed tracking store
   * to read — it resolves `[]`, matching the empty state the view already
   * has to handle.
   *
   * Unlike {@link sendFeedback}'s honest `{ ok }` posture, this **rejects**
   * on failure — it is a read the tracking view's own loading/error UI
   * handles directly, not a fire-and-forget send.
   */
  listMyFeedback(): Promise<FeedbackListItem[]>;

  // --- Connectors (connector-completion spec §Detailed Design 5) ---

  /**
   * Read every connector provider's setup state (configured, registered,
   * custody stance, disclosure copy, and the honest error text when a
   * configured provider refused to register). Reference-free by construction.
   */
  getConnectorProviders(): Promise<ConnectorProviderStatus[]>;

  /**
   * Store a provider's vendor key and reload the provider live — no restart.
   * The secret travels once, into the server's encrypted store; only the fresh
   * reference-free status comes back.
   *
   * @param provider - Provider type, e.g. `'composio' | 'nango'`.
   * @param secret - The vendor key to store. Never echoed by any response.
   */
  putConnectorCredential(provider: string, secret: string): Promise<ConnectorProviderStatus>;

  /**
   * Delete a provider's stored key and unregister it live. Idempotent — a
   * missing key still resolves with the (unconfigured) status.
   *
   * @param provider - Provider type, e.g. `'composio' | 'nango'`.
   */
  deleteConnectorCredential(provider: string): Promise<ConnectorProviderStatus>;

  /** List the connectable services aggregated across every registered provider. */
  getConnectorToolkits(): Promise<ConnectorToolkitsResponse>;

  /**
   * Ask how a service should be connected, best route first: a purpose-built
   * relay adapter outranks a gateway connector, which outranks a raw MCP
   * server. The service grid's Connect verb routes through this so the
   * provider choice stays invisible.
   *
   * @param service - Service slug, e.g. `'gmail' | 'slack'`.
   */
  getConnectorRecommendation(service: string): Promise<ConnectorRecommendationsResponse>;

  /**
   * Begin connecting a service account through one provider. The result
   * carries the auth URL, a pollable flow id, and the custody disclosure the
   * UI must render BEFORE the auth URL is opened.
   *
   * @param provider - Provider type the flow runs through (from the recommendation).
   * @param request - The toolkit to connect and an optional multi-account label.
   */
  startConnectorFlow(
    provider: string,
    request: { toolkit: string; label?: string }
  ): Promise<ConnectorConnectStartResponse>;

  /**
   * Poll a connect flow until it settles. A FLOW failure is typed on the
   * result (`status: 'failed'` with `error`); the request itself can still
   * reject — an unknown or already-released flow id answers 404 — and callers
   * treat that rejection as terminal too.
   *
   * @param flowId - The opaque flow id from {@link startConnectorFlow}.
   */
  pollConnectorFlow(flowId: string): Promise<ConnectorConnectPollResponse>;

  /**
   * List every connected account across providers, each row carrying its own
   * server-composed custody sentence.
   *
   * @param toolkit - Optional service slug to filter to.
   */
  getConnectorAccounts(toolkit?: string): Promise<ConnectorAccountsResponse>;

  /**
   * Disconnect (revoke) one connected account. Idempotent — an unknown or
   * already-removed id resolves without error.
   *
   * @param accountId - The opaque account id to disconnect.
   */
  disconnectConnectorAccount(accountId: string): Promise<void>;

  /**
   * Read a session's connector surface: the accounts attached to it, each with
   * its exposure state, plus per-account null-branch warnings ("expired —
   * reconnect" style) for accounts that could not be exposed.
   *
   * @param sessionId - The session to report on.
   */
  getSessionConnectors(sessionId: string): Promise<SessionConnectorStatus>;

  /**
   * Attach a connected account to a session — the consent point. The result
   * re-shows the custody disclosure and surfaces the null-branch warning when
   * the account attached but is not exposable right now. Rejects (404) for an
   * unknown account id.
   *
   * @param sessionId - The session the account is being attached to.
   * @param accountId - The opaque account id to attach.
   */
  attachSessionConnector(
    sessionId: string,
    accountId: string
  ): Promise<SessionConnectorAttachResult>;

  /**
   * Detach an account from a session. Idempotent — detaching an unattached
   * account is a no-op.
   *
   * @param sessionId - The session to detach from.
   * @param accountId - The opaque account id to detach.
   */
  detachSessionConnector(sessionId: string, accountId: string): Promise<void>;

  // --- Agent-level connector attachment (connection-scoping spec §Part 1) ---

  /**
   * List the accounts an agent has standingly attached. Every session that
   * agent starts inherits these unless the session overrides the account.
   *
   * @param agentId - The agent whose standing attachments to read.
   */
  getAgentConnectors(agentId: string): Promise<AgentConnectorAttachment[]>;

  /**
   * Attach an account to an agent for good — the standing consent point. The
   * result re-shows the custody disclosure, exactly as the session-level
   * attach does. Rejects for an unknown agent (400) or account (404).
   *
   * @param agentId - The agent gaining the standing attachment.
   * @param accountId - The opaque account id to attach.
   */
  attachAgentConnector(agentId: string, accountId: string): Promise<AgentConnectorAttachResult>;

  /**
   * Remove an agent's standing attachment. Idempotent. Sessions that already
   * resolved the account keep it until they restart.
   *
   * @param agentId - The agent losing the standing attachment.
   * @param accountId - The opaque account id to detach.
   */
  detachAgentConnector(agentId: string, accountId: string): Promise<void>;

  // --- The claim feed (connection-scoping spec §Part 3) ---

  /**
   * List chats an adapter heard from that no binding routes. Metadata only —
   * who wrote and when, never what they wrote.
   *
   * @param status - Which slice to read; defaults to `pending` server-side.
   */
  listUnclaimedChats(status?: UnclaimedChatStatus): Promise<UnclaimedChat[]>;

  /**
   * Point an unclaimed chat at an agent, creating the binding that routes it.
   * Goes through the same uniqueness check as any other binding create, so a
   * chat another binding took in the meantime rejects with `CHAT_ALREADY_BOUND`.
   *
   * `input.bridge: true` is the claim card's primary action, "Answer in a
   * channel": claim, binding, and bridge happen in one call. The claim always
   * succeeds when this resolves — a bridge step that could not complete comes
   * back as `bridgeError` on the response rather than as a rejection, so the
   * chat is never left unclaimed over a bridge failure.
   *
   * @param id - The unclaimed-chat row id.
   * @param input - The agent to answer, plus optional binding settings.
   */
  claimUnclaimedChat(
    id: string,
    input: ClaimUnclaimedChatRequest
  ): Promise<ClaimUnclaimedChatResponse>;

  /**
   * Mute an unclaimed chat: it stops surfacing, but its traffic is still
   * counted. Idempotent.
   *
   * @param id - The unclaimed-chat row id.
   */
  ignoreUnclaimedChat(id: string): Promise<void>;

  /**
   * Block an unclaimed chat: nothing further from it is recorded at all.
   * Idempotent.
   *
   * @param id - The unclaimed-chat row id.
   */
  blockUnclaimedChat(id: string): Promise<void>;

  /**
   * Leave an unclaimed chat's platform group — the group-add claim flow's
   * "Leave" action (DOR-883). A real removal, through the adapter's own
   * platform call: after this resolves the bot is no longer in the chat, and
   * no room or binding was ever created for it. Rejects (never silently
   * no-ops) when the underlying adapter cannot leave a chat, so the card
   * stays visible rather than disappearing over a leave that did not happen.
   *
   * @param id - The unclaimed-chat row id.
   */
  leaveUnclaimedChat(id: string): Promise<void>;
}
