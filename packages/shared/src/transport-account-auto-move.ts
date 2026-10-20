/**
 * Keeping room agents off a Claude account when DorkOS moves them on its own
 * (Re-seat P0), as the client reaches it. A slice of the `Transport`
 * (`transport-slices.ts`).
 *
 * @module shared/transport-account-auto-move
 */
import type { NoAutoMove } from './project-schemas.js';

/** Turn an account's automatic moves off or on. */
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
}
