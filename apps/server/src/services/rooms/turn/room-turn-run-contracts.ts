import type { AgentRuntime, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import type { Room } from '@dorkos/shared/room-schemas';
import type { RoomTurnRequest, RoomTurnRunner } from '../room-turn-port.js';
import type {
  OriginalRoomRunnerObservation,
  OriginalRoomRunnerComputedDefaults,
} from '../room-turn-runner.js';
import type { createRoomTurnStopState } from './room-turn-stop-state.js';
import type { collectReply } from '../room-turn-reply-collector.js';
import type { ReplyCollector } from './room-reply-collector-contracts.js';

type OriginalReplyArguments =
  Parameters<typeof collectReply> extends [object, ...infer Args] ? Args : never;

/** Exact private active original launch DATA, never a reusable caller capability. */
export interface RoomTurnLaunchRecord {
  runner: RoomTurnRunner;
  sessionId: string;
  prepare: NonNullable<RoomTurnRequest['prepareLaunch']>;
  active: boolean;
}

/** Exact private original preparation DATA. */
export interface RoomTurnPreparationRecord {
  runner: RoomTurnRunner;
  sessionId: string;
  prepare: RoomTurnRequest['prepareLaunch'];
}

/** Exact original observed completion DATA and current computed defaults holder. */
export interface RoomTurnCompletionRecord {
  request: RoomTurnRequest;
  observation: OriginalRoomRunnerObservation;
  defaults: { value?: OriginalRoomRunnerComputedDefaults };
}

/** Factory-private original runner state and fixed free-call identities, accepted only through the root key reader. */
export interface RoomTurnRunView {
  readonly runner: RoomTurnRunner;
  readonly stopState: ReturnType<typeof createRoomTurnStopState<AgentRuntime>>;
  readonly readWaitMs: () => number;
  readonly readCeilingMs: () => number;
  readonly readGraceMs: () => number;
  readonly readRoomConventionsBlock: (room: Room) => Promise<string | null>;
  readonly observeBeforeDispatch: ((entryId: string) => void) | undefined;
  readonly collectReply: (...args: OriginalReplyArguments) => ReplyCollector;
  readonly copyOriginalRoomPermissionCeiling: (
    ceiling: TurnPermissionCeiling
  ) => TurnPermissionCeiling;
  readonly originalPlacedContexts: WeakMap<RoomTurnRunner, Map<string, RoomTurnRequest>>;
  readonly originalCompletions: WeakMap<RoomTurnRunner, RoomTurnCompletionRecord>;
  readonly originalLaunches: WeakMap<RoomTurnRequest, RoomTurnLaunchRecord>;
  readonly originalPreparations: WeakMap<RoomTurnRequest, RoomTurnPreparationRecord>;
  readonly ROOM_CLIENT_ID: string;
}
