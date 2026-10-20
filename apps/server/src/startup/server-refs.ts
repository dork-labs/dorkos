/**
 * The server's live references: every service, timer and stop function
 * `start()` fills in and `shutdownServices()` in `index.ts` tears down,
 * plus the few late-bound values more than one startup step reads. They were
 * module-scope `let`s in `index.ts`; they live on one object so the startup
 * steps in `startup/steps/` can set them at the same moment the inline code did.
 *
 * @module startup/server-refs
 */
import type { ClaudeCodeRuntime } from '../services/runtimes/claude-code/claude-code-runtime.js';
import type { DoeRuntime } from '../services/runtimes/doe/index.js';
import type { CreditsRelay } from '../services/core/cloud/credits-relay.js';
import type { AccountUsageStore } from '../services/core/usage/account-usage-store.js';
import type { AgentRuntimeLike, RelayCore, AdapterRegistry } from '@dorkos/relay';
import type { TaskSchedulerService } from '../services/tasks/task-scheduler-service.js';
import type { ConfirmationProvider } from '../services/marketplace-mcp/confirmation-provider.js';
import type { MarketplaceInstaller } from '../services/marketplace/installer/marketplace-installer.js';
import type { AdapterManager } from '../services/relay/adapter-manager.js';
import type { TraceStore } from '../services/relay/trace-store.js';
import type { MeshCore } from '@dorkos/mesh';
import type { AgentMcpServerService } from '../services/mesh/agent-mcp-server-service.js';
import type { AgentMcpOAuthService } from '../services/mesh/agent-mcp-oauth-service.js';
import type { CommunityOutboxRuntime } from '../services/communities/remote/community-outbox-runtime.js';
import type { RemoteRoomSubscriptionRuntime } from '../services/communities/remote/remote-room-subscription-runtime.js';
import type { AgentAvailabilityRuntime } from '../services/communities/remote/availability/agent-availability-runtime.js';
import type { RemoteRedactionSync } from '../services/communities/remote/remote-redaction-sync.js';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import type { RoomSessionPlacePort } from '../services/workspace/room-session-place.js';
import type { ConnectorRuntimeMcpListener } from '../services/runtimes/connector-mcp/index.js';
import type { TaskFileWatcher } from '../services/tasks/task-file-watcher.js';
import type { TaskReconciler } from '../services/tasks/task-reconciler.js';
import type { TaskRegistrar } from '../services/tasks/task-registrar.js';
import type {
  SkillsWatcherHandle,
  TurnEndReprojection,
} from '../services/harness/skills-watcher.js';
import type { DevLinkWatcher } from '../services/marketplace/dev-links/index.js';
import type { SearchIndexer } from '../services/search/index.js';
import type { CommitmentWiring } from '../services/commitments/commitment-wiring.js';
import type { JitteredSchedule } from '../lib/jittered-schedule.js';
import type { TerminalManager } from '../services/terminal/index.js';
import type { CapabilityRegistry } from '../services/core/capabilities/index.js';
import type { RelayChannelDeps } from '../services/notifications/channels/relay.js';
import type { WorkspaceStore } from '../services/workspace/index.js';
import type { RoomBindingTranscriptDeps } from '../services/rooms/session-bindings/room-binding-transcripts.js';
import type { TaskStore } from '../services/tasks/task-store.js';
import type { ConnectorEventDeliveryService } from '../services/connectors/events/delivery-service.js';
import type { createExternalMcpServer } from '../services/core/mcp-server.js';
import type { MarketplaceMcpDeps } from '../services/marketplace-mcp/marketplace-mcp-tools.js';
import type { ConnectorAgentRequestService } from '../services/connectors/agent-request-service.js';

