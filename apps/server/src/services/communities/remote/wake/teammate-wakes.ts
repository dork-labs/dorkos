/**
 * The budget a teammate's post spends before it may wake an agent here (DOR-2955). A teammate is
 * anyone in the space but this install's owner.
 *
 * A teammate wakes an agent at most three times per person and twenty times per channel every ten
 * minutes ({@link ANSWER_IN_LIMITS}), mention and answer-in alike, from ONE budget: the space's
 * answer-in budget, or this one for a gate that keeps none. Past it the post stays history. Without
 * one, any member could spend the owner's model allowance as fast as they could type.
 *
 * The owner's own posts are not held to it, exactly as before.
 *
 * @module services/communities/remote/wake/teammate-wakes
 */
import { AnswerInBudget, ANSWER_IN_LIMITS } from './answer-in.js';

/** The teammate budget one bridge applies. */
export class TeammateWakes {
  private readonly budget: AnswerInBudget;

  /**
   * Start with nothing spent.
   *
   * @param now - The clock, shared with the bridge.
   */
  constructor(now: () => number) {
    this.budget = new AnswerInBudget(ANSWER_IN_LIMITS, now);
  }

  /**
   * Spend one wake from this bridge's budget, for a gate that keeps none of its own. The caller
   * logs a refusal; this only answers.
   *
   * @param connection - The owner-qualified connection key.
   * @param remoteRoomId - The channel, by its id in the space.
   * @param authorMemberId - The poster, by member id in the space.
   */
  take(connection: string, remoteRoomId: string, authorMemberId: string): boolean {
    return this.budget.take(connection, remoteRoomId, authorMemberId);
  }
}
