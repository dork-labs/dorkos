/**
 * Keep the computer awake while agents work (spec `keep-awake`, DOR-2718).
 *
 * @module services/core/keep-awake
 */
export {
  keepAwakeService,
  KeepAwakeService,
  TURN_IDLE_CEILING_MS,
  type KeepAwakeStartDeps,
  type TaskAwakeHold,
  type TaskAwakeHolds,
  type TurnAwakeHold,
  type TurnDescriptor,
} from './keep-awake-service.js';
export { holdAwakeDuringTurns } from './hold-during-turn.js';
