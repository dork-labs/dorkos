import type { ConnectorRuntime } from '../../connectors/runtime-principal-port.js';
import type { OriginalRoomDispatchCustody } from '../../rooms/service/room-core.js';
import type { AccountsAccessContext } from '../shared/accounts-access-context.js';
import type { OpencodeClient, ProviderListResponse } from '@opencode-ai/sdk';
import type { StreamEvent, Session, HistoryMessage, SessionSettings } from '@dorkos/shared/types';
import type {
  DirectoryGrant,
  RuntimeCapabilities,
  MessageOpts,
  SseResponse,
  SessionSettingsPort,
  AgentRegistryPort,
  SessionUpdateResult,
  TurnPermissionCeiling,
} from '@dorkos/shared/agent-runtime';
import type { NativeSessionAcquisition } from '../../session/session-lock.js';
import type { OpenRouterCatalog } from './providers/openrouter.js';
import type { OpenCodeSessionMapper, OpenCodeClientProvider } from './sessions/session-mapper.js';
import type { OpenCodeGlobalEventHub } from './events/global-event-hub.js';
import type { OpenCodeSessionRegistry, OpenCodeSessionPatch } from './sessions/session-registry.js';
import type { PendingApprovalStore, ApprovalGateDeps } from './messaging/approvals.js';
import type { OpenCodeContextWindows } from './providers/context-windows.js';
import type { OpenCodeMcpManager } from './mcp/mcp-manager.js';
import type { SessionAttachmentStore } from '../../session/attachments/index.js';
import type { ConnectorRuntimeTools } from '../connector-tools.js';
import type { RevokeConnectorTurnReason } from '../../connectors/runtime-principal-port.js';
import type { ConnectorTurnLeaseManager } from './mcp/connector-turn-lease.js';
import type { OpenCodeSidecarPlan } from './credits-sidecar.js';
import type {
  OpenCodeRuntime,
  OriginalOpenCodeModuleCustody,
  ActiveTurn,
  SettingUpTurn,
  OpenCodeNativeEntry,
  OpenCodePreparedRoomContinuation,
} from './opencode-runtime.js';

/** Constructor-selected original collaborators; no caller can register a view. */
export interface OriginalOpenCodeRuntimeView {
  readonly runtime: OpenCodeRuntime;
  readonly custody: OriginalOpenCodeModuleCustody;
  readonly roomPreparing: Map<string, { retired: boolean }>;
  readonly accountsAccess: AccountsAccessContext;
  readonly activeTurns: Map<string, ActiveTurn>;
  readonly approvalGate: ApprovalGateDeps;
  readonly approvals: PendingApprovalStore;
  readonly attachments: SessionAttachmentStore | null;
  readonly binding: Map<string, Promise<string>>;
  readonly connectorLeases: ConnectorTurnLeaseManager;
  readonly connectorRuntimeTools: ConnectorRuntimeTools | undefined;
  readonly contextWindows: OpenCodeContextWindows;
  readonly directoryByOcId: Map<string, string>;
  readonly hub: OpenCodeGlobalEventHub;
  readonly mapper: OpenCodeSessionMapper;
  readonly mcp: OpenCodeMcpManager;
  readonly meshCore: AgentRegistryPort | undefined;
  readonly provider: OpenCodeClientProvider;
  readonly registry: OpenCodeSessionRegistry;
  readonly settingUp: Set<SettingUpTurn>;
  readonly settingsPort: SessionSettingsPort | undefined;
  readonly type: ConnectorRuntime;
  readonly runsOnCredits: () => boolean;
  readonly modelDirectory: string;
  createMessage(
    sessionId: string,
    content: string,
    opts: MessageOpts | undefined,
    acquisition?: NativeSessionAcquisition,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>,
    roomPrepared?: OpenCodePreparedRoomContinuation
  ): AsyncGenerator<StreamEvent>;
  installNativeTurn(
    sessionId: string,
    directory: string,
    client: OpencodeClient,
    turn: ActiveTurn,
    acquisition?: NativeSessionAcquisition,
    refuseExisting?: boolean,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>
  ): { nativeOperation: object; nativeEntry: OpenCodeNativeEntry };
  resolveNativeClient(
    sessionId: string,
    cwd: string,
    title?: string,
    pending?: { retired: boolean }
  ): Promise<{ ocSessionId: string; client: OpencodeClient; directory: string }>;
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
      roomPrepared?: OpenCodePreparedRoomContinuation;
    }
  ): AsyncGenerator<StreamEvent>;
  getCapabilities(): RuntimeCapabilities;
  getMessageHistory(projectDir: string, sessionId: string): Promise<HistoryMessage[]>;
  listSessions(projectDir: string): Promise<Session[]>;
  overlayTrackedSettings(session: Session): void;
  prepareSidecar(sessionId: string, own: SettingUpTurn): Promise<OpenCodeSidecarPlan>;
  registerWithPersisted(sessionId: string, explicit?: OpenCodeSessionPatch): Promise<void>;
  resolveInstalledOllamaTags(payload: ProviderListResponse): Promise<string[] | null>;
  resolveOpenCodeSession(sessionId: string, cwd: string, title?: string): Promise<string>;
  resolveOpenRouterCatalog(payload: ProviderListResponse): Promise<OpenRouterCatalog | null>;
  resolveSessionDirectory(client: OpencodeClient, ocSessionId: string): Promise<string>;
  resolveTurnSettings(sessionId: string, opts?: MessageOpts): Promise<SessionSettings>;
  revokeConnectorTurn(turn: ActiveTurn, reason: RevokeConnectorTurnReason): Promise<void>;
  runOpenCodeTurn(
    sessionId: string,
    cwd: string,
    title: string | undefined,
    trigger: (
      client: OpencodeClient,
      ocSessionId: string,
      dorkosApplied: boolean,
      connectionsApplied: boolean,
      plan: OpenCodeSidecarPlan
    ) => Promise<void>,
    opts?: {
      connectorTurn?: boolean;
      forAgent?: string;
      grants?: readonly DirectoryGrant[];
      permissionCeiling?: TurnPermissionCeiling;
      lifetime?: {
        closed: boolean;
        retire?: () => void;
        acquisition?: NativeSessionAcquisition;
        roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>;
        roomPrepared?: OpenCodePreparedRoomContinuation;
      };
    }
  ): AsyncGenerator<StreamEvent>;
  updateSession(sessionId: string, opts: SessionSettings): Promise<SessionUpdateResult>;
  withContextWindow(
    client: OpencodeClient,
    directory: string,
    providerId: string | undefined,
    event: StreamEvent
  ): Promise<StreamEvent>;
}