/** The references `start()` fills in and `shutdownServices()` tears down. */
export interface ServerRefs {
  // Global references for graceful shutdown
  claudeRuntime: ClaudeCodeRuntime | null;
  doeRuntime: DoeRuntime | null;
  /** The loopback credits relay, while OpenCode is enabled. */
  creditsRelay: CreditsRelay | null;
  accountUsageStore: AccountUsageStore | undefined;
  /** Stops the out-of-usage planner and the continue service (spec claude-account-fleet D9). */
  stopSessionContinuation: (() => void) | undefined;
  /** Forwards to the `stopDocDelivery` variable in `index.ts`. */
  stopDocDelivery: (() => Promise<void>) | undefined;
  // The relay's DEFAULT runtime — what answers a relay message that names no
  // runtime at all (a legacy `relay.agent.<sessionId>` subject, a direct
  // agent-to-agent send to a mesh agent). The relay carries every registered
  // runtime as of DOR-1614 and picks per message; this is the one it falls back
  // to, and it is bound to the concrete runtime constructed here rather than read
  // off `runtimeRegistry.getDefault()`, so `runtimes.default` can point at codex
  // or opencode without moving what answers an unaddressed message. Test mode
  // substitutes TestModeRuntime, which implements the same narrow surface with no
  // real agent binary.
  //
  // It carries its own `type` rather than being paired with a separate type
  // variable, because the two are the same fact and two variables holding one
  // fact drift. AdapterManager keys its runtime map by that type, so the key is
  // always the runtime's actual identity — `test-mode` in test mode, not a
  // hardcoded `claude-code` that no lookup would ever match.
  relayAgentRuntime: (AgentRuntimeLike & { readonly type: string }) | null;
  schedulerService: TaskSchedulerService | null;
  relayCore: RelayCore | undefined;
  /**
   * The marketplace's confirmation provider, once composed: the agents router
   * reads it for an agent's template creation card (DOR-2325), and the workspace
   * service for a new workspace's card (DOR-2335).
   */
  templateConfirmationProvider: ConfirmationProvider | undefined;
  /**
   * The marketplace installer and data directory, once composed: the agents
   * router creates an agent from a marketplace package through it (DOR-2325).
   */
  agentPackageInstaller: { installer: MarketplaceInstaller; dorkHome: string } | undefined;
  adapterRegistry: AdapterRegistry | undefined;
  adapterManager: AdapterManager | undefined;
  traceStore: TraceStore | undefined;
  meshCore: MeshCore | undefined;
  agentMcpServerService: AgentMcpServerService | undefined;
  agentMcpOAuthService: AgentMcpOAuthService | undefined;
  remoteCommunityRuntime: CommunityOutboxRuntime | undefined;
  remoteCommunitySubscriptions: RemoteRoomSubscriptionRuntime | undefined;
  /** Reports enrolled agents as there to each space they belong to (DOR-2878). */
  remoteAgentAvailability: AgentAvailabilityRuntime | undefined;
  remoteRedactionSync: RemoteRedactionSync | undefined;
  extensionManager: ExtensionManager | undefined;
  /** Where room conversations run (DOR-1624); set once rooms are wired. */
  roomSessionPlacePort: RoomSessionPlacePort | undefined;
  connectorRuntimeMcpListener: ConnectorRuntimeMcpListener | undefined;
  /** Forwards to the `testComposioFixture` variable in `index.ts`. */
  testComposioFixture:
    | Awaited<
        ReturnType<
          typeof import('../services/connectors/providers/test-composio/fixture.js').startTestComposioFixture
        >
      >
    | undefined;
  /**
   * The project install-recovery sweep, and the projects it read. The legacy
   * record sweep (DOR-2197) waits for it, so a root is settled before its record
   * is rebuilt, and reads the same projects.
   */
  projectInstallRecovery: Promise<unknown>;
  sweptProjects: string[];
  taskFileWatcher: TaskFileWatcher | undefined;
  taskReconciler: TaskReconciler | undefined;
  taskRegistrar: TaskRegistrar | undefined;
  /** The `.agents/skills` projection watcher; absent when `harness.autoSync` is off. */
  skillsWatcher: SkillsWatcherHandle | undefined;
  /** Hot reload for dev links (DOR-2696); absent when the marketplace did not start. */
  devLinkWatcher: DevLinkWatcher | undefined;
  /** The turn-end half of the same trigger; absent whenever {@link skillsWatcher} is. */
  turnEndReprojection: TurnEndReprojection | undefined;
  /**
   * Start watching a newly registered agent's schedule roots.
   *
   * Set by the tasks bootstrap block and called by the agent-created listener,
   * which is registered later in this file — so the two cannot simply be one
   * function. `undefined` when the tasks subsystem is switched off, which is why
   * the caller uses `?.`.
   */
  attachAgentTaskRoots: ((projectPath: string, agentId: string) => Promise<void>) | undefined;
  searchIndexer: SearchIndexer | undefined;
  commitmentWiring: CommitmentWiring | undefined;
  healthCheckInterval: ReturnType<typeof setInterval> | undefined;
  dailySnapshotInterval: ReturnType<typeof setInterval> | undefined;
  sessionAttachmentSweepInterval: ReturnType<typeof setInterval> | undefined;
  // Jittered beats (`lib/jittered-schedule.ts`), so linked computers do not call Cloud in step.
  managedAuthorityRecoveryInterval: JitteredSchedule | undefined;
  managedUsageMirrorRecoveryInterval: JitteredSchedule | undefined;
  // Stops the approval expiry sweep (DOR-1932). A function rather than a timer
  // handle because the sweep owns its own interval and hands back a closer.
  stopApprovalExpirySweep: (() => void) | undefined;
  // Stops the periodic connector sign-in refresh and every waiting automatic
  // check of a way that stopped answering (DOR-2501).
  stopConnectorFreshness: (() => void) | undefined;
  // Embedded-terminal PTY manager (ADR 260708-185521). Always-on, boundary-confined;
  // the WebSocket byte channel is attached to the HTTP server after listen().
  terminalManager: TerminalManager | undefined;
  // Drops this process's claim on the data directory. Called from
  // shutdownServices() rather than shutdown(), because the admin restart path runs
  // the former and then spawns a successor that must find the directory free.
  releaseInstanceLock: (() => void) | undefined;
  /** Forwards to the `docNotificationCleanup` variable in `index.ts`. */
  docNotificationCleanup: (() => void) | undefined;
  // The single boot-composed Capability Registry — operator + marketplace +
  // self-description folded into one immutable registry (spec
  // `capability-registry`). Composed once below, after the dependency bags above
  // are settled, then shared by both MCP servers and the `/api/capabilities/catalog`
  // route. The factory/router closures below capture this `let` and read it lazily
  // (they run per request, after boot has assigned it) — assigned once, but after
  // those closures are defined, so it cannot be a `const` initialized in place.
  capabilityRegistry: CapabilityRegistry | undefined;
  /** Set during `start()` and read by more than one startup step. */
  relayChannelDeps: RelayChannelDeps | undefined;
  // The managed checkouts' owners, read by the home resolver (§3.1 source 3).
  // Unset while the managed layer is off, where no checkout has an owner.
  managedWorkspaces: WorkspaceStore | undefined;
  /** Set during `start()` and read by more than one startup step. */
  meshStartupReconciled: boolean;
  /** Set during `start()` and read by more than one startup step. */
  frozenWorktrees: readonly string[];
  /** Set during `start()` and read by more than one startup step. */
  roomBindingTranscripts: RoomBindingTranscriptDeps | undefined;
  /** Set during `start()` and read by more than one startup step. */
  taskStore: TaskStore | undefined;
  /** Set during `start()` and read by more than one startup step. */
  connectorEventDelivery: ConnectorEventDeliveryService | undefined;
  // Build mcpToolDeps and register factory only when ClaudeCodeRuntime is available.
  mcpToolDeps: Parameters<typeof createExternalMcpServer>[0] | undefined;
  // Marketplace MCP deps are populated later in the marketplace wiring block
  // (only when extensionManager + adapterManager are available). The factory
  // closure below reads the captured `let` binding lazily on each request, so
  // by the time the first MCP request arrives this is either populated or
  // intentionally undefined (relay disabled).
  marketplaceMcpDeps: MarketplaceMcpDeps | undefined;
  /** Set during `start()` and read by more than one startup step. */
  connectorAgentRequests: ConnectorAgentRequestService | undefined;
  /** Set during `start()` and read by more than one startup step. */
  acceptedPrivateSessionCursor: string | undefined;
}

