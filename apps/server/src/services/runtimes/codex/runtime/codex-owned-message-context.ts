import type {
  AgentRegistryPort,
  AgentRuntime,
  ManagedMcpServerResolver,
  MessageOpts,
  SseResponse,
} from '@dorkos/shared/agent-runtime';
import type { Session, SessionSettings } from '@dorkos/shared/types';
import type { CodexTransport } from '../transport/index.js';
import type { CodexSessionRegistry } from '../session-registry.js';
import type { CodexThreadMap, CodexThreadMetadataPatch } from '../thread-map.js';
import type { CodexContextGate } from '../context-gate.js';
import type { AccountsAccessContext } from '../../shared/accounts-access-context.js';
import type { SessionAttachmentStore } from '../../../session/attachments/index.js';
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import type { NativeSessionAcquisition } from '../../../session/session-lock.js';
import type { OriginalRoomDispatchCustody } from '../../../rooms/service/room-core.js';
import type { CodexNativeEntry } from './codex-native-custody.js';
import type { AgentHome } from '../../../core/agent-identity/index.js';
import type { CreditsLaunch } from '../../../core/cloud/credits-protocols.js';

/** Fixed live receiver projection known only to the actual runtime's private producer key. */
export interface OriginalCodexOwnedMessageView {
  readonly runtime: AgentRuntime;
  readonly transport: CodexTransport;
  readonly runTransportTurn: CodexTransport['runTurn'];
  readonly dispatchedTurnListeners: Set<(sessionId: string) => void>;
  readonly consecutiveWakes: Map<string, number>;
  readonly threadMap: CodexThreadMap;
  readonly registry: CodexSessionRegistry;
  readonly defaultCwd: string;
  readonly meshCore: AgentRegistryPort | undefined;
  readonly connectorRuntimeTools: ConnectorRuntimeTools | undefined;
  readonly managedMcpServers: ManagedMcpServerResolver | undefined;
  readonly creditsTurns: Set<AbortController>;
  readonly activeConnectorBindings: Map<AbortController, string>;
  readonly activeTurns: Map<string, AbortController>;
  readonly type: 'codex';
  readonly contextGate: CodexContextGate;
  readonly accountsAccess: AccountsAccessContext;
  readonly attachments: SessionAttachmentStore | null;
  readonly importNativeThread: (sessionId: string, isCurrent?: () => boolean) => Promise<void>;
  readonly seedFromDurable: (sessionId: string) => Promise<void>;
  readonly resolveTurnSettings: (sessionId: string, opts?: MessageOpts) => Promise<SessionSettings>;
  readonly persistSessionMetadata: (sessionId: string) => void;
  readonly identityPathFor: (cwd: string, forAgent: string | undefined) => AgentHome | undefined;
  readonly creditsLaunchFor: (threadId: string | undefined) => Promise<CreditsLaunch | null>;
  readonly getCapabilities: AgentRuntime['getCapabilities'];
  readonly updateSession: AgentRuntime['updateSession'];
  readonly resolveTurnBinary: () => Promise<string>;
  readonly toMetadataPatch: (session: Session) => CodexThreadMetadataPatch;
  readonly installNativeTurn: (
    sessionId: string,
    cwd: string,
    agentPath: string | undefined,
    controller: AbortController,
    acquisition?: NativeSessionAcquisition,
    refuseExisting?: boolean,
    roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>
  ) => { nativeOperation: object; nativeEntry: CodexNativeEntry };
}
