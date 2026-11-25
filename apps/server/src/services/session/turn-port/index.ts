/**
 * The computer face of the turn port (spec `turns-survive-restarts` §3.3): the
 * one door into turn code that `services/runs` may import (§3.4).
 *
 * For now it holds the facts sink the run record registers with, and the one
 * lookup the run record needs to name a chat the way its queue rows do. The
 * computer face itself (`start`, `stop`, `answer`) lands with T5.
 *
 * @module services/session/turn-port
 */
export {
  isRunHeld,
  setTurnFactsSink,
  turnFacts,
  type DispatcherRunFeed,
  type LaunchVerdict,
  type ObservedTurnEnd,
  type QueueRowExit,
  type TurnFactsSink,
} from './facts.js';
export { queueKeyOf as chatKeyOf } from '../resolution/session-key-registry.js';