/** The fields {@link createServerRefs} leaves to `index.ts`, which keeps them as plain variables. */
export type BareServerRefs = 'stopDocDelivery' | 'testComposioFixture' | 'docNotificationCleanup';

/**
 * The starting value of every reference, before `start()` runs.
 *
 * @returns Every field of {@link ServerRefs} except the ones `index.ts` keeps itself.
 */
export function createServerRefs(): Omit<ServerRefs, BareServerRefs> {
  return {
    claudeRuntime: null,
    doeRuntime: null,
    creditsRelay: null,
    accountUsageStore: undefined,
    stopSessionContinuation: undefined,
    relayAgentRuntime: null,
    schedulerService: null,
    relayCore: undefined,
    templateConfirmationProvider: undefined,
    agentPackageInstaller: undefined,
    adapterRegistry: undefined,
    adapterManager: undefined,
    traceStore: undefined,
    meshCore: undefined,
    agentMcpServerService: undefined,
    agentMcpOAuthService: undefined,
    remoteCommunityRuntime: undefined,
    remoteCommunitySubscriptions: undefined,
    remoteAgentAvailability: undefined,
    remoteRedactionSync: undefined,
    extensionManager: undefined,
    roomSessionPlacePort: undefined,
    connectorRuntimeMcpListener: undefined,
    projectInstallRecovery: Promise.resolve(),
    sweptProjects: [],
    taskFileWatcher: undefined,
    taskReconciler: undefined,
    taskRegistrar: undefined,
    skillsWatcher: undefined,
    devLinkWatcher: undefined,
    turnEndReprojection: undefined,
    attachAgentTaskRoots: undefined,
    searchIndexer: undefined,
    commitmentWiring: undefined,
    healthCheckInterval: undefined,
    dailySnapshotInterval: undefined,
    sessionAttachmentSweepInterval: undefined,
    managedAuthorityRecoveryInterval: undefined,
    managedUsageMirrorRecoveryInterval: undefined,
    stopApprovalExpirySweep: undefined,
    stopConnectorFreshness: undefined,
    terminalManager: undefined,
    releaseInstanceLock: undefined,
    capabilityRegistry: undefined,
    relayChannelDeps: undefined,
    managedWorkspaces: undefined,
    meshStartupReconciled: false,
    frozenWorktrees: [],
    roomBindingTranscripts: undefined,
    taskStore: undefined,
    connectorEventDelivery: undefined,
    mcpToolDeps: undefined,
    marketplaceMcpDeps: undefined,
    connectorAgentRequests: undefined,
    acceptedPrivateSessionCursor: undefined,
  };
}
