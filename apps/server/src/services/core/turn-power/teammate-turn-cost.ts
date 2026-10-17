/**
 * What each turn a teammate started cost (DOR-2956, the card limit): a runtime decorator that
 * reads the turn's own reported cost as its events pass, and hands it, with the room the turn
 * answered, to whoever counts it against that space's monthly limit
 * (`communities/remote/wake/teammate-spend.ts`).
 *
 * Only a turn marked `roomTurn.teammate` is read; every other turn passes through untouched, so
 * the owner's own turns never count against the limit. A turn that reported no cost is still
 * handed over, as `costUsd: undefined`, so it counts at the estimate rather than not at all.
 *
 * Rooms are the lower layer here and know nothing of spaces, so the counter is set from outside
 * ({@link setTeammateTurnCostSink}); with none set, nothing is counted.
 *
 * @module services/core/turn-power/teammate-turn-cost
 */
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';
import { turnCostReader } from '../../observability/ai-metadata.js';

/** One finished teammate turn: the local room it answered and what it cost, if reported. */
export interface TeammateTurnCost {
  /** The local room id the turn answered (`MessageOpts.roomTurn.roomId`). */
  roomId: string;
  /** The turn's own cost in US dollars, or `undefined` when its runtime reported none. */
  costUsd: number | undefined;
}

let sink: ((turn: TeammateTurnCost) => void) | null = null;

/**
 * Set who counts each finished teammate turn's cost, or `null` to count none.
 *
 * @param next - The counter.
 */
export function setTeammateTurnCostSink(next: ((turn: TeammateTurnCost) => void) | null): void {
  sink = next;
}

/**
 * Wrap a runtime so each turn a teammate started reports what it cost when it ends, however it
 * ends: finished, failed or abandoned by its reader.
 *
 * @param runtime - The runtime to wrap.
 */
export function meterTeammateTurns(runtime: AgentRuntime): AgentRuntime {
  return new Proxy(runtime, {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return (sessionId: string, content: string, opts?: MessageOpts) => {
          const turn = target.sendMessage(sessionId, content, opts);
          const roomId = opts?.roomTurn?.teammate === true ? opts.roomTurn.roomId : undefined;
          return roomId === undefined ? turn : metered(target.type, roomId, turn);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function* metered(
  runtimeType: string,
  roomId: string,
  source: AsyncGenerator<StreamEvent>
): AsyncGenerator<StreamEvent> {
  const cost = turnCostReader(runtimeType);
  try {
    for await (const event of source) {
      cost.see(event);
      yield event;
    }
  } finally {
    try {
      sink?.({ roomId, costUsd: cost.costUsd() });
    } catch (error) {
      // Counting must never break the turn it counts.
      logger.warn('[teammate-turn-cost] Could not count a teammate turn', {
        roomId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
