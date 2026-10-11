import type { Db } from '@dorkos/db';
import { type RoomContextData } from '@dorkos/shared/additional-context';
import type { DocChannelStore } from '../../../canvas/doc-channel/store.js';
import { type InstallationFileWrites } from '../../../canvas/doc-channel/writes/installation-file-writes.js';
import { SessionLockManager } from '../../../session/session-lock.js';
import type {
  OriginalFrozenRoomSource,
  PreparedRoomResponder,
  OriginalCommittedRoomResponder,
} from '../../../canvas/doc-channel/current/current-operation-types.js';
import type { MessageOpts, SseResponse } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { TestModeRuntime } from '../test-mode-runtime.js';
import type {
  TestModeNativeEntry,
  TestModeInstalled,
  TestModePreparation,
  OriginalTestModeCanonicalRestart,
} from './test-mode-native-types.js';

/** Allocate an isolated native custody family; only the root retains its actual instance. */
export function createIsolatedTestModeNativeCustody() {
  const testModeNativeConstructors = new WeakMap<
    object,
    {
      entries: Map<string, TestModeNativeEntry>;
      scenarioStarts: () => number;
      isLaunchAlias(
        request: import('../../../rooms/room-turn-port.js').RoomTurnRequest,
        retiredId: string
      ): boolean;
      readPreparedRoomContext(sessionId: string): RoomContextData | undefined;
      readActiveStream(sessionId: string): AsyncGenerator<StreamEvent> | undefined;
      captureRestart(sessionId: string, db: Db): OriginalTestModeCanonicalRestart;
      move(oldKey: string, canonicalKey: string, holder: SseResponse): boolean;
      captureEmitter(owner: InstallationFileWrites, db: Db, store: DocChannelStore): void;
      requireEmitterClosed(db: Db): void;
      locked(
        session: string,
        text: string,
        opts: MessageOpts | undefined,
        holder: SseResponse,
        key: string
      ): AsyncGenerator<StreamEvent>;
      prepare(
        source: OriginalFrozenRoomSource,
        holder: SseResponse,
        key: string
      ): Promise<PreparedRoomResponder | undefined>;
    }
  >();
  const testModeNativeOperations = new WeakMap<object, TestModeNativeEntry>();
  const testModePrepared = new WeakMap<PreparedRoomResponder, TestModePreparation>();
  const testModeOriginalStreams = new WeakMap<
    object,
    {
      runtime: TestModeRuntime;
      own: TestModeInstalled;
      sessionId: string;
      options: Readonly<MessageOpts>;
      stopContinuation(): boolean;
      stopEvents: WeakSet<object>;
      resolve(): Promise<
        import('../../../connectors/runtime-principal-port.js').ResolveConnectorTurnResult
      >;
    }
  >();

  const testModeStreams = new WeakMap<
    object,
    {
      runtime: object;
      prepared: PreparedRoomResponder;
      operation: object;
      committed: OriginalCommittedRoomResponder;
      events: WeakSet<object>;
      terminal?: 'turn_done' | 'failed' | 'cancelled';
      retire(): Promise<void>;
    }
  >();
  const nativeSignalAborted = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    'aborted'
  )!.get!;
  const originalMapGet = Map.prototype.get;
  const originalObjectFreeze = Object.freeze;
  const originalMapSet = Map.prototype.set;
  const originalMapEntries = Map.prototype.entries;

  const originalCanonicalRestarts = new WeakMap<
    OriginalTestModeCanonicalRestart,
    {
      runtime: TestModeRuntime;
      db: Db;
      entry: TestModeNativeEntry;
      locks: SessionLockManager;
    }
  >();

  return {
    testModeNativeConstructors,
    testModeNativeOperations,
    testModePrepared,
    testModeOriginalStreams,
    testModeStreams,
    nativeSignalAborted,
    originalMapGet,
    originalObjectFreeze,
    originalMapSet,
    originalMapEntries,
    originalCanonicalRestarts,
  };
}
