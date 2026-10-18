/**
 * What a room turn tells the room while it waits, and why it failed when it
 * never started, read off the turn's own session stream.
 *
 * Split out of `room-turn-runner.ts`, which is past the line ceiling, when a
 * second kind of wait arrived (DOR-3012): besides a prompt a person has to
 * answer, a turn can now wait for a free agent slot on this computer, because a
 * full warm ceiling queues the turn instead of failing it.
 *
 * @module services/rooms/turn-guards/turn-waits
 */
import { SLOT_WAIT_STATUS } from '@dorkos/shared/schemas';
import { isBlockingInteractionEvent, type SessionEvent } from '@dorkos/shared/session-stream';
import { TURN_NOT_STARTED_CODE } from '../../session/launch/turn-not-started.js';
import type { RoomTurnWaiting } from '../room-trigger.js';
import { WAITING_KINDS } from './waiting-kinds.js';

/** The key a slot wait is filed under among a turn's waits; never an interaction id. */
const SLOT_WAIT_KEY = 'dorkos:slot-wait';

/** The grace timer for each wait a turn is in, keyed by what it waits on. */
export type TurnWaits = Map<string, ReturnType<typeof setTimeout>>;

/**
 * Whether `event` is the runtime saying the turn is waiting for a free slot.
 *
 * @param event - One event from the turn's stream
 */
export function isSlotWaitEvent(event: SessionEvent): boolean {
  return event.type === 'system_status' && event.status === SLOT_WAIT_STATUS;
}

/**
 * Start or end a wait from one event of the turn.
 *
 * Every wait is reported only once it has lasted `graceMs` and is still true,
 * so a prompt answered in seconds, or a slot that frees in seconds, leaves no
 * line in the room. A slot wait ends at the first event that is not itself one:
 * anything else the runtime produces means the turn has started.
 *
 * @param event - One event from the turn's stream
 * @param waits - The turn's outstanding grace timers
 * @param bounds.graceMs - How long a wait may last before it is mentioned
 * @param bounds.onWaiting - Mentions a wait that is still true at its grace
 */
export function noteTurnWait(
  event: SessionEvent,
  waits: TurnWaits,
  bounds: { graceMs: number; onWaiting: (waiting: RoomTurnWaiting) => void }
): void {
  const arm = (key: string, waiting: RoomTurnWaiting): void => {
    if (waits.has(key)) return;
    const grace = setTimeout(() => {
      waits.delete(key);
      bounds.onWaiting(waiting);
    }, bounds.graceMs);
    grace.unref?.();
    waits.set(key, grace);
  };
  const end = (key: string): void => {
    clearTimeout(waits.get(key));
    waits.delete(key);
  };
  if (isSlotWaitEvent(event)) return arm(SLOT_WAIT_KEY, { kind: 'slot' });
  end(SLOT_WAIT_KEY);
  // A prompt the turn has stopped on. Reported per prompt; the room damps
  // repeats, so a turn that stops three times still says so once.
  if (isBlockingInteractionEvent(event)) {
    arm(event.id, {
      kind: WAITING_KINDS[event.type],
      ...(event.type === 'approval_required' ? { toolName: event.toolName } : {}),
    });
  }
  // Answered, denied, cancelled or timed out — every ending arrives here
  // (`interaction_cancelled` is normalized into this event), so the room says
  // nothing about a wait that is already over.
  if (event.type === 'interaction_resolved') end(event.id);
}

/**
 * Why a room turn failed: for the room's notice, which names a refusal a
 * person can understand, and for the log, which says what happened on every
 * failure (DOR-3012: most of the 2026-10-18 failures logged no reason at all).
 */
export interface TurnFailure {
  /** The runtime's `TurnRefusal`, when it refused the turn before it started. */
  refusal?: string;
  /** What happened, for the log: the turn's own error, or how its read ended. */
  detail: string;
}

/**
 * Fold one event of the turn into what is known about why it failed. The
 * first error wins; a turn the runtime refused carries its refusal too.
 *
 * @param known - What is known so far
 * @param event - One event from the turn's stream
 */
export function noteTurnFailure(
  known: Partial<TurnFailure>,
  event: SessionEvent
): Partial<TurnFailure> {
  if (event.type !== 'error' || known.detail !== undefined) return known;
  const refused = event.code === TURN_NOT_STARTED_CODE && event.reason !== undefined;
  return { detail: event.message, ...(refused ? { refusal: event.reason } : {}) };
}

/**
 * Everything known about a failed turn, with a detail even when no error event
 * said one.
 *
 * @param known - What the turn's events said
 * @param ended - Whether the turn reached its `turn_end`
 */
export function settleTurnFailure(known: Partial<TurnFailure>, ended: boolean): TurnFailure {
  const fallback = ended ? 'the turn ended in an error' : 'the turn never reached its end';
  return { ...known, detail: known.detail ?? fallback };
}

/**
 * The `unanswered` half of a room reply for a turn that failed, carrying why.
 *
 * @param turn.failure - Why the turn failed, when that is known
 */
export function failedReply(turn: { failure?: TurnFailure }): {
  unanswered: 'failed';
  failure?: TurnFailure;
} {
  return {
    unanswered: 'failed',
    ...(turn.failure !== undefined ? { failure: turn.failure } : {}),
  };
}
