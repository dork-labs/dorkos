/**
 * The computer face of the turn port (spec `turns-survive-restarts` §3.3): the
 * one door into turn code that `services/runs` may import (§3.4).
 *
 * It hands out the face startup installed (`start`, `withdraw`, `holds`; built
 * over this Mac's dispatcher by `computer-turn-port.ts`, which nothing on the
 * space side imports), the facts sink the run record registers with, and the few
 * reads the space side needs of this computer: how a chat is named the way
 * its queue rows are, whether a queue row still holds a run's words, and
 * whether every launch slot is taken (admission, §3.5).
 *
 * @module services/session/turn-port
 */
import { getMessageQueueStore } from '../message-queue-store.js';

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
export {
  getComputerTurnPort,
  setComputerTurnPort,
  type ComputerTurnPort,
} from './computer-face.js';
export { queueKeyOf as chatKeyOf } from '../resolution/session-key-registry.js';
export { isAgentLaunchCapFull } from '../launch/launch-cap.js';

/**
 * Whether a queue row still holds its words (a run handed over through the
 * port that took a row is never handed over again while it does, §6.2).
 *
 * @param queueMessageId - The row.
 */
export function queueRowExists(queueMessageId: string): boolean {
  return getMessageQueueStore()?.get(queueMessageId) !== undefined;
}
