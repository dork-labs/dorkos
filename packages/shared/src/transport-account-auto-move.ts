/**
 * Keeping room agents off a Claude account when DorkOS moves them on its own
 * (Re-seat P0), and letting agents pick one by name (DOR-5033), as the client
 * reaches them. A slice of the `Transport` (`transport-slices.ts`).
 *
 * @module shared/transport-account-auto-move
 */
import type { AgentsMayPick, NoAutoMove } from './project-schemas.js';

/** Turn an account's automatic moves off or on, and whether agents may pick it. */
export interface AccountAutoMoveTransport {
  /**
   * Keep room agents off a registered Claude account in automatic moves, or
   * let them back (`PUT /api/runtimes/claude-code/accounts/:id/no-auto-move`).
   * Only a person may; rejects with the server's `message` and `status`.
   *
   * @param accountId - A registry id. Main (`default`) has no row and answers 404.
   * @param noAutoMove - `true` to keep agents off it, `false` to allow them.
   */
  setAccountNoAutoMove(accountId: string, noAutoMove: boolean): Promise<NoAutoMove>;

  /**
   * Let agents start chats on a registered Claude account by naming it, or
   * refuse them, while no mini app such as Flow decides (DOR-5033;
   * `PUT /api/runtimes/claude-code/accounts/:id/agents-may-pick`). Only a
   * person may; rejects with the server's `message` and `status`.
   *
   * @param accountId - A registry id. Main (`default`) has no row and answers 404.
   * @param agentsMayPick - `true` to let agents pick it, `false` to refuse them.
   */
  setAccountAgentsMayPick(accountId: string, agentsMayPick: boolean): Promise<AgentsMayPick>;
}
