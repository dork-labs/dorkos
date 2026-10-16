/**
 * What the space stream bridge holds a teammate's post to before it may wake an agent here
 * (DOR-2955). A teammate is anyone in the space but this install's owner.
 *
 * Two limits, both on the side of the owner's computer:
 *
 * - **A budget.** A mention by a teammate wakes an agent at most three times per person and
 *   twenty times per channel every ten minutes ({@link ANSWER_IN_LIMITS}, the same numbers
 *   answer-in channels already use). Past it the post stays history. Without one, any member could
 *   spend the owner's model allowance as fast as they could type.
 * - **A runtime that can hold the turn.** A teammate's turn runs with nobody to ask, read-only and
 *   fenced to its room (`rooms/limits/teammate-turn.ts`); only some runtimes honour all of that,
 *   so an agent on any other keeps a teammate's post as history.
 *
 * The owner's own posts are held to neither, exactly as before.
 *
 * @module services/communities/remote/wake/teammate-wakes
 */
import { logRefusal } from '../../../observability/refusals.js';
import { AnswerInBudget, ANSWER_IN_LIMITS } from './answer-in.js';

/** Answers whether an enrolled local agent runs where a teammate's turn can be held to its limits. */
export type TeammateRuntimeCheck = (localAgentId: string) => boolean;

/** The teammate budget and runtime check one bridge applies. */
export class TeammateWakes {
  private readonly budget: AnswerInBudget;
  private runsTeammateTurns: TeammateRuntimeCheck = () => false;

  /**
   * Start with nothing spent and no agent able to take a teammate's turn until
   * {@link useRuntimeCheck} says which can: a bridge nobody told keeps every teammate's post as
   * history, never the other way round.
   *
   * @param now - The clock, shared with the bridge.
   */
  constructor(now: () => number) {
    this.budget = new AnswerInBudget(ANSWER_IN_LIMITS, now);
  }

  /**
   * Say which enrolled agents may take a teammate's turn. Set once at boot.
   *
   * @param check - Answers for one enrolled agent by its local manifest id.
   */
  useRuntimeCheck(check: TeammateRuntimeCheck): void {
    this.runsTeammateTurns = check;
  }

  /**
   * Whether this enrolled agent may take a teammate's turn; logs the post kept as history when not.
   *
   * @param localAgentId - The enrolled agent's local manifest id.
   * @param entryId - The space post, for the log line.
   */
  canAnswer(localAgentId: string, entryId: string): boolean {
    if (this.runsTeammateTurns(localAgentId)) return true;
    logRefusal('[RemoteRoomSubscriptionBridge] a teammate’s post kept as history', {
      reason: 'teammate_wake_held',
      visibility: 'silent',
      entryId,
      detail: { why: 'runtime', localAgentId },
    });
    return false;
  }

  /**
   * Spend one teammate wake, or refuse and log once the author's or the channel's share is spent.
   *
   * @param connection - The owner-qualified connection key.
   * @param remoteRoomId - The channel, by its id in the space.
   * @param authorMemberId - The teammate, by member id in the space.
   * @param entryId - The space post, for the log line.
   */
  take(connection: string, remoteRoomId: string, authorMemberId: string, entryId: string): boolean {
    if (this.budget.take(connection, remoteRoomId, authorMemberId)) return true;
    logRefusal('[RemoteRoomSubscriptionBridge] a teammate’s post kept as history', {
      reason: 'teammate_wake_held',
      visibility: 'silent',
      entryId,
      detail: { why: 'budget' },
    });
    return false;
  }
}
