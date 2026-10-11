import type {
  RoomDocNative,
  NativeRoomDocCommit,
  RoomDocSourceData,
  CommitState,
  RoomDocOutcome,
  OriginalReacquiredAcceptedRoomSource,
  OriginalReacquiredPendingRoomSource,
  ConfirmedRoomBarrier,
  BarrierState,
  AcceptedRoomSourceKey,
} from './room-doc-types.js';
import type { RoomDocNativeOperation } from './room-doc-statements.js';

/** Internal ephemeral owner context; no singleton state or issuer registry is exported. */
export interface RoomDocLifecycleContext {
  native: RoomDocNative;
  execute: RoomDocNative['executeDoc'];
  guard: (frame?: object, allowLegacy?: boolean) => 'native' | 'legacy';
  requireCommit: (commit: NativeRoomDocCommit) => CommitState;
  failure: (frame: object | undefined) => RoomDocOutcome<never>;
  run: (
    operation: RoomDocNativeOperation,
    bindings: Record<string, unknown>,
    expected?: number
  ) => void;
  transition: (
    commit: NativeRoomDocCommit,
    kind: 'projected' | 'unknown' | 'terminal',
    value?: string
  ) => RoomDocOutcome<NativeRoomDocCommit>;
  clock: () => number;
  iso: (at: number) => string;
  reacquired: WeakMap<OriginalReacquiredAcceptedRoomSource, Readonly<RoomDocSourceData>>;
  pendingReacquired: WeakMap<OriginalReacquiredPendingRoomSource, Readonly<RoomDocSourceData>>;
  barriers: WeakMap<ConfirmedRoomBarrier, BarrierState>;
  active: Map<string, ConfirmedRoomBarrier>;
  commits: WeakMap<NativeRoomDocCommit, CommitState>;
  currentCommits: Map<string, NativeRoomDocCommit>;
  unknownCommits: WeakSet<NativeRoomDocCommit>;
  producerRows: (data: RoomDocSourceData) => void;
  pendingProducerRows: (data: RoomDocSourceData) => void;
  readAcceptedSource: (key: AcceptedRoomSourceKey) => Readonly<RoomDocSourceData>;
  readPendingSource: (key: AcceptedRoomSourceKey) => Readonly<RoomDocSourceData>;
  readonly ownDb: object | undefined;
  originalEmissionFrame: object | undefined;
}
