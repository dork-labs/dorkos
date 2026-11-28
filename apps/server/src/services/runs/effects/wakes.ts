/**
 * Wakes (spec `turns-survive-restarts` §6.2 `wake_chat`, §6.3; T7, DOR-5215):
 * a source that starts a turn in a chat by itself (an approval's verdict, a
 * browser hand-back, a finished sign-in, a widget click, a to-do) saves one
 * `wake_chat` effect per event, in the same write as the change that causes it.
 * The effect's handler (`handlers/wake-chat.ts`) then makes the run.
 *
 * **One event, one turn.** The wake and its run share one key,
 * `wake:<sourceKind>:<eventId>`, with the event id minted at the source. A
 * second save of the key saves nothing (`turn_effects.key` is unique), and a
 * second making of the run makes nothing (`turn_runs.start_key` is unique), so
 * a restart at any point between the two neither loses the wake nor doubles it.
 *
 * **Where its words wait.** A wake's words are DorkOS's own copy or the click
 * itself, with no store of their own: they ride the wake's payload, and its
 * run names the wake as its source (`wake:<effectId>`), so a restart before
 * the turn starts reads them back from there. **Only until its run ends:** the
 * outbox keeps its rows for their keys and is never pruned, so once the run
 * ends, or the wake ends with no run, the payload is cut down to what names the
 * event ({@link letGoOfWakeWords}). The key stays, so one event is still one
 * turn. The words have one reader each: the wake's handler and
 * {@link wakeWords}. Never log them or answer them from a route, tool or view.
 *
 * @module services/runs/effects/wakes
 */
import { WakeRequestSchema, wakeStartKey, type WakeRequest } from '@dorkos/shared/turn-port';
import type { WordSource } from '../turn-port.js';
import type { EffectStore } from './effect-store.js';

/** How long a wake whose source set no deadline may wait to make its run (§6.2). */
export const WAKE_NOT_AFTER_MS = 24 * 60 * 60_000;

/** The source kind a wake's run keeps its words under; its id is the wake effect's. */
export const WAKE_SOURCE = 'wake';

/**
 * Save one event's wake, unless its key is already saved. Call it inside the
 * transaction that writes the change causing it.
 *
 * @param effects - The outbox.
 * @param request - The wake. Parsed here, so a source cannot save more.
 * @param now - The clock, epoch ms.
 * @returns Whether this call saved it.
 */
export function saveWake(effects: EffectStore, request: WakeRequest, now: number): boolean {
  const wake = WakeRequestSchema.parse(request);
  return effects.insert({
    kind: 'wake_chat',
    key: wakeStartKey(wake.sourceKind, wake.eventId),
    payload: wake,
    delivery: 'repeatable',
    // The source's deadline when it asked not to run late; else a day (§6.2).
    notAfter: wake.start.notAfter ?? now + WAKE_NOT_AFTER_MS,
  });
}

/**
 * The reader of a wake's run's words: the wake's own payload, by its effect id.
 *
 * @param effects - The outbox.
 */
export function wakeWords(effects: Pick<EffectStore, 'get'>): WordSource {
  return {
    read(id) {
      const effect = effects.get(id);
      if (effect?.kind !== 'wake_chat') return undefined;
      const wake = WakeRequestSchema.safeParse(effect.payload);
      return wake.success ? wake.data.start.content : undefined;
    },
  };
}

/**
 * Let go of a wake's words, inside the transaction that ends its run or the
 * wake itself (§6.2): the payload keeps only what names the event (its source
 * kind, its id, the chat and the origin). Not before: a pause can put a run
 * back in line after the runtime's first event (transition 15).
 *
 * @param effects - The outbox.
 * @param effectId - The wake's effect.
 */
export function letGoOfWakeWords(
  effects: Pick<EffectStore, 'get' | 'replacePayload'>,
  effectId: string
): void {
  const effect = effects.get(effectId);
  if (effect?.kind !== 'wake_chat') return;
  const wake = WakeRequestSchema.safeParse(effect.payload);
  if (!wake.success) return;
  const { sourceKind, eventId, start } = wake.data;
  effects.replacePayload(effectId, {
    sourceKind,
    eventId,
    sessionId: start.sessionId,
    origin: start.origin,
    wordsLetGo: true,
  });
}
