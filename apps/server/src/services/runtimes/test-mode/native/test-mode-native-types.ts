import type { OpenConnectorTurnResult } from '../../../connectors/runtime-principal-port.js';
import { type NativeSessionAcquisition } from '../../../session/session-lock.js';
import type { OriginalRoomDispatchCustody } from '../../../rooms/service/room-core.js';
import type {
  OriginalFrozenRoomSource,
  OriginalCommittedRoomResponder,
} from '../../../canvas/doc-channel/current/current-operation-types.js';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { TestModeRuntime } from '../test-mode-runtime.js';

/** Original constructor-owned native entry DATA. */
export type TestModeNativeEntry = {
  runtime: TestModeRuntime;
  sessionId: string;
  canonicalSessionId: string;
  path: string;
  acquisition: NativeSessionAcquisition;
  controller: AbortController;
  retired: boolean;
  closed: boolean;
  holder: SseResponse;
  scenarioStarts: number;
  interrupted?: true;
  placementOptions?: Readonly<{
    cwd?: string;
    forAgent?: string;
    additionalDirectories?: readonly Readonly<{ path: string; access: 'read' | 'write' }>[];
  }>;
  canonicalScenarioStarted?: true;
  roomOrigin?: { holder: SseResponse; custody: OriginalRoomDispatchCustody };
  closeScenario?: () => void;
};
/** Original installed native operation contract. */
export type TestModeInstalled = {
  entry: TestModeNativeEntry;
  operation: object;
  retire(): Promise<void>;
  open(): Promise<OpenConnectorTurnResult>;
};
/** Original private prepared responder contract. */
export type TestModePreparation = {
  runtime: TestModeRuntime;
  source: OriginalFrozenRoomSource;
  nativeOperation: object;
  entry: TestModeNativeEntry;
  binding: OpenConnectorTurnResult;
  retire(): Promise<void>;
  start(committed: OriginalCommittedRoomResponder): AsyncGenerator<StreamEvent>;
};
/** Opaque observation of one real held canonical producer; no alias/source authority is issued. */
export interface OriginalTestModeCanonicalRestart {
  readonly kind: 'original-testmode-canonical-restart';
}
