/**
 * What an `ended` run owes (spec `turns-survive-restarts` §6.1, "Writing"):
 * the follow-up effects written in the same transaction as the move to
 * `ended` that causes them. No effect is ever created from a timer or a
 * listener after the commit.
 *
 * @module services/runs/effects/follow-ups
 */
import type { TurnRun } from '../run-store.js';
import type { EffectStore } from './effect-store.js';
import { planTurnFinishedNotice } from './handlers/notify-person.js';

/**
 * Write every follow-up an `ended` run owes. Inside the transaction that ended it.
 *
 * @param effects - The outbox.
 * @param run - The run, as stored after its move to `ended`.
 * @param now - The clock, epoch ms.
 */
export function writeFollowUpsOfEnded(effects: EffectStore, run: TurnRun, now: number): void {
  const notice = planTurnFinishedNotice(run, now);
  if (notice) effects.insert(notice);
}
