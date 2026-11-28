/**
 * The computer face of the turn port (spec `turns-survive-restarts` §3.3): the
 * one door into turn code that `services/runs` may import (§3.4).
 *
 * It hands out the face startup installed (`start`, `withdraw`, `holds`; built
 * over this Mac's dispatcher by `computer-turn-port.ts`, which nothing on the
 * space side imports), the facts sink the run record registers with, and the few
 * reads the space side needs of this computer: how a chat is named the way
 * its queue rows are, whether a queue row still holds a run's words, and
 * whether every launch slot is taken (admission, §3.5). Recovery (§7) reaches
 * the launch gate's seat, a restarted turn's queue row and the lost-work wake
 * through here too.
 *
 * @module services/session/turn-port
 */
import type { ChatRun } from '@dorkos/shared/run-schemas';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { getMessageQueueStore } from '../message-queue-store.js';
import { peekProjector } from '../session-state-projector.js';
import { queueKeyOf } from '../resolution/session-key-registry.js';

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
export { setLaunchGate, wakeChat, type LaunchGate } from './launch-gate.js';
export { dropKeptRow, keptRowIds, restoreDraftRow, tellSenderTurnLost } from './restart-rows.js';
export {
  wakeCutShortChat as wakeChatForLostWork,
  type WakeOutcome,
} from '../runtime-turns/wake-cut-short-work.js';

/**
 * Whether a queue row still holds its words (a run handed over through the
 * port that took a row is never handed over again while it does, §6.2).
 *
 * @param queueMessageId - The row.
 */
export function queueRowExists(queueMessageId: string): boolean {
  return getMessageQueueStore()?.get(queueMessageId) !== undefined;
}

/**
 * The ids of a chat's rows waiting in line, head first: what a waiting run's
 * place in line is read from (spec §4.6), never stored twice.
 *
 * @param chatKey - The chat, by any id it answers to.
 */
export function waitingRowOrder(chatKey: string): string[] {
  return (getMessageQueueStore()?.list(queueKeyOf(chatKey)) ?? []).map((row) => row.id);
}

/**
 * Put a chat's runs on its durable stream as one `run_update` (spec §4.6).
 * Only the run record calls this, after the write that changed a run: the
 * computer face carries the event to the chat's stream and decides nothing.
 * A no-op when nobody watches the chat; the next snapshot reads the record.
 *
 * @param chatKey - The chat, by any id it answers to.
 * @param runs - The chat's runs as every device reads them, read only when someone watches.
 */
export function emitRunUpdate(chatKey: string, runs: () => ChatRun[]): void {
  const projector = peekProjector(queueKeyOf(chatKey));
  if (!projector) return;
  // Narrowed member by member: `Omit<SessionEvent, 'seq'>` keeps only the union's shared keys.
  const event: Omit<Extract<SessionEvent, { type: 'run_update' }>, 'seq'> = {
    type: 'run_update',
    runs: runs(),
  };
  projector.ingest(event);
}
