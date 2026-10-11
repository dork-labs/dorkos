import type { TestModeRuntime } from '../test-mode-runtime.js';
import type { createIsolatedTestModeNativeCustody } from './test-mode-native-custody.js';
import type { TestModeNativeEntry } from './test-mode-native-types.js';
import type { SessionLockManager } from '../../../session/session-lock.js';
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';

/** Fixed original native acquisition state; no registrar or caller-supplied currentness callback. */
export interface OriginalTestModeNativeAcquisitionView {
  readonly runtime: TestModeRuntime;
  readonly entries: Map<string, TestModeNativeEntry>;
  readonly locks: SessionLockManager;
  readonly principals: ConnectorRuntimePrincipalPort | undefined;
  readonly aliases: Map<string, string>;
  readonly originalMapGet: ReturnType<typeof createIsolatedTestModeNativeCustody>['originalMapGet'];
  readonly originalMapSet: ReturnType<typeof createIsolatedTestModeNativeCustody>['originalMapSet'];
  readonly originalMapEntries: ReturnType<
    typeof createIsolatedTestModeNativeCustody
  >['originalMapEntries'];
  readonly nativeSignalAborted: ReturnType<
    typeof createIsolatedTestModeNativeCustody
  >['nativeSignalAborted'];
  readonly originalCanonicalRestarts: ReturnType<
    typeof createIsolatedTestModeNativeCustody
  >['originalCanonicalRestarts'];
}
