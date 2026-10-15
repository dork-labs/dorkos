import type {
  AgentRuntimeLike,
  TraceStoreLike,
  TasksStoreLike,
  RefusedAskReporter,
} from '@dorkos/relay';
import type { RelayCoreLike } from '../binding-router.js';
import type { UnclaimedChatStore } from '../unclaimed-chat-store.js';
import type { BindingSubsystemDeps } from '../binding-subsystem.js';
import type { CredentialProvider, CredentialStore } from '../../core/credential-provider.js';

/** Minimal MeshCore interface needed by AdapterManager for CWD resolution. */
export interface AdapterMeshCoreLike {
  getProjectPath(agentId: string): string | undefined;
}

/** Interface for recording adapter lifecycle events. */
export interface AdapterEventRecorder {
  insertAdapterEvent(adapterId: string, eventType: string, message: string): void;
}

/** Deletes the delivery history a removed chat connection left behind (DOR-2604). */
export interface ConnectionTraceEraser {
  /**
   * Delete up to `limit` of the delivery records and lifecycle events that
   * name the connection.
   *
   * @param adapterId - The removed connection's id.
   * @param limit - The most records to delete in this call.
   * @returns How many records were deleted; fewer than `limit` means none are left.
   */
  deleteConnectionTraces(adapterId: string, limit: number): number;
}

/** Options for {@link AdapterManager.removeAdapter}. */
export interface RemoveAdapterOptions {
  /**
   * Also delete the connection's delivery records, chat names and events
   * (DOR-2604), and every chat it recorded for the claim feed, blocked and
   * ignored ones included (DOR-2608). Only a person removing the connection
   * passes this: a package update or an install rollback removes an entry it
   * may put straight back, and must never erase a history nobody asked to
   * lose. Defaults to `false`.
   */
  forgetHistory?: boolean;
}

/** Minimal ActivityService interface for fire-and-forget event emission. */
export interface ActivityEmitter {
  emit(event: {
    actorType: 'user' | 'agent' | 'system' | 'tasks';
    actorLabel: string;
    category: 'relay';
    eventType: string;
    resourceType?: string | null;
    resourceId?: string | null;
    resourceLabel?: string | null;
    summary: string;
    linkPath?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<void>;
}

/** Dependencies for constructing runtime adapters. */
export interface AdapterManagerDeps {
  /**
   * Map from runtime type (e.g., `'claude-code'`, `'test-mode'`) to a runtime
   * instance satisfying the minimal `AgentRuntimeLike` contract.
   *
   * Passed straight through to the built-in adapter, which picks one PER
   * MESSAGE from what the message names and refuses a runtime it does not hold
   * rather than falling back to another (DOR-1614). Pass every runtime this
   * server registered.
   *
   * For backward compatibility, callers may pass a single `agentManager`
   * instead — {@link normalizeAgentRuntimes} turns it into a single-entry map
   * keyed by that runtime's own `type`.
   */
  agentRuntimes?: Map<string, AgentRuntimeLike>;
  /**
   * @deprecated Provide `agentRuntimes` (a map) instead. When supplied, this
   * single runtime is registered under its own `type` (falling back to
   * `'claude-code'` for doubles that declare none) so existing callers
   * continue to work while they migrate.
   */
  agentManager?: AgentRuntimeLike;
  traceStore: TraceStoreLike;
  taskStore?: TasksStoreLike;
  /**
   * Where a relay-dispatched scheduled run reports a tool it was refused
   * because nobody was there to approve it, so the activity feed says so on
   * this path too (DOR-1580). Built by the composition root, which is where the
   * full `TaskStore` and the activity feed both are — this manager holds only
   * the narrow `updateRun` seam.
   */
  onRefusedAsk?: RefusedAskReporter;
  /** Optional RelayCore for binding subsystem initialization */
  relayCore?: RelayCoreLike;
  /** Optional MeshCore for enriching AdapterContext with agent CWD resolution */
  meshCore?: AdapterMeshCoreLike;
  /** Optional recorder for adapter lifecycle events */
  eventRecorder?: AdapterEventRecorder;
  /**
   * Deletes a removed connection's delivery records, chat names and lifecycle
   * events. Optional so a manager built without a trace store still removes
   * connections; there is then nothing to delete.
   */
  traceEraser?: ConnectionTraceEraser;
  /** Optional activity service for feed instrumentation */
  activityService?: ActivityEmitter;
  /**
   * Encrypted store that backs `file:` credential references for adapter
   * secrets (DOR-280). Defaults to the process-wide {@link credentialStore}
   * singleton; injectable for tests.
   */
  credentialStore?: CredentialStore;
  /**
   * Read port that resolves a credential reference to its secret at adapter
   * construction (DOR-280). Defaults to the process-wide
   * {@link credentialProvider} singleton; injectable for tests.
   */
  credentialProvider?: CredentialProvider;
  /**
   * The durable claim feed for unbound inbound chats (connection-scoping
   * spec `specs/connection-scoping/` §Part 3). Optional so callers that don't
   * exercise the unbound-inbound path (most tests) can omit it.
   */
  unclaimedChats?: UnclaimedChatStore;
  /**
   * The rooms service, its bridge store, and the operator-author resolver —
   * threaded straight to {@link BindingSubsystem} for the inbound chat bridge
   * (chats-as-channels §5). Optional so a manager built without a rooms
   * subsystem still runs; a bridged binding then simply cannot be routed.
   */
  roomService?: BindingSubsystemDeps['roomService'];
  /** The bridge identity store the rooms service writes through (chats-as-channels §3.1). */
  roomBridges?: BindingSubsystemDeps['roomBridges'];
  /** The per-runtime transcript probe for session adoption at bridge time (§7.3). */
  transcriptProbe?: BindingSubsystemDeps['transcriptProbe'];
  /** The install owner's author id, read per call (chats-as-channels §3.5, §10.9). */
  operatorAuthorId?: BindingSubsystemDeps['operatorAuthorId'];
  /** The real operator-name prefix for a bridged group post, read per call (§6.7, DOR-899). */
  operatorDisplayName?: BindingSubsystemDeps['operatorDisplayName'];
  /** The room store, for outbound delivery's entry reads (chats-as-channels §6). */
  roomStore?: BindingSubsystemDeps['roomStore'];
  /** The author registry, for the delivering-author check and name prefix (§6.6, §6.7). */
  roomAuthors?: BindingSubsystemDeps['roomAuthors'];
  /** Which room a session answers for, for the bridged Ask card (`ask-entitlement` §5.2). */
  roomSessionBindings?: BindingSubsystemDeps['roomSessionBindings'];
  /** A room's membership rows, for that card's audience check (`ask-entitlement` §5.1). */
  roomMembers?: BindingSubsystemDeps['roomMembers'];
  /** Build a chat's outbound subject from its bridge row (§6.4). */
  resolveBridgeSubject?: BindingSubsystemDeps['resolveBridgeSubject'];
  /** Register the outbound bridge's inline-delivery hook on the room service (§6.1). */
  registerEntryCommitListener?: BindingSubsystemDeps['registerEntryCommitListener'];
  /** Emit an ephemeral relay signal, for the bridge's presence forwarder (§6.8). */
  relaySignal?: BindingSubsystemDeps['relaySignal'];
  /** Register the bridge's presence forwarder on the room service (§6.8). */
  registerSignalListener?: BindingSubsystemDeps['registerSignalListener'];
}
