/**
 * Doe's half of the turn-context record. Doe takes DorkOS's whole context,
 * per-turn blocks included, on its system channel, and reloads that channel
 * for every model request of a turn. So the record is taken where the engine
 * loads it: the first load, and again whenever a steer changed what it reads.
 *
 * @module services/runtimes/doe/turn-context-record
 */
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import { recordTurnContext, turnPlaceOf } from '../../session/turn-context/record-turn-context.js';

/** One Doe turn, as far as its record needs to know it. */
export interface DoeTurnForRecord {
  /** The session taking the turn. */
  sessionId: string;
  /** The turn's message options, for where it happened. */
  opts: MessageOpts | undefined;
  /** The permission mode the turn runs at. */
  mode: string | undefined;
  /** The person's words, when the turn carries any (a beat or a compaction carries none). */
  content: string | undefined;
}

/**
 * A pass-through for the system channel that records what it hands the
 * engine. The first load records the system text and the person's words; a
 * later load records again only when the text changed (a steer added to it).
 *
 * @param turn - The turn being recorded.
 * @returns A function that records the loaded text, then returns it unchanged.
 */
export function doeContextRecorder(turn: DoeTurnForRecord): (system: string) => string {
  let last: string | undefined;
  return (system) => {
    if (system === last) return system;
    const first = last === undefined;
    last = system;
    recordTurnContext({
      sessionId: turn.sessionId,
      ...(turn.opts?.messageId !== undefined ? { messageId: turn.opts.messageId } : {}),
      runtime: 'doe',
      place: turnPlaceOf(turn.opts),
      ...(turn.mode !== undefined ? { permissionMode: turn.mode } : {}),
      systemSentThisTurn: true,
      parts: [
        { slot: 'system', text: system },
        ...(first && turn.content !== undefined ? [{ slot: 'message', text: turn.content }] : []),
      ],
    });
    return system;
  };
}
