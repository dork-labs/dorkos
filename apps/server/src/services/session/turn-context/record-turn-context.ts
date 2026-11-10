/**
 * The one call every runtime adapter makes at the point it hands a prompt to
 * its backend: {@link recordTurnContext}. It never throws and never delays the
 * turn. A record that cannot be written is logged and dropped, because a turn
 * must not fail for want of its own record.
 *
 * @module services/session/turn-context/record-turn-context
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../lib/logger.js';
import type {
  TurnContextInput,
  TurnContextPlace,
  TurnContextStore,
  TurnContextUsage,
} from './turn-context-store.js';

let store: TurnContextStore | null = null;

/**
 * Install the store the adapters record into. Called once at startup; `null`
 * turns recording off (tests that do not exercise it).
 *
 * @param next - The store, or `null`.
 */
export function setTurnContextStore(next: TurnContextStore | null): void {
  store = next;
}

/** The installed store, or `null` when recording is off. */
export function getTurnContextStore(): TurnContextStore | null {
  return store;
}

/**
 * Where a turn is happening, from what its sender told the runtime. A room
 * turn is `dm` when its room is a direct message; a turn its sender named
 * (a scheduled task, a heartbeat, a to-do) keeps that name; anything else is
 * a `chat`.
 *
 * @param opts - The turn's message options.
 */
export function turnPlaceOf(opts: MessageOpts | undefined): TurnContextPlace {
  if (opts?.contextPlace !== undefined) return opts.contextPlace;
  if (opts?.roomTurn === undefined) return 'chat';
  const room = opts.additionalContext?.find((entry) => entry.kind === 'room_context');
  return room?.kind === 'room_context' && room.data.room.kind === 'dm' ? 'dm' : 'room';
}

/**
 * Record what a runtime was just handed. Safe to call on every turn: with no
 * store installed it does nothing, and a failure is logged, never thrown.
 *
 * @param input - What the runtime received, and where.
 * @returns The record's id, or `null` when nothing was recorded.
 */
export function recordTurnContext(input: TurnContextInput): string | null {
  if (store === null) return null;
  try {
    return store.record(input);
  } catch (err) {
    logger.warn('[TurnContext] could not record what a turn was sent', {
      sessionId: input.sessionId,
      runtime: input.runtime,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Attach a runtime's own count of a recorded turn's context once it answers,
 * from work running beside the turn. Never throws.
 *
 * @param id - The record, as {@link recordTurnContext} returned it.
 * @param usage - What the runtime reported.
 */
export function attachTurnContextUsage(id: string, usage: TurnContextUsage): void {
  try {
    store?.attachUsage(id, usage);
  } catch (err) {
    logger.warn('[TurnContext] could not attach a turn’s context usage', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Delete turn-context text past its 30 days. Never throws: a failed sweep is
 * logged and tried again on the next tick.
 */
export function sweepExpiredTurnContext(): void {
  try {
    getTurnContextStore()?.sweepExpired();
  } catch (err) {
    logger.warn('[TurnContext] could not sweep out expired context text', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Delete the records of sessions that are gone, and any text only they held.
 * Never throws.
 *
 * @param sessionIds - The sessions that went away.
 */
export function deleteTurnContextForSessions(sessionIds: readonly string[]): void {
  try {
    getTurnContextStore()?.deleteForSessions(sessionIds);
  } catch (err) {
    logger.warn('[TurnContext] could not delete the records of vanished sessions', {
      sessions: sessionIds.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
