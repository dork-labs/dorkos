import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentRegistryPort,
  MessageOpts,
  SseResponse,
  InterruptReceipt,
} from '@dorkos/shared/agent-runtime';
import type { StreamEvent as OriginalStreamEvent } from '@dorkos/shared/types';
import type { AgentSession } from '../agent-types.js';
import type { ClaudeCodeRuntime } from '../claude-code-runtime.js';
import type { ClaudeConnectorTurnContext } from '../connector-turn-context.js';
import type {
  ClaudeNativeEntry,
  ClaudePreparedRoomContinuation,
  createIsolatedClaudeNativeCustody,
} from './claude-native-custody.js';
import type { createIsolatedClaudeRelayCustody } from './claude-relay-custody.js';
import type { NativeSessionAcquisition } from '../../../session/session-lock.js';
import type { OriginalRoomDispatchCustody } from '../../../rooms/service/room-core.js';
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import type { PersistentDispatch } from '../sessions/persistent-dispatch.js';
import type { SessionStore } from '../sessions/session-store.js';
import type { AccountsAccessContext } from '../../shared/accounts-access-context.js';
import type { TranscriptReader } from '../sessions/transcript-reader.js';
import type { RuntimeCache } from '../messaging/runtime-cache.js';
import type { SessionLockManager } from '../../../session/session-lock.js';
import type { PluginReloadScheduler, PaidPluginReload } from '../messaging/plugin-reload-policy.js';
import type { SessionPumpRegistry } from '../sessions/session-pump-registry.js';
import type { SessionAttachmentStore } from '../../../session/attachments/index.js';
import type { McpAuthEvidencePort } from '../../../mesh/mcp-revocation.js';
import type { PluginReloadActivityPort } from './claude-native-custody.js';
import type { CommandRegistryService } from '../tooling/command-registry.js';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type { McpServerFactory, MessageSenderOpts } from '../messaging/message-sender-shared.js';

/** Exact original native turn installation result retained by the private runtime. */
export interface OriginalClaudeNativeInstallation {
  nativeOperation: object;
  nativeEntry: ClaudeNativeEntry;
  runtimeEntries: Map<string, ClaudeNativeEntry>;
  connectorTurn: ClaudeConnectorTurnContext | undefined;
}

/** Constructor-private original runtime preparation view; never supplied by a public caller. */
export interface OriginalClaudeNativePreparationView {
  readonly runtime: ClaudeCodeRuntime;
  readonly attachments: SessionAttachmentStore | null;
  readonly adapterManager: import('../../../relay/adapter-manager.js').AdapterManager | undefined;
  readonly bindingRouter: import('../../../relay/binding-router.js').BindingRouter | undefined;
  readonly bindingStore: import('../../../relay/binding-store.js').BindingStore | undefined;
  readonly mcpServerFactory: McpServerFactory | null;
  readonly spawnBinaryPath: string | undefined;
  readonly mcpAuthEvidence: McpAuthEvidencePort | undefined;
  readonly pluginReloadActivity: PluginReloadActivityPort | undefined;
  readonly warmFailedAt: Map<string, number>;
  connectorAgentFor(
    cwdKey: string,
    turnAgent?: string
  ):
    | { agentPath: string; meshAgent: NonNullable<ReturnType<AgentRegistryPort['getByPath']>> }
    | undefined;
  reportMcpAuthFailures(sessionId: string, cwd: string, servers: McpServerEntry[]): void;
  getOrCreateRegistry(root: string): CommandRegistryService;
  notifyInteractionResolved(
    sessionId: string,
    interactionId: string,
    resolution: 'approved' | 'denied' | 'answered',
    opts?: { reasonGiven?: boolean; answeredBy?: string }
  ): void;
  interruptQuery(sessionId: string): Promise<InterruptReceipt>;
  readonly cache: RuntimeCache;
  readonly lockManager: SessionLockManager;
  readonly pluginReloads: PluginReloadScheduler;
  readonly pumps: SessionPumpRegistry;
  activatedPlugins: Array<{ type: 'local'; path: string }>;
  broadcastCommandsChanged(): void;
  forgetProjectCommands(projectPath: string): void;
  reloadCommandsForLiveSessions(options: { mayHold: boolean }): Promise<void>;
  recordPaidPluginReload(entry: PaidPluginReload): void;
  readonly sessionStore: SessionStore;
  readonly reloadableSession: (sessionId: string) => { session: AgentSession; queryObj: Query };
  readonly accountsAccess: AccountsAccessContext;
  readonly originalClaudeLockedStreams: ReturnType<
    typeof createIsolatedClaudeNativeCustody
  >['originalClaudeLockedStreams'];
  readonly originalClaudeRoomStreams: ReturnType<
    typeof createIsolatedClaudeNativeCustody
  >['originalClaudeRoomStreams'];
  readonly originalClaudePersistentRequests: ReturnType<
    typeof createIsolatedClaudeNativeCustody
  >['originalClaudePersistentRequests'];

