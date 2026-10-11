import { type OriginalDownstreamRoomEmitter } from '../../../canvas/doc-channel/downstream/native-room-emitter.js';
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';
import { SessionLockManager } from '../../../session/session-lock.js';
import type { ManagedMcpServerResolver, SessionSettingsPort } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { TestModeRuntime } from '../test-mode-runtime.js';
import type { TestModeNativeEntry } from '../native/test-mode-native-types.js';
import type { TestModeNativeGuardedCustody } from '../test-mode-runtime.js';
import type { TestModeSessionRegistry } from '../session-registry.js';

/** Fixed original runtime fields; only the inaccessible actual family key selects this view. */
export interface TestModeScenarioSessionView {
  readonly runtime: TestModeRuntime;
  readonly custody: TestModeNativeGuardedCustody;
  readonly type: string;
  readonly registry: TestModeSessionRegistry;
  readonly settingsPort: SessionSettingsPort | undefined;
  readonly managedMcp: ManagedMcpServerResolver | undefined;
  readonly openTurns: Map<string, number>;
  readonly nativeEntries: Map<string, TestModeNativeEntry>;
  readonly nativePrincipals: ConnectorRuntimePrincipalPort | undefined;
  readonly nativeRoomEmitter: OriginalDownstreamRoomEmitter | undefined;
  originalScenarioStarts: number;
  readonly nativeLocks: SessionLockManager;
  readonly originalNativeCanonicalAliases: Map<string, string>;
  readonly declaredCanonicalIds: Map<string, { canonicalId: string; revealed: boolean }>;
  revealCanonicalSessionId(sessionId: string): void;
  syntheticCompaction(): AsyncGenerator<StreamEvent>;
}
