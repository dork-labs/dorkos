import type { ClaudeCodeRuntime } from '../claude-code-runtime.js';
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import type {
  SessionLockManager,
  NativeSessionAcquisition,
} from '../../../session/session-lock.js';
import type {
  OriginalFrozenRelayDocumentSource,
  PreparedRelayDocumentResponder,
} from '../../../canvas/doc-channel/delivery/relay-native-types.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
} from '../../../canvas/doc-channel/current/current-operation-types.js';
import type { createIsolatedClaudeNativeCustody } from './claude-native-custody.js';
import type { createIsolatedClaudeRelayCustody } from './claude-relay-custody.js';
import type { OriginalClaudeNativePreparationView } from './claude-native-preparation-contracts.js';

/** Original constructor relay assembly view, readable only with its private construction key. */
export interface OriginalClaudeRelayConstructionView {
  readonly runtime: ClaudeCodeRuntime;
  readonly originalLocks: SessionLockManager;
  readonly connectorRuntimeTools: ConnectorRuntimeTools | undefined;
  readonly relayPreparing: Map<
    string,
    { retired: boolean; cleanupFailed?: boolean; cleanupCause?: unknown }
  >;
  readonly claudeRelayDriverStops: ReturnType<
    typeof createIsolatedClaudeRelayCustody
  >['claudeRelayDriverStops'];
  readonly claudeRelayDrivers: ReturnType<
    typeof createIsolatedClaudeRelayCustody
  >['claudeRelayDrivers'];
  readonly claudeRelayPreparers: ReturnType<
    typeof createIsolatedClaudeRelayCustody
  >['claudeRelayPreparers'];
  readonly claudeRelayPrepared: ReturnType<
    typeof createIsolatedClaudeRelayCustody
  >['claudeRelayPrepared'];
  readonly originalRelayClosedTurns: ReturnType<
    typeof createIsolatedClaudeRelayCustody
  >['originalRelayClosedTurns'];
  readonly originalRelayClosedTurnReaders: ReturnType<
    typeof createIsolatedClaudeRelayCustody
  >['originalRelayClosedTurnReaders'];
  readonly claudeRoomPreparers: ReturnType<
    typeof createIsolatedClaudeNativeCustody
  >['claudeRoomPreparers'];
  readonly claudeLockMoves: ReturnType<typeof createIsolatedClaudeNativeCustody>['claudeLockMoves'];
  readonly claudeRuntimeEntries: ReturnType<
    typeof createIsolatedClaudeNativeCustody
  >['claudeRuntimeEntries'];
  readonly claudeLockedRunners: ReturnType<
    typeof createIsolatedClaudeNativeCustody
  >['claudeLockedRunners'];
  prepareRelayDocument(
    source: OriginalFrozenRelayDocumentSource,
    target: Readonly<{ sessionId: string; agentPath: string; agentId: string }>,
    acquisition: NativeSessionAcquisition
  ): Promise<PreparedRelayDocumentResponder | undefined>;
  prepareRoomResponder(
    source: OriginalFrozenRoomSource,
    target: Readonly<{ sessionId: string; agentPath: string; agentId: string }>,
    acquisition: NativeSessionAcquisition
  ): Promise<PreparedRoomResponder | undefined>;
  createMessage: OriginalClaudeNativePreparationView['createMessage'];
}