  readonly connectorRuntimeTools: ConnectorRuntimeTools | undefined;
  readonly meshCore: AgentRegistryPort | null;
  readonly transcriptReader: TranscriptReader;
  readonly cwd: string;
  readonly persistent: PersistentDispatch;
  readonly relayPreparing: Map<
    string,
    { retired: boolean; cleanupFailed?: boolean; cleanupCause?: unknown }
  >;
  readonly roomPreparing: Map<string, { retired: boolean }>;
  readonly claudeRuntimeEntries: ReturnType<
    typeof createIsolatedClaudeNativeCustody
  >['claudeRuntimeEntries'];
  readonly claudeOriginalStores: ReturnType<
    typeof createIsolatedClaudeNativeCustody
  >['claudeOriginalStores'];
  readonly claudeRoomQuerySessions: ReturnType<
    typeof createIsolatedClaudeNativeCustody
  >['claudeRoomQuerySessions'];
  readonly claudeNativeConstructors: ReturnType<
    typeof createIsolatedClaudeNativeCustody
  >['claudeNativeConstructors'];
  readonly claudeNativeOperations: ReturnType<
    typeof createIsolatedClaudeNativeCustody
  >['claudeNativeOperations'];
  readonly claudeOriginalSessionOperations: ReturnType<
    typeof createIsolatedClaudeNativeCustody
  >['claudeOriginalSessionOperations'];
  readonly claudeRoomPrepared: ReturnType<
    typeof createIsolatedClaudeNativeCustody
  >['claudeRoomPrepared'];
  readonly claudeRelayPrepared: ReturnType<
    typeof createIsolatedClaudeRelayCustody
  >['claudeRelayPrepared'];
  readonly originalRelayLaunchPreparations: ReturnType<
    typeof createIsolatedClaudeRelayCustody
  >['originalRelayLaunchPreparations'];
  sendOwnedMessage(
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    lifetime: {
      closed: boolean;
      entered: boolean;
      retire?: () => void;
      acquisition?: NativeSessionAcquisition;
      roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
      roomPrepared?: ClaudePreparedRoomContinuation;
    }
  ): AsyncGenerator<OriginalStreamEvent>;
  installNativeTurn(
    sessionId: string,
    session: AgentSession,
    cwdKey: string,
    agentPath: string | undefined,
    meshAgent: { id: string } | undefined,
    acquisition?: NativeSessionAcquisition,
    refuseExisting?: boolean,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>,
    relayOwner?: { retired: boolean; cleanupFailed?: boolean; cleanupCause?: unknown }
  ): OriginalClaudeNativeInstallation;
  buildSenderOpts(
    sessionId: string,
    session: AgentSession,
    cwdKey: string,
    turnAgent?: string
  ): MessageSenderOpts;
  createMessage(
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    acquisition?: NativeSessionAcquisition,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>,
    roomPrepared?: ClaudePreparedRoomContinuation
  ): AsyncGenerator<OriginalStreamEvent>;
}
