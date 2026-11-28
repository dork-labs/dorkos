/**
 * `wake_chat` (spec `turns-survive-restarts` §6.2, §6.3; T7, DOR-5215): make
 * the run one event's wake asks for, through the space face, keyed by the
 * wake's own key (`wake:<sourceKind>:<eventId>`).
 *
 * **Safe to repeat by key.** A run its key already made means an earlier
 * attempt made it and died before this effect was marked done: the effect is
 * done, and nothing is made twice. Otherwise the run is made and the effect
 * marked done in one transaction (§6.4), so neither commits without the other.
 *
 * **A chat that is gone.** A wake that asked for a stored chat
 * (`onlyIfChatExists`) and finds none is dropped: an event can outlive its
 * chat, and a wake must never start a new one.
 *
 * **Refused at the door.** A start the space face refuses (words past the cap,
 * an agent nobody answers to) is dropped with its reason: asking again cannot
 * change it.
 *
 * @module services/runs/effects/handlers/wake-chat
 */
import { WakeRequestSchema } from '@dorkos/shared/turn-port';
import { logger } from '../../../../lib/logger.js';
import type { RunStore } from '../../run-store.js';
import { TurnStartRefusedError, type SpaceTurnPort } from '../../turn-port.js';
import { letGoOfWakeWords, WAKE_SOURCE } from '../wakes.js';
import type { EffectStore } from '../effect-store.js';
import type { EffectHandler } from '../worker.js';

/** What the handler needs. */
export interface WakeChatDeps {
  runs: Pick<RunStore, 'findByStartKey' | 'transaction'>;
  /** The outbox, where a wake that ends with no run lets go of its words (§6.2). */
  effects: Pick<EffectStore, 'get' | 'replacePayload'>;
  port: Pick<SpaceTurnPort, 'start'>;
  /**
   * Whether a chat is stored anywhere, probed in a folder. Handed in at
   * startup: the answer is the runtime's. Absent, every chat counts as stored.
   */
  chatExists?: (sessionId: string, cwd: string) => Promise<boolean>;
}

/**
 * The handler.
 *
 * @param deps - The record, the space face and the runtime's answer for a chat.
 */
export function wakeChatHandler(deps: WakeChatDeps): EffectHandler {
  return {
    async handle(effect, ctx) {
      const wake = WakeRequestSchema.safeParse(effect.payload);
      if (!wake.success) return { kind: 'drop', reason: 'unreadable_payload' };
      const made = deps.runs.findByStartKey(effect.key);
      if (made) return { kind: 'done', outcome: { runId: made.id, again: true } };
      const { start, onlyIfChatExists } = wake.data;
      if (onlyIfChatExists && deps.chatExists) {
        const stored = await deps.chatExists(start.sessionId, onlyIfChatExists.cwd);
        if (!stored) return { kind: 'drop', reason: 'session_gone' };
      }
      try {
        const runId = deps.runs.transaction(() => {
          const answer = deps.port.start({
            ...start,
            startKey: effect.key,
            sourceRef: `${WAKE_SOURCE}:${effect.id}`,
          });
          ctx.markDone({ runId: answer.runId });
          return answer.runId;
        });
        return { kind: 'done', outcome: { runId } };
      } catch (err) {
        if (err instanceof TurnStartRefusedError) return { kind: 'drop', reason: err.reason };
        throw err;
      }
    },
    onEnded(effect) {
      // Ended with no run (dropped, or failed for good): its words go now. A
      // wake that made its run lets go of them when that run ends.
      if (!deps.runs.findByStartKey(effect.key)) letGoOfWakeWords(deps.effects, effect.id);
    },
    onExpired(effect) {
      letGoOfWakeWords(deps.effects, effect.id);
      // Nobody waits on a wake: its source moved on long ago. Kept for the record.
      logger.info('[runs] a wake passed its deadline before its turn was asked for', {
        effectId: effect.id,
        key: effect.key,
      });
    },
  };
}
